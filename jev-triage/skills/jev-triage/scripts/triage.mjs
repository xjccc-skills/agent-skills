/**
 * Narrowing and its economics.
 *
 * The point of this skill is to keep a large candidate set OUT of the expensive
 * model's context: build candidates in code, let Jev pick among them, and let
 * only the selected minimum through. That is only a saving under conditions this
 * module checks rather than assumes.
 *
 * Nothing here knows where candidates came from. Sources live in `adapters/`.
 */

import { choice, score, noul, confidenceOf, CHOICE_MAX_OPTIONS } from "./jev.mjs";

export { choice, score, noul, CHOICE_MAX_OPTIONS };

// ---------------------------------------------------------------------------
// Token accounting
// ---------------------------------------------------------------------------

/**
 * Rough token count. CJK runs about one token per character; Latin text about
 * four characters per token. Good to roughly ±30%, which is enough for a
 * go/no-go decision and not enough for billing.
 */
export function estimateTokens(text) {
  const s = String(text ?? "");
  let cjk = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x3040 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x20000 && cp <= 0x2fa1f)) cjk++;
  }
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

/**
 * Per-candidate overhead in a Choice call: the id appears in the state, again as
 * a criteria label, again in the returned probabilities, plus JSON punctuation.
 *
 * Calibrated against a measured run: 300 short candidates cost 11,392 input and
 * 2,942 output tokens, whose text alone estimates at ~1,650 input tokens.
 */
const INPUT_OVERHEAD_PER_CANDIDATE = 32;
const OUTPUT_PER_CANDIDATE = 10;

/** What one narrowing pass over these candidates will cost on the Jev side. */
export function estimateJevCost(candidates) {
  const textTokens = candidates.reduce((n, c) => n + estimateTokens(c.text), 0);
  const chunks = Math.max(1, Math.ceil(candidates.length / (CHOICE_MAX_OPTIONS - 1)));
  const input = textTokens + candidates.length * INPUT_OVERHEAD_PER_CANDIDATE;
  const output = candidates.length * OUTPUT_PER_CANDIDATE;
  return { input, output, total: input + output, chunks };
}

/**
 * Decide whether narrowing with Jev is worth it at all.
 *
 * It is not, in two common cases, and both are easy to walk into:
 *   - too few candidates: the round trip costs more than reading them all;
 *   - candidates that ARE the payload: if you must send the full text to judge
 *     it, nothing was avoided — the cost just moved to a different bill.
 *
 * Candidates must be POINTERS (headings, paths, signatures, ids), not content.
 *
 * @param {object}   args
 * @param {Array}    args.candidates        built candidates
 * @param {number}   args.fullPayloadChars  characters that would otherwise enter the model's context
 * @param {number}  [args.minCandidates=30]
 * @param {number}  [args.minRatio=3]       required avoided/spent ratio
 */
export function jevPaysOff({ candidates, fullPayloadChars, minCandidates = 30, minRatio = 3 }) {
  const cost = estimateJevCost(candidates);
  const digestTokens = candidates.reduce((n, c) => n + estimateTokens(c.text), 0);
  const fullTokens = Math.ceil(Number(fullPayloadChars || 0) / 4) || 0;
  const avoided = Math.max(0, fullTokens - digestTokens);
  const ratio = cost.total ? +(avoided / cost.total).toFixed(1) : 0;

  let reason;
  if (candidates.length < minCandidates) {
    reason = `only ${candidates.length} candidates — reading them all is cheaper than a round trip`;
  } else if (ratio < minRatio) {
    reason = `the candidate digest is already ${Math.round((digestTokens / Math.max(fullTokens, 1)) * 100)}% of the full payload — narrowing saves little; use shorter pointers`;
  } else {
    reason = `narrowing should avoid about ${avoided} tokens for ${cost.total} spent (${ratio}x)`;
  }

  return {
    worth: candidates.length >= minCandidates && ratio >= minRatio,
    candidates: candidates.length,
    spend: cost.total,
    avoided,
    ratio,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/**
 * Turn records into stable candidates.
 *
 * Removes blanks and exact duplicates, and nothing else — source-specific noise
 * filtering belongs in the adapter that produced the records.
 *
 * It deliberately does NOT trim genuine candidates to a heuristic shortlist:
 * choosing among real candidates is the judgment being delegated, and options
 * cost only a few tokens each. Shortlisting first performs that judgment
 * yourself, badly, and leaves no trace that you did.
 *
 * @param {Array<{text:string, key?:string, [k:string]:any}>} records
 */
export function buildCandidates(records, { meta = {}, prefix = "c" } = {}) {
  const seen = new Set();
  const out = [];
  for (const rec of records ?? []) {
    const text = String(rec.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const dedupeKey = rec.key ?? `${text}\u0000${rec.href ?? rec.path ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const { text: _t, key: _k, ...rest } = rec;
    out.push({ id: `${prefix}${out.length + 1}`, text, ...meta, ...rest, raw: rec });
  }
  return out;
}

/**
 * Drop records whose text is wholly contained in another record's text.
 *
 * Tree-shaped sources (a DOM, an AST, a nested document) emit a parent and each
 * of its children, so the same sentence arrives several times. Deduplicating by
 * equality does not catch it; deduplicating by containment does, and it is
 * usually a 2–3x cut in what reaches the model.
 */
export function dedupeByContainment(records) {
  const kept = [];
  for (const r of [...(records ?? [])].sort((a, b) => String(b.text).length - String(a.text).length)) {
    const t = String(r.text ?? "").trim();
    if (!t) continue;
    if (!kept.some((k) => String(k.text).includes(t))) kept.push(r);
  }
  return kept;
}

/** Return the ORIGINAL record for a selected id. Jev selects; code copies. */
export function copyVerbatim(candidates, id) {
  const hit = candidates.find((c) => c.id === id);
  return hit ? hit.raw : null;
}

const forState = (candidates) => candidates.map(({ raw, ...rest }) => rest);

/**
 * Select one candidate, chunking past the 255-option ceiling.
 *
 * Candidate ids describe themselves, so criteria descriptions are `null` —
 * allowed, and it saves tokens on large sets. An explicit `none` option always
 * lets the model decline. Chunks are asked in one batched call; their winners
 * run off against each other. Never truncates; returns `id: null` when every
 * chunk declines.
 */
export async function selectCandidate(client, { instructions, candidates, query, meta = {}, model }) {
  if (!candidates?.length) {
    return { id: null, confidence: 1, model: model ?? "n/a", usage: { input_tokens: 0, output_tokens: 0 }, candidate: null, rounds: 0 };
  }

  const perChunk = CHOICE_MAX_OPTIONS - 1;
  const chunk = (arr) => {
    const out = [];
    for (let i = 0; i < arr.length; i += perChunk) out.push(arr.slice(i, i + perChunk));
    return out;
  };

  const usage = { input_tokens: 0, output_tokens: 0 };
  let pool = chunk(candidates);
  let round = 0;
  let lastModel = model ?? "";

  for (;;) {
    round += 1;
    const questions = {};
    pool.forEach((group, i) => {
      const criteria = Object.fromEntries(group.map((c) => [c.id, null]));
      criteria.none = "No candidate in this group answers the query";
      questions[`g${i}`] = choice(instructions, criteria);
    });
    const state = {
      query, ...meta,
      groups: pool.map((group, i) => ({ group: `g${i}`, candidates: forState(group) })),
    };

    const res = await client.systemOne({ state, questions, ...(model ? { model } : {}) });
    usage.input_tokens += res.usage?.input_tokens ?? 0;
    usage.output_tokens += res.usage?.output_tokens ?? 0;
    lastModel = res.model;

    const winners = [];
    pool.forEach((group, i) => {
      const ans = res.answers[`g${i}`];
      if (!ans || ans.choice === "none") return;
      const hit = group.find((c) => c.id === ans.choice);
      if (hit) winners.push({ candidate: hit, confidence: ans.confidence });
    });

    if (winners.length === 0) {
      return { id: null, confidence: 1, model: lastModel, usage, candidate: null, rounds: round };
    }
    if (pool.length === 1 || winners.length === 1) {
      const best = winners.reduce((a, b) => (b.confidence > a.confidence ? b : a));
      return { id: best.candidate.id, confidence: best.confidence, model: lastModel, usage, candidate: best.candidate, rounds: round };
    }
    pool = chunk(winners.map((w) => w.candidate));
  }
}

/**
 * Rank candidates instead of picking one: returns the top K by Choice
 * probability from a single pass, which is what you want when the answer is
 * "these three files", not "this one row".
 */
export async function rankCandidates(client, { instructions, candidates, query, meta = {}, topK = 3, model }) {
  if (!candidates?.length) return { top: [], usage: { input_tokens: 0, output_tokens: 0 }, model: model ?? "n/a" };
  if (candidates.length > CHOICE_MAX_OPTIONS - 1) {
    throw new TypeError(`rankCandidates takes at most ${CHOICE_MAX_OPTIONS - 1} candidates; narrow with selectCandidate() first`);
  }
  const criteria = Object.fromEntries(candidates.map((c) => [c.id, null]));
  criteria.none = "No candidate answers the query";
  const res = await client.systemOne({
    state: { query, ...meta, candidates: forState(candidates) },
    questions: { pick: choice(instructions, criteria) },
    ...(model ? { model } : {}),
  });
  const probs = res.answers.pick.probabilities ?? {};
  const top = Object.entries(probs)
    .filter(([label]) => label !== "none")
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id, p]) => ({ id, probability: p, candidate: candidates.find((c) => c.id === id) ?? null }));
  return { top, none: probs.none ?? 0, confidence: res.answers.pick.confidence, usage: res.usage, model: res.model };
}

/**
 * The two-stage shape, which is where the saving compounds.
 *
 *   stage 1  narrow over cheap pointers (titles, paths, signatures)
 *   fetch    pull the full payload for the winner only
 *   stage 2  optionally narrow again inside that payload
 *
 * Skipping stage 1 and handing everything to the model is the thing this skill
 * exists to avoid; skipping stage 2 is fine when the winner's payload is small.
 *
 * @param {object}   args
 * @param {Array}    args.coarse            pointer candidates
 * @param {string}   args.instructions      stage-1 question
 * @param {function} args.fetchFull         async (candidate) => string
 * @param {function} [args.split]           (fullText, candidate) => records for stage 2
 * @param {string}   [args.fineInstructions] stage-2 question, required with `split`
 */
export async function refine(client, {
  coarse, instructions, query, meta = {}, fetchFull, split, fineInstructions, model,
}) {
  const usage = { input_tokens: 0, output_tokens: 0 };
  const add = (u) => { usage.input_tokens += u?.input_tokens ?? 0; usage.output_tokens += u?.output_tokens ?? 0; };

  const stage1 = await selectCandidate(client, { instructions, candidates: coarse, query, meta, model });
  add(stage1.usage);
  if (!stage1.id) return { stage1, stage2: null, selected: null, fullChars: 0, usage };

  const fullText = fetchFull ? await fetchFull(stage1.candidate) : (stage1.candidate.text ?? "");
  const fullChars = String(fullText).length;

  if (!split) {
    return { stage1, stage2: null, selected: stage1.candidate, full: fullText, fullChars, usage };
  }
  if (!fineInstructions) throw new TypeError("refine(): `split` requires `fineInstructions`");

  const fine = buildCandidates(dedupeByContainment(split(fullText, stage1.candidate)), { prefix: "f" });
  const stage2 = await selectCandidate(client, { instructions: fineInstructions, candidates: fine, query, meta, model });
  add(stage2.usage);

  return {
    stage1, stage2,
    selected: stage2.candidate ?? stage1.candidate,
    full: fullText, fullChars, fineCandidates: fine, usage,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * The provenance record. A skill that claims to save tokens has to say how many,
 * or the claim is unverifiable — so `savings` is not optional decoration.
 *
 * Read the ratio as the skill's own pass/fail: if it sits below ~3 across real
 * runs, the skill is being used where it does not belong.
 */
export function provenance({
  source, scope, model, selected, verified, confidence,
  usage, fullPayloadChars, digestChars, notes = [],
}) {
  const spent = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
  const fullTokens = Math.ceil(Number(fullPayloadChars || 0) / 4) || 0;
  const digestTokens = Math.ceil(Number(digestChars || 0) / 4) || 0;
  const avoided = Math.max(0, fullTokens - digestTokens);
  return {
    source: source ?? null,
    retrievalScope: scope ?? null,
    jev: {
      model: model ?? null,
      selected: Boolean(selected),
      verified: verified ?? null,
      confidence: confidence ?? null,
    },
    savings: {
      tokensSpent: spent,
      tokensAvoided: avoided,
      ratio: spent ? +(avoided / spent).toFixed(1) : null,
      verdict: !spent ? "not used" : avoided / spent >= 3 ? "worthwhile" : "marginal — check whether this set was big enough",
    },
    ...(notes.length ? { notes } : {}),
  };
}

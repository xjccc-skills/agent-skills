/**
 * Zero-dependency TypeSafe/Jev client plus the candidate and routing helpers
 * the retrieval pipeline needs.
 *
 * No npm install. Node 20+ and the standard library only. `undici` is used if
 * it happens to be present, but is never required.
 *
 * Wire format verified against @typesafe-ai/sdk 0.6.0 and the live API
 * (model jev-1.13.0): POST {baseURL}/v1/systemone with a Bearer key and a
 * {state, questions, model} body.
 */

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
const RETRY_STATUSES = new Set([408, 429]);

/** A Choice question accepts at most 255 options, `none` included. */
export const CHOICE_MAX_OPTIONS = 255;

// ---------------------------------------------------------------------------
// Question primitives
// ---------------------------------------------------------------------------

/** Pick one option from a fixed list. `criteria` maps label -> description|null. */
export function choice(instructions, criteria) {
  if (Array.isArray(criteria)) {
    throw new TypeError("choice criteria must be a map of labels to descriptions, not a list");
  }
  const labels = Object.keys(criteria ?? {});
  if (labels.length < 2) throw new TypeError("choice needs at least two options");
  if (labels.length > CHOICE_MAX_OPTIONS) {
    throw new TypeError(
      `choice accepts at most ${CHOICE_MAX_OPTIONS} options, got ${labels.length}; use selectCandidate() to chunk`,
    );
  }
  return { type: "choice", instructions, criteria };
}

/** Rate along ordered levels. `criteria` is an array of >=2 descriptions, indexed from 0. */
export function score(instructions, criteria) {
  if (!Array.isArray(criteria)) {
    throw new TypeError("score criteria must be a list of descriptions indexed from zero, not a map");
  }
  if (criteria.length < 2) throw new TypeError("score needs at least two levels");
  return { type: "score", instructions, criteria };
}

/** Judge a yes/no statement. Returns a probability, NOT a confidence. */
export function noul(instructions = null, criteria) {
  return { type: "noul", instructions, ...(criteria === undefined ? {} : { criteria }) };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export class TypeSafeHTTPError extends Error {
  constructor(status, body, requestId) {
    super(`TypeSafe request failed with ${status}`);
    this.name = "TypeSafeHTTPError";
    this.status = status;
    this.body = body;
    this.requestId = requestId;
  }
}

/**
 * Node's *global* fetch ignores HTTPS_PROXY and rejects a `dispatcher` in
 * RequestInit. Behind an egress proxy the request therefore goes out directly
 * and is refused with `403 Host not in allowlist`, which reads like a missing
 * allowlist entry even when the host is allowed.
 *
 * Resolution order, all optional:
 *   1. No HTTPS_PROXY            -> global fetch.
 *   2. NODE_USE_ENV_PROXY=1      -> global fetch already honors the proxy (Node 22+).
 *   3. undici present            -> ProxyAgent, if the caller happens to have it.
 *   4. Otherwise                 -> global fetch; explainApiError() names the cause.
 */
async function resolveFetch() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy) return { impl: fetch, via: "global" };
  if (process.env.NODE_USE_ENV_PROXY === "1") return { impl: fetch, via: "env-proxy" };
  try {
    const undici = await import("undici");
    const agent = new undici.ProxyAgent(proxy);
    return {
      impl: (url, init = {}) => undici.fetch(url, { ...init, dispatcher: agent }),
      via: "undici",
    };
  } catch {
    return { impl: fetch, via: "global-unproxied" };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function retryDelay(attempt, headers) {
  const ms = Number(headers?.get?.("retry-after-ms"));
  if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, 60000);
  const secs = Number(headers?.get?.("retry-after"));
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60000);
  const base = Math.min(500 * 2 ** attempt, 5000);
  return base * (1 - Math.random() * 0.25);
}

/**
 * @param {object} [config]
 * @param {string} [config.apiKey]   defaults to TYPESAFE_API_KEY
 * @param {string} [config.baseURL]  defaults to TYPESAFE_BASE_URL, then the public API
 * @param {string} [config.model]    defaults to TYPESAFE_DEFAULT_MODEL, then jev-latest
 * @param {number} [config.timeout]  ms per attempt, default 10000
 * @param {number} [config.maxRetries] default 2
 */
export async function createClient(config = {}) {
  const apiKey = config.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    throw new Error("No API key: pass { apiKey } or set TYPESAFE_API_KEY in the environment.");
  }
  const baseURL = (config.baseURL ?? process.env.TYPESAFE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const defaultModel = config.model ?? process.env.TYPESAFE_DEFAULT_MODEL ?? DEFAULT_MODEL;
  const timeout = config.timeout ?? 10000;
  const maxRetries = config.maxRetries ?? 2;
  const { impl: doFetch, via } = await resolveFetch();

  async function systemOne({ state, questions, model }) {
    if (!questions || Object.keys(questions).length === 0) {
      throw new TypeError("systemOne needs at least one question");
    }
    const body = JSON.stringify({ state, questions, model: model ?? defaultModel });

    for (let attempt = 0; ; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeout);
      let res;
      try {
        res = await doFetch(`${baseURL}/v1/systemone`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(attempt ? { "X-TypeSafe-Retry-Count": String(attempt) } : {}),
          },
          body,
          signal: ac.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (attempt < maxRetries) {
          await sleep(retryDelay(attempt));
          continue;
        }
        throw err;
      }
      clearTimeout(timer);

      if (res.ok) return res.json();

      const text = await res.text().catch(() => "");
      const retryable = RETRY_STATUSES.has(res.status) || res.status >= 500;
      if (retryable && attempt < maxRetries) {
        await sleep(retryDelay(attempt, res.headers));
        continue;
      }
      throw new TypeSafeHTTPError(res.status, text, res.headers?.get?.("x-typesafe-request-id"));
    }
  }

  return { systemOne, transport: via, baseURL, defaultModel };
}

/** Turn an error into a message that names the real cause. */
export function explainApiError(err) {
  const status = err?.status;
  const body = typeof err?.body === "string" ? err.body : "";

  if (status === 403 && /not in allowlist/i.test(body)) {
    return (
      "Blocked by a network egress policy, not by TypeSafe. Either api.typesafe.ai " +
      "is missing from the allowlist, or the request bypassed the CONNECT proxy — " +
      "Node's global fetch ignores HTTPS_PROXY. Re-run with NODE_USE_ENV_PROXY=1 " +
      "(Node 22+), or `npm i undici` so this module can route through it. If the " +
      "host is genuinely blocked, report it rather than routing around it."
    );
  }
  if (status === 401) return "TypeSafe rejected the API key (check TYPESAFE_API_KEY).";
  if (status === 403) return "TypeSafe refused the request: " + (body || "no body");
  if (status === 429) return "TypeSafe rate limit; retries are already exhausted.";
  if (err?.name === "AbortError" || err?.name === "TimeoutError") {
    return "TypeSafe request timed out; raise `timeout` or shrink the candidate set.";
  }
  return `${err?.name ?? "Error"}: ${err?.message ?? String(err)}`;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

const BOILERPLATE = /^(home|menu|skip to (main )?content|cookie|accept all|sign ?in|log ?in|subscribe|share|next|previous|back to top|©|\d+)$/i;

/**
 * Convert raw page records into stable candidates.
 *
 * Removes navigation, boilerplate and exact duplicates — and nothing else. It
 * does NOT trim genuine candidates to a heuristic shortlist: choosing among
 * real candidates is the judgment Jev is for, and options cost only a few
 * tokens each.
 */
export function buildCandidates(records, { pageUrl, keepBoilerplate = false } = {}) {
  const seen = new Set();
  const out = [];
  for (const rec of records) {
    const text = String(rec.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (!keepBoilerplate && BOILERPLATE.test(text)) continue;
    const key = `${text}\u0000${rec.href ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `c${out.length + 1}`,
      text,
      ...(rec.href ? { href: rec.href } : {}),
      ...(rec.context ? { context: rec.context } : {}),
      ...(pageUrl ? { pageUrl } : {}),
      raw: rec,
    });
  }
  return out;
}

const forState = (candidates) => candidates.map(({ raw, ...rest }) => rest);

/**
 * Select one candidate, chunking past the 255-option ceiling.
 *
 * Candidate ids describe themselves, so criteria are `null` — allowed, and it
 * saves tokens on large sets. An explicit `none` option always lets the model
 * decline. Chunks are asked in one batched call; their winners run off against
 * each other. Never truncates.
 */
export async function selectCandidate(client, { instructions, candidates, query, pageUrl, pageTitle, model }) {
  if (candidates.length === 0) {
    return { id: null, confidence: 1, model: model ?? "n/a", usage: {}, candidate: null, rounds: 0 };
  }

  const perChunk = CHOICE_MAX_OPTIONS - 1;
  const chunk = (arr) => {
    const out = [];
    for (let i = 0; i < arr.length; i += perChunk) out.push(arr.slice(i, i + perChunk));
    return out;
  };

  const meta = { query, pageUrl, pageTitle };
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
      ...meta,
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
      return {
        id: best.candidate.id,
        confidence: best.confidence,
        model: lastModel,
        usage,
        candidate: best.candidate,
        rounds: round,
      };
    }
    pool = chunk(winners.map((w) => w.candidate));
  }
}

// ---------------------------------------------------------------------------
// Confidence routing
// ---------------------------------------------------------------------------

/**
 * Normalize any answer to a 0..1 certainty.
 *
 * Choice and Score report `confidence`. **Noul does not** — its response is
 * `{ type, noul }`, so its certainty is how far the probability sits from 0.5.
 * Reading `.confidence` on a Noul silently yields `undefined`; this function
 * exists to stop that.
 */
export function confidenceOf(answer) {
  if (!answer || typeof answer !== "object") return 0;
  if (answer.type === "noul") return Math.abs(answer.noul - 0.5) * 2;
  return typeof answer.confidence === "number" ? answer.confidence : 0;
}

/** True when a Noul reads as yes, false as no, `null` inside the uncertain band. */
export function noulSaysYes(answer, band = 0.15) {
  const p = answer?.noul;
  if (typeof p !== "number") return null;
  if (p >= 0.5 + band) return true;
  if (p <= 0.5 - band) return false;
  return null;
}

/** Decide: "return", "escalate" (one bounded browser action), or "none". */
export function route(answers, { min = 0.7, verifier } = {}) {
  const weak = Object.entries(answers)
    .filter(([, a]) => confidenceOf(a) < min)
    .map(([k]) => k);

  if (verifier && noulSaysYes(answers[verifier]) === false) {
    return { action: "none", reason: `verifier '${verifier}' says the evidence does not answer the query` };
  }
  if (weak.length) return { action: "escalate", reason: `low confidence on: ${weak.join(", ")}`, weak };
  return { action: "return", reason: "all answers above threshold" };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** Return the ORIGINAL record for a selected id. Jev selects; code copies. */
export function copyVerbatim(candidates, id) {
  const hit = candidates.find((c) => c.id === id);
  return hit ? hit.raw : null;
}

/** The provenance block the result contract requires. */
export function provenance({ pageUrl, pageTitle, scope, model, selected, verified, confidence, notes = [] }) {
  return {
    finalUrl: pageUrl,
    pageTitle,
    retrievalScope: scope,
    jev: {
      model: model ?? null,
      selected: Boolean(selected),
      verified: verified ?? null,
      confidence: confidence ?? null,
    },
    ...(notes.length ? { notes } : {}),
  };
}

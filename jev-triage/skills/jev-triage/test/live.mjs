/**
 * Live tests. Needs TYPESAFE_API_KEY and network; spends a few thousand tokens.
 *   node test/live.mjs
 *
 * Behind an egress proxy, run with NODE_USE_ENV_PROXY=1 (Node 22+) or install
 * undici. The failure message says which.
 */
import { createClient, choice, score, noul, explainApiError } from "../scripts/jev.mjs";
import {
  buildCandidates, selectCandidate, rankCandidates, refine, copyVerbatim,
  jevPaysOff, provenance,
} from "../scripts/triage.mjs";

let fails = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};

if (!process.env.TYPESAFE_API_KEY) {
  console.log("SKIP  TYPESAFE_API_KEY is not set — live tests skipped.");
  process.exit(0);
}

const client = await createClient();
console.log(`[transport: ${client.transport}  base: ${client.baseURL}  model: ${client.defaultModel}]\n`);

try {
  // --- the three primitives, batched -----------------------------------------
  const rows = buildCandidates([
    { text: "Starter — $0/mo — 1 seat" },
    { text: "Pro — $29/mo — 5 seats" },
    { text: "All prices exclude VAT" },
  ]);
  const res = await client.systemOne({
    state: { query: "Pro plan monthly price", candidates: rows.map(({ raw, ...r }) => r) },
    questions: {
      pick: choice("Which candidate id states the Pro plan's monthly price?",
        { c1: null, c2: null, c3: null, none: "No candidate answers the query" }),
      specificity: score("How directly the selected candidate answers the query",
        ["Unrelated", "Related but does not state the price", "States the price exactly"]),
      answered: noul("The candidate set contains enough evidence to answer the query"),
    },
  });
  ok("a model version is echoed", typeof res.model === "string" && res.model.startsWith("jev-"), res.model);
  ok("choice selects the Pro row", res.answers.pick.choice === "c2", JSON.stringify(res.answers.pick));
  ok("score returns a number and a legend",
     typeof res.answers.specificity.score === "number" && typeof res.answers.specificity.legend === "object",
     `score=${res.answers.specificity.score}`);
  ok("NOUL HAS NO confidence FIELD (the documented trap)",
     !("confidence" in res.answers.answered), JSON.stringify(res.answers.answered));
  ok("verbatim copy matches the source record",
     copyVerbatim(rows, res.answers.pick.choice).text === "Pro — $29/mo — 5 seats");

  // --- chunking past the 255-option ceiling ---------------------------------
  const many = buildCandidates([
    ...Array.from({ length: 149 }, (_, i) => ({ text: `Widget ${i} — in stock` })),
    { text: "Flux capacitor — discontinued since 1985" },
    ...Array.from({ length: 150 }, (_, i) => ({ text: `Gadget ${i} — in stock` })),
  ]);
  ok("fixture has 300 candidates", many.length === 300, `got ${many.length}`);

  const gate = jevPaysOff({ candidates: many, fullPayloadChars: 900000 });
  ok("the gate approves this set before we spend on it", gate.worth === true, gate.reason);

  const hit = await selectCandidate(client, {
    instructions: "Which candidate id names a discontinued product?",
    candidates: many, query: "discontinued product",
  });
  ok("chunked selection finds it across 300 options",
     /Flux capacitor/.test(copyVerbatim(many, hit.id)?.text ?? ""),
     `id=${hit.id} conf=${hit.confidence} rounds=${hit.rounds} usage=${JSON.stringify(hit.usage)}`);

  // the estimate that gate.spend was based on should be in the right ballpark
  const actual = hit.usage.input_tokens + hit.usage.output_tokens;
  ok("estimated spend lands within 40% of actual",
     Math.abs(gate.spend - actual) / actual < 0.4, `estimated ${gate.spend} vs actual ${actual}`);

  // --- ranking ---------------------------------------------------------------
  const files = buildCandidates([
    { text: "src/promotion/rules.ts" }, { text: "src/promotion/dashboard.tsx" },
    { text: "src/driver/search.ts" }, { text: "src/billing/invoice.ts" },
    { text: "docs/CHANGELOG.md" },
  ]);
  const ranked = await rankCandidates(client, {
    instructions: "Which files most likely implement driver promotion eligibility rules?",
    candidates: files, query: "driver promotion eligibility", topK: 2,
  });
  ok("rankCandidates returns topK ordered", ranked.top.length === 2, JSON.stringify(ranked.top.map((t) => t.id)));
  ok("the rules file ranks first",
     ranked.top[0].candidate?.text === "src/promotion/rules.ts",
     `first=${ranked.top[0].candidate?.text} p=${ranked.top[0].probability}`);

  // --- two-stage refine ------------------------------------------------------
  // Coarse candidates must be pointers that CARRY SIGNAL. A bare filename does
  // not: "which doc explains refunds" is a coin flip between pricing and legal,
  // and the skill's own rule says such a pointer will not pay. A path plus its
  // headings is the realistic shape, and it is what an outline or a signature
  // scan actually gives you.
  const DOCS = {
    "guide/pricing.md": "## Plans\nStarter is free.\n## Billing\nInvoices are issued monthly.\n## Refunds\nRefunds are processed within 14 days.",
    "guide/install.md": "## Requirements\nNode 20+.\n## Setup\nRun npm install.",
    "guide/legal.md": "## Terms\nStandard terms apply.\n## Privacy\nWe store minimal data.",
  };
  const headings = (t) => (t.match(/^## .+$/gm) ?? []).join(" · ").replace(/## /g, "");
  const coarse = buildCandidates(
    Object.entries(DOCS).map(([p, body]) => ({ text: `${p} — ${headings(body)}`, path: p })));
  const r = await refine(client, {
    coarse,
    instructions: "Which document id would explain how long a refund takes?",
    query: "refund processing time",
    fetchFull: (c) => DOCS[c.path],
    split: (text) => text.split(/\n(?=## )/).map((t) => ({ text: t.trim() })),
    fineInstructions: "Which section states the refund processing time?",
  });
  ok("refine picks the right document in stage 1", r.stage1.candidate?.path === "guide/pricing.md",
     `stage1=${r.stage1.candidate?.path} conf=${r.stage1.confidence}`);
  ok("refine narrows to the right section in stage 2",
     /Refunds/.test(r.stage2?.candidate?.text ?? ""), `stage2=${r.stage2?.candidate?.text?.slice(0, 40)}`);
  ok("refine reports combined usage", r.usage.input_tokens > 0, JSON.stringify(r.usage));
  ok("refine reports how big the fetched payload was", r.fullChars > 0, `fullChars=${r.fullChars}`);

  // the same question over signal-free pointers should be visibly less certain
  const bare = buildCandidates(Object.keys(DOCS).map((p) => ({ text: p, path: p })));
  const bareRes = await selectCandidate(client, {
    instructions: "Which document id would explain how long a refund takes?",
    candidates: bare, query: "refund processing time",
  });
  ok("signal-free pointers are less certain than heading-bearing ones",
     bareRes.confidence <= r.stage1.confidence,
     `bare=${bareRes.confidence} vs withHeadings=${r.stage1.confidence}`);

  // --- declines rather than guessing ----------------------------------------
  const nothing = await selectCandidate(client, {
    instructions: "Which candidate id gives a shipping address in Antarctica?",
    candidates: buildCandidates([{ text: "Blue mug, ceramic" }, { text: "Red mug, ceramic" }]),
    query: "Antarctic shipping address",
  });
  ok("declines rather than guessing when nothing fits", nothing.id === null, `id=${nothing.id}`);

  // --- the client tallies what it spent --------------------------------------
  ok("client.spent accumulates across calls", client.spent.calls >= 5 && client.spent.input_tokens > 0,
     JSON.stringify(client.spent));
  const prov = provenance({
    source: "test", scope: "fixtures", model: hit.model, selected: true, confidence: hit.confidence,
    usage: client.spent, fullPayloadChars: 900000, digestChars: 7000,
  });
  ok("provenance grades the run", typeof prov.savings.ratio === "number", JSON.stringify(prov.savings));
} catch (e) {
  console.log("LIVE FAILED ->", explainApiError(e));
  fails++;
}

console.log(fails === 0 ? "\nLIVE: ALL PASS" : `\nLIVE: ${fails} FAILED`);
process.exit(fails ? 1 : 0);

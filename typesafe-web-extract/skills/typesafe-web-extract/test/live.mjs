/**
 * Live tests. Needs TYPESAFE_API_KEY and network; spends a few thousand tokens.
 *   node test/live.mjs
 *
 * Behind an egress proxy, run with NODE_USE_ENV_PROXY=1 (Node 22+) or install
 * undici. The failure message says which.
 */
import {
  createClient, choice, score, noul, buildCandidates, selectCandidate,
  copyVerbatim, explainApiError,
} from "../scripts/typesafe-client.mjs";

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
  const rows = buildCandidates([
    { text: "Starter — $0/mo — 1 seat", context: "row" },
    { text: "Pro — $29/mo — 5 seats", context: "row" },
    { text: "All prices exclude VAT", context: "footnote" },
  ], { pageUrl: "https://example.test/pricing" });

  const res = await client.systemOne({
    state: {
      query: "Pro plan monthly price",
      pageUrl: "https://example.test/pricing",
      pageTitle: "Pricing",
      candidates: rows.map(({ raw, ...rest }) => rest),
    },
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
  ok("choice reports confidence and probabilities",
     typeof res.answers.pick.confidence === "number" && typeof res.answers.pick.probabilities === "object");
  ok("score returns a number and a legend",
     typeof res.answers.specificity.score === "number" && typeof res.answers.specificity.legend === "object",
     `score=${res.answers.specificity.score}`);
  ok("NOUL HAS NO confidence FIELD (the documented trap)",
     !("confidence" in res.answers.answered), JSON.stringify(res.answers.answered));
  ok("usage is reported", typeof res.usage?.input_tokens === "number", JSON.stringify(res.usage));
  ok("verbatim copy matches the DOM record",
     copyVerbatim(rows, res.answers.pick.choice).text === "Pro — $29/mo — 5 seats");

  // Past the 255-option ceiling.
  const many = buildCandidates([
    ...Array.from({ length: 149 }, (_, i) => ({ text: `Widget ${i} — in stock` })),
    { text: "Flux capacitor — discontinued since 1985" },
    ...Array.from({ length: 150 }, (_, i) => ({ text: `Gadget ${i} — in stock` })),
  ]);
  ok("fixture has 300 candidates", many.length === 300, `got ${many.length}`);

  const hit = await selectCandidate(client, {
    instructions: "Which candidate id names a discontinued product?",
    candidates: many, query: "discontinued product",
    pageUrl: "https://example.test/catalog", pageTitle: "Catalog",
  });
  ok("chunked selection finds it across 300 options",
     /Flux capacitor/.test(copyVerbatim(many, hit.id)?.text ?? ""),
     `id=${hit.id} conf=${hit.confidence} rounds=${hit.rounds} usage=${JSON.stringify(hit.usage)}`);

  // Nothing matches -> none, not a guess.
  const nothing = await selectCandidate(client, {
    instructions: "Which candidate id gives a shipping address in Antarctica?",
    candidates: buildCandidates([{ text: "Blue mug, ceramic" }, { text: "Red mug, ceramic" }]),
    query: "Antarctic shipping address",
  });
  ok("declines rather than guessing when nothing fits", nothing.id === null, `id=${nothing.id}`);
} catch (e) {
  console.log("LIVE FAILED ->", explainApiError(e));
  fails++;
}

console.log(fails === 0 ? "\nLIVE: ALL PASS" : `\nLIVE: ${fails} FAILED`);
process.exit(fails ? 1 : 0);

/**
 * Offline tests. No API key, no network, no dependencies — safe for CI.
 *   node test/offline.mjs
 */
import {
  createClient, choice, score, noul, confidenceOf, noulSaysYes, route,
  explainApiError, TypeSafeHTTPError, CHOICE_MAX_OPTIONS,
} from "../scripts/jev.mjs";
import {
  estimateTokens, estimateJevCost, jevPaysOff, buildCandidates,
  dedupeByContainment, copyVerbatim, provenance,
} from "../scripts/triage.mjs";
import { fromRipgrepJson, groupByFile } from "../scripts/adapters/grep.mjs";
import { fromPaths } from "../scripts/adapters/files.mjs";
import { fromPageBlocks, completeness, BOILERPLATE } from "../scripts/adapters/dom.mjs";

let fails = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

// --- primitives -------------------------------------------------------------
ok("choice rejects a list", throws(() => choice("q", ["a", "b"])));
ok("choice rejects fewer than two options", throws(() => choice("q", { a: null })));
ok("choice rejects more than 255 options",
   throws(() => choice("q", Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`c${i}`, null])))));
ok("choice accepts exactly 255", !throws(() =>
   choice("q", Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`c${i}`, null])))));
ok("score rejects a map", throws(() => score("q", { a: 1 })));
ok("score rejects fewer than two levels", throws(() => score("q", ["only"])));
ok("noul omits criteria when absent", !("criteria" in noul("q")));
ok("option ceiling is 255", CHOICE_MAX_OPTIONS === 255);

// --- certainty: the Noul trap ----------------------------------------------
ok("confidenceOf(noul 0.99) = 0.98", Math.abs(confidenceOf({ type: "noul", noul: 0.99 }) - 0.98) < 1e-9);
ok("confidenceOf(noul 0.5) = 0", confidenceOf({ type: "noul", noul: 0.5 }) === 0);
ok("confidenceOf(noul 0.01) = 0.98", Math.abs(confidenceOf({ type: "noul", noul: 0.01 }) - 0.98) < 1e-9);
ok("confidenceOf(choice) reads confidence", confidenceOf({ type: "choice", confidence: 0.83 }) === 0.83);
ok("confidenceOf(garbage) = 0", confidenceOf(undefined) === 0 && confidenceOf("x") === 0);
ok("noulSaysYes(0.9) true", noulSaysYes({ noul: 0.9 }) === true);
ok("noulSaysYes(0.1) false", noulSaysYes({ noul: 0.1 }) === false);
ok("noulSaysYes(0.55) null inside band", noulSaysYes({ noul: 0.55 }) === null);
ok("route returns when strong", route({ a: { type: "choice", confidence: 0.9 } }).action === "return");
ok("route escalates when weak", route({ a: { type: "choice", confidence: 0.4 } }).action === "escalate");
ok("route none when verifier says no",
   route({ v: { type: "noul", noul: 0.02 } }, { verifier: "v" }).action === "none");

// --- token accounting -------------------------------------------------------
ok("estimateTokens: ascii ~ 1/4 chars", Math.abs(estimateTokens("a".repeat(400)) - 100) <= 1,
   String(estimateTokens("a".repeat(400))));
ok("estimateTokens: CJK ~ 1/char", estimateTokens("司机晋升特权考核") === 8,
   String(estimateTokens("司机晋升特权考核")));
ok("estimateTokens handles empty", estimateTokens("") === 0 && estimateTokens(null) === 0);

// calibration: a measured run of 300 short ascii candidates cost 11,392 input tokens
const cal = buildCandidates(Array.from({ length: 300 }, (_, i) => ({ text: `Widget ${i} — in stock` })));
const calCost = estimateJevCost(cal);
ok("estimateJevCost is within 25% of the measured 300-candidate run",
   Math.abs(calCost.input - 11392) / 11392 < 0.25, `estimated ${calCost.input} vs measured 11392`);
ok("estimateJevCost reports chunk count", calCost.chunks === 2, `chunks=${calCost.chunks}`);

// --- the break-even gate ----------------------------------------------------
const few = buildCandidates(Array.from({ length: 11 }, (_, i) => ({ text: `第 ${i} 章 需求详述` })));
const vFew = jevPaysOff({ candidates: few, fullPayloadChars: 200000 });
ok("jevPaysOff says no for a small set", vFew.worth === false, vFew.reason);
ok("its reason names the candidate count", /11 candidates/.test(vFew.reason));

const fat = buildCandidates(Array.from({ length: 60 }, (_, i) => ({ text: "x".repeat(2000) + i })));
const vFat = jevPaysOff({ candidates: fat, fullPayloadChars: 60 * 2000 });
ok("jevPaysOff says no when candidates ARE the payload", vFat.worth === false, vFat.reason);

const good = buildCandidates(Array.from({ length: 200 }, (_, i) => ({ text: `src/modules/m${i}.ts` })));
const vGood = jevPaysOff({ candidates: good, fullPayloadChars: 1_200_000 });
ok("jevPaysOff says yes for many short pointers vs a big payload", vGood.worth === true, vGood.reason);
ok("verdict carries a ratio", vGood.ratio > 3, `ratio=${vGood.ratio}`);

// --- candidates -------------------------------------------------------------
const cands = buildCandidates([
  { text: "Pro — $29/mo", context: "row" },
  { text: "Pro — $29/mo", context: "row" },
  { text: "  " },
  { text: "Starter — $0/mo", context: "row" },
], { meta: { source: "test" } });
ok("blanks and duplicates dropped", cands.length === 2, `got ${cands.length}`);
ok("ids stable and ordered", cands[0].id === "c1" && cands[1].id === "c2");
ok("meta merged onto candidates", cands[0].source === "test");
ok("original record kept for verbatim copy", copyVerbatim(cands, "c1").text === "Pro — $29/mo");
ok("copyVerbatim on unknown id is null", copyVerbatim(cands, "nope") === null);
ok("explicit key overrides text-based dedup",
   buildCandidates([{ text: "same", key: "a" }, { text: "same", key: "b" }]).length === 2);

const nested = dedupeByContainment([
  { text: "parent sentence with a child inside it" },
  { text: "a child inside it" },
  { text: "unrelated" },
]);
ok("dedupeByContainment drops contained children", nested.length === 2, `got ${nested.length}`);
ok("it keeps the longest", nested.some((n) => /parent sentence/.test(n.text)));

// --- adapters ---------------------------------------------------------------
const rgOut = [
  JSON.stringify({ type: "match", data: { path: { text: "src/a.ts" }, line_number: 10, lines: { text: "  const promote = () => {}\n" } } }),
  JSON.stringify({ type: "match", data: { path: { text: "src/a.ts" }, line_number: 20, lines: { text: "  promote()\n" } } }),
  JSON.stringify({ type: "match", data: { path: { text: "src/b.ts" }, line_number: 3, lines: { text: "import { promote }\n" } } }),
  JSON.stringify({ type: "begin", data: {} }),
  "not json",
].join("\n");
const hits = fromRipgrepJson(rgOut);
ok("ripgrep adapter parses matches only", hits.length === 3, `got ${hits.length}`);
ok("ripgrep candidates are file:line pointers", /^src\/a\.ts:10 /.test(hits[0].text));
ok("ripgrep adapter honors maxPerFile", fromRipgrepJson(rgOut, { maxPerFile: 1 }).length === 2);
const byFile = groupByFile(hits);
ok("groupByFile collapses to one per file", byFile.length === 2, `got ${byFile.length}`);
ok("groupByFile carries hit counts", byFile.find((f) => f.path === "src/a.ts").hits === 2);

ok("files adapter makes paths relative", fromPaths(["/repo/src/x.ts"], { root: "/repo" })[0].text === "src/x.ts");

ok("dom BOILERPLATE matches nav chrome", BOILERPLATE.test("Skip to main content") && BOILERPLATE.test("Home"));
ok("dom BOILERPLATE spares real content", !BOILERPLATE.test("Pro — $29/mo"));
const domRecs = fromPageBlocks(
  [{ id: "1", y: 0, text: "Home" }, { id: "2", y: 10, text: "5 需求详述" }],
  { pageUrl: "https://x.test" });
ok("dom adapter filters boilerplate and keeps block ids",
   domRecs.length === 1 && domRecs[0].key === "2" && domRecs[0].pageUrl === "https://x.test");
const incomplete = completeness({ placeholders: 3, atBottom: false, blocks: [] });
ok("completeness fails on unrendered placeholders",
   incomplete.complete === false && /placeholders/.test(incomplete.problems[0]));
ok("completeness passes when rendered and at the bottom",
   completeness({ placeholders: 0, atBottom: true, blocks: [] }).complete === true);

// --- errors -----------------------------------------------------------------
ok("proxy 403 explained as egress, not TypeSafe",
   /egress policy/.test(explainApiError(new TypeSafeHTTPError(403, "Host not in allowlist: api.typesafe.ai"))));
ok("a real 403 is not mislabeled",
   !/egress policy/.test(explainApiError(new TypeSafeHTTPError(403, "quota exceeded"))));
ok("401 points at the key", /API key/.test(explainApiError(new TypeSafeHTTPError(401, ""))));
ok("missing key fails fast",
   await createClient({ apiKey: "" }).then(() => false, (e) => /TYPESAFE_API_KEY/.test(e.message)));

// --- reporting --------------------------------------------------------------
const p = provenance({
  source: "rg", scope: "src/**", model: "jev-1.13.0", selected: true, confidence: 0.9,
  usage: { input_tokens: 11392, output_tokens: 2942 },
  fullPayloadChars: 400000, digestChars: 6000,
});
ok("provenance reports spend and avoidance",
   p.savings.tokensSpent === 14334 && p.savings.tokensAvoided === 98500,
   JSON.stringify(p.savings));
ok("provenance grades a good run worthwhile", p.savings.verdict === "worthwhile", `ratio=${p.savings.ratio}`);
const thin = provenance({ usage: { input_tokens: 9000, output_tokens: 1000 },
                          fullPayloadChars: 50000, digestChars: 40000 });
ok("provenance grades a thin run marginal", /marginal/.test(thin.savings.verdict), JSON.stringify(thin.savings));
ok("provenance with no spend says not used",
   provenance({ usage: { input_tokens: 0, output_tokens: 0 } }).savings.verdict === "not used");

console.log(fails === 0 ? "\nOFFLINE: ALL PASS" : `\nOFFLINE: ${fails} FAILED`);
process.exit(fails ? 1 : 0);

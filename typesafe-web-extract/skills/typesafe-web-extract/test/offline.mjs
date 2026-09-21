/**
 * Offline tests. No API key, no network, no dependencies — safe for CI.
 *   node test/offline.mjs
 */
import {
  createClient, choice, score, noul, buildCandidates, confidenceOf, noulSaysYes,
  route, copyVerbatim, explainApiError, provenance, CHOICE_MAX_OPTIONS,
  TypeSafeHTTPError,
} from "../scripts/typesafe-client.mjs";

let fails = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

// --- primitives validate at the call site, not at the API -------------------
ok("choice rejects a list", throws(() => choice("q", ["a", "b"])));
ok("choice rejects fewer than two options", throws(() => choice("q", { a: null })));
ok("choice rejects more than 255 options",
   throws(() => choice("q", Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`c${i}`, null])))));
ok("choice accepts exactly 255", !throws(() =>
   choice("q", Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`c${i}`, null])))));
ok("score rejects a map", throws(() => score("q", { a: 1 })));
ok("score rejects fewer than two levels", throws(() => score("q", ["only"])));
ok("score accepts an ordered rubric", score("q", ["lo", "hi"]).criteria.length === 2);
ok("noul omits criteria when absent", !("criteria" in noul("q")));
ok("noul keeps criteria when given", noul("q", { true: "yes", false: "no" }).criteria.true === "yes");
ok("primitives are plain wire objects",
   choice("q", { a: null, b: null }).type === "choice" && score("q", ["a", "b"]).type === "score");

// --- certainty: the Noul trap ----------------------------------------------
ok("confidenceOf(noul 0.99) = 0.98", Math.abs(confidenceOf({ type: "noul", noul: 0.99 }) - 0.98) < 1e-9);
ok("confidenceOf(noul 0.5) = 0 (maximally uncertain)", confidenceOf({ type: "noul", noul: 0.5 }) === 0);
ok("confidenceOf(noul 0.01) = 0.98 (confident no)", Math.abs(confidenceOf({ type: "noul", noul: 0.01 }) - 0.98) < 1e-9);
ok("confidenceOf(choice) reads confidence", confidenceOf({ type: "choice", confidence: 0.83 }) === 0.83);
ok("confidenceOf(score) reads confidence", confidenceOf({ type: "score", confidence: 0.6 }) === 0.6);
ok("confidenceOf(garbage) = 0", confidenceOf(undefined) === 0 && confidenceOf("x") === 0);
ok("noulSaysYes(0.9) true", noulSaysYes({ noul: 0.9 }) === true);
ok("noulSaysYes(0.1) false", noulSaysYes({ noul: 0.1 }) === false);
ok("noulSaysYes(0.55) null inside the band", noulSaysYes({ noul: 0.55 }) === null);

// --- routing ----------------------------------------------------------------
ok("route returns when all strong", route({ a: { type: "choice", confidence: 0.9 } }).action === "return");
ok("route escalates when weak", route({ a: { type: "choice", confidence: 0.4 } }).action === "escalate");
ok("route names the weak keys", route({ a: { type: "choice", confidence: 0.4 } }).weak[0] === "a");
ok("route returns none when the verifier says no",
   route({ v: { type: "noul", noul: 0.02 } }, { verifier: "v" }).action === "none");
ok("a strong verifier does not block a return",
   route({ v: { type: "noul", noul: 0.98 } }, { verifier: "v" }).action === "return");

// --- candidates -------------------------------------------------------------
const cands = buildCandidates([
  { text: "Home" }, { text: "Skip to main content" }, { text: "  " },
  { text: "Pro — $29/mo — 5 seats", context: "row" },
  { text: "Pro — $29/mo — 5 seats", context: "row" },
  { text: "Starter — $0/mo", context: "row" },
], { pageUrl: "https://example.test/p" });
ok("boilerplate, blanks and duplicates dropped", cands.length === 2, `got ${cands.length}`);
ok("ids are stable and ordered", cands[0].id === "c1" && cands[1].id === "c2");
ok("pageUrl is carried onto each candidate", cands[0].pageUrl === "https://example.test/p");
ok("keepBoilerplate opts out", buildCandidates([{ text: "Home" }], { keepBoilerplate: true }).length === 1);
ok("same text at different hrefs is not a duplicate",
   buildCandidates([{ text: "Next", href: "/a" }, { text: "Next", href: "/b" }], { keepBoilerplate: true }).length === 2);
ok("copyVerbatim returns the original record", copyVerbatim(cands, "c1").text === "Pro — $29/mo — 5 seats");
ok("copyVerbatim on an unknown id is null", copyVerbatim(cands, "nope") === null);

// --- errors -----------------------------------------------------------------
ok("a proxy 403 is explained as egress, not TypeSafe",
   /egress policy/.test(explainApiError(new TypeSafeHTTPError(403, "Host not in allowlist: api.typesafe.ai"))));
ok("a real 403 is not mislabeled",
   !/egress policy/.test(explainApiError(new TypeSafeHTTPError(403, "quota exceeded"))));
ok("401 points at the key", /API key/.test(explainApiError(new TypeSafeHTTPError(401, ""))));
ok("429 mentions the rate limit", /rate limit/.test(explainApiError(new TypeSafeHTTPError(429, ""))));

// --- misc -------------------------------------------------------------------
ok("provenance has the contract's fields",
   ["finalUrl", "pageTitle", "retrievalScope", "jev"].every((k) => k in provenance({ pageUrl: "u", pageTitle: "t", scope: "s" })));
ok("option ceiling is 255", CHOICE_MAX_OPTIONS === 255);
ok("a missing key fails fast with a clear message",
   await createClient({ apiKey: "" }).then(() => false, (e) => /TYPESAFE_API_KEY/.test(e.message)));

console.log(fails === 0 ? "\nOFFLINE: ALL PASS" : `\nOFFLINE: ${fails} FAILED`);
process.exit(fails ? 1 : 0);

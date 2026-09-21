# Jev call patterns

Verified against the live API (model `jev-1.13.0`, alias `jev-latest`) on
Node 22.22.2. Every shape below was executed, not inferred from docs.

## The wire format

`scripts/typesafe-client.mjs` speaks this directly, which is why the skill has
no dependencies. You only need it when debugging or porting.

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
Content-Type: application/json
Accept: application/json

{ "state": <string|object|array|null>,
  "questions": { "<name>": { "type": "choice"|"score"|"noul",
                             "instructions": <string|object|array|null>,
                             "criteria": <see below> } },
  "model": "jev-latest" }
```

Response:

```json
{ "model": "jev-1.13.0",
  "answers": { "<name>": { ... } },
  "usage": { "input_tokens": 579, "output_tokens": 81 } }
```

| primitive | JS helper | `criteria` | response fields |
|---|---|---|---|
| choice | `choice(instructions, criteria)` | map `label -> description\|null`, 2–255 entries | `{ type, choice, confidence, probabilities }` |
| score | `score(instructions, criteria)` | ordered array, ≥2 levels, indexed from 0 | `{ type, score, confidence, legend, probabilities }` |
| noul | `noul(instructions, criteria?)` | optional `{ true?, false? }` | `{ type, noul }` — **nothing else** |

`score` returns an expectation, so it may land between levels. TypeSafe's own
docs use Python (`Choice(instructions=..., criteria=...)`); JavaScript uses
lowercase helpers with positional arguments. Same primitives, different surface.

Retries: 408, 429 and 5xx are retried with exponential backoff and jitter,
honoring `Retry-After` / `retry-after-ms`. Two retries by default.

## One batched call

Independent questions go together. Never let one answer become hidden context
for another in the same call.

```js
import { createClient, choice, score, noul } from "../scripts/typesafe-client.mjs";

const client = await createClient();

const { model, answers, usage } = await client.systemOne({
  state: {
    query: "Pro plan monthly price",
    pageUrl: "https://example.test/pricing",
    pageTitle: "Pricing — Example",
    candidates: [
      { id: "c1", text: "Starter — $0/mo — 1 seat", context: "table row" },
      { id: "c2", text: "Pro — $29/mo — 5 seats",   context: "table row" },
      { id: "c3", text: "All prices exclude VAT",   context: "footnote"  },
    ],
  },
  questions: {
    pick: choice("Which candidate id states the Pro plan's monthly price?", {
      c1: null, c2: null, c3: null,
      none: "No candidate answers the query",
    }),
    specificity: score("How directly the selected candidate answers the query", [
      "Unrelated",
      "Related but does not state the price",
      "States the price exactly",
    ]),
    answered: noul("The candidate set contains enough evidence to answer the query"),
  },
});
```

Observed response:

```json
{
  "pick":        { "type": "choice", "choice": "c2", "confidence": 1,
                   "probabilities": { "c1": 0, "c2": 1, "c3": 0, "none": 0 } },
  "specificity": { "type": "score", "score": 1.98, "confidence": 0.97,
                   "legend": { "0": "Unrelated", "1": "…", "2": "States the price exactly" },
                   "probabilities": { "0": 0.01, "1": 0, "2": 0.99 } },
  "answered":    { "type": "noul", "noul": 0.97 }
}
```

Note `answered` has **no** `confidence` key. That absence is the single most
common bug in code written from the prose docs.

## Confidence routing

```js
import { confidenceOf, noulSaysYes, route } from "../scripts/typesafe-client.mjs";

confidenceOf({ type: "noul",   noul: 0.99 })       // 0.98  <- |p-0.5|*2
confidenceOf({ type: "noul",   noul: 0.5  })       // 0     <- maximally uncertain
confidenceOf({ type: "choice", confidence: 0.83 }) // 0.83

const decision = route(answers, { min: 0.7, verifier: "answered" });
// { action: "return" | "escalate" | "none", reason, weak? }
```

Thresholds that held up in practice:

| signal | accept | escalate once | give up |
|---|---|---|---|
| Choice `confidence` | ≥ 0.7 | 0.4 – 0.7 | < 0.4, or `choice === "none"` |
| Score `confidence` | ≥ 0.7 | below | — |
| Noul `noul` | ≥ 0.65 yes / ≤ 0.35 no | 0.35 – 0.65 | verifier says no |

`escalate` means **one** bounded browser action, then accept or return
`none`/unverified. It is not a retry loop.

A genuinely ambiguous page produces low confidence, and that is the system
working. Measured: two equally-valid answers in a 300-candidate set returned
`confidence: 0.48`, which `route()` escalated rather than committing to.

## Candidates that stay copyable

```js
import { buildCandidates, copyVerbatim } from "../scripts/typesafe-client.mjs";

const candidates = buildCandidates(rowsFromDom, { pageUrl });
// -> [{ id:"c1", text, href?, context?, pageUrl, raw }, ...]

const record = copyVerbatim(candidates, answers.pick.choice); // the ORIGINAL row
```

`buildCandidates` removes navigation, boilerplate and exact duplicates. It does
**not** shortlist. TypeSafe's Choice docs are explicit that you should "give the
model the full list … rather than a shortlist", because options cost only a few
tokens each. Trimming real candidates with your own heuristics performs the
semantic judgment you came here to delegate, and hides that you did.

`raw` exists so the value you report is the DOM's, not the model's. Jev selects
an id; code copies the text.

## Past 255 options

A Choice accepts at most 255 options, `none` included — `choice()` throws rather
than letting you find out at the API. `selectCandidate()` chunks at 254 + `none`,
asks every chunk in one batched call, and runs the winners off against each
other:

```js
const hit = await selectCandidate(client, {
  instructions: "Which candidate id names a discontinued product?",
  candidates,                    // any length
  query, pageUrl, pageTitle,
});
// { id, confidence, candidate, model, usage, rounds }
```

Behavior worth knowing:

- One chunk yields a winner and the rest answer `none` → returns in round 1.
- Several chunks yield winners → one runoff round over the winners.
- Every chunk answers `none` → `{ id: null }`. Report `none`, do not guess.
- It never truncates the candidate list.

Cost: 300 candidates measured ~11.4k input / ~2.9k output tokens. Correct, but
not free — bound the candidate set by tightening the DOM region, not by
shortlisting semantically.

## Deep taxonomies

For a hierarchy, chain Choice level by level, but keep a **beam** rather than
committing greedily: at each level keep the best K paths by `probabilities` and
expand them all. A greedy first level that guesses wrong cannot be recovered at
deeper levels, and its final confidence will not reveal the mistake.

## Errors

```js
import { explainApiError } from "../scripts/typesafe-client.mjs";
try { /* … */ } catch (e) { console.error(explainApiError(e)); }
```

| status | body | actual cause |
|---|---|---|
| 403 | `Host not in allowlist: api.typesafe.ai` | network egress policy, or the request bypassed the CONNECT proxy — **not** TypeSafe |
| 403 | anything else | TypeSafe refused the request |
| 401 | — | bad or missing `TYPESAFE_API_KEY` |
| 429 | — | rate limit; retries already exhausted |

The first row is the trap: a correctly allowlisted host still returns that exact
message when Node's global `fetch` bypasses the proxy. Confirm with the two
`curl` calls in SKILL.md before touching the allowlist. A 403 that is genuinely
policy gets reported, not routed around.

## Client options

```js
await createClient({
  apiKey,      // else TYPESAFE_API_KEY; throws if neither
  baseURL,     // else TYPESAFE_BASE_URL, else https://api.typesafe.ai
  model,       // else TYPESAFE_DEFAULT_MODEL, else "jev-latest"
  timeout,     // ms per attempt, default 10000
  maxRetries,  // default 2
});
// -> { systemOne, transport, baseURL, defaultModel }
```

`transport` reports how the request will leave the process — `global`,
`env-proxy`, `undici`, or `global-unproxied`. The last one behind an
`HTTPS_PROXY` is the configuration that produces the misleading 403; log it when
a run fails unexpectedly.

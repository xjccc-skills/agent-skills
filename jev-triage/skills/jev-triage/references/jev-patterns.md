# Jev patterns and measured costs

Verified against the live API (model `jev-1.13.0`, alias `jev-latest`) on
Node 22.22.2. Every number below was measured, not estimated.

## The wire format

`scripts/jev.mjs` speaks this directly, which is why the skill has no
dependencies. You only need it when debugging or porting.

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
Content-Type: application/json

{ "state": <string|object|array|null>,
  "questions": { "<name>": { "type": "choice"|"score"|"noul",
                             "instructions": <string|object|array|null>,
                             "criteria": <see below> } },
  "model": "jev-latest" }
```

```json
{ "model": "jev-1.13.0", "answers": { "<name>": { ... } },
  "usage": { "input_tokens": 579, "output_tokens": 81 } }
```

| primitive | helper | `criteria` | response |
|---|---|---|---|
| choice | `choice(instructions, criteria)` | map `label -> description\|null`, 2–255 entries | `{ type, choice, confidence, probabilities }` |
| score | `score(instructions, criteria)` | ordered array, ≥2 levels, indexed from 0 | `{ type, score, confidence, legend, probabilities }` |
| noul | `noul(instructions, criteria?)` | optional `{ true?, false? }` | `{ type, noul }` — **nothing else** |

TypeSafe's own docs are Python (`Choice(instructions=..., criteria=...)`);
JavaScript uses lowercase helpers with positional arguments. Same primitives.

Retries: 408, 429 and 5xx with exponential backoff and jitter, honoring
`Retry-After` / `retry-after-ms`. Two retries by default.

## Cost model, and how it was calibrated

A Choice pays a per-candidate overhead well above the candidate's own text: the
id appears in the state, again as a criteria label, again in the returned
probabilities, plus JSON punctuation.

Measured: **300 short ASCII candidates → 11,392 input / 2,942 output tokens**,
whose text alone estimates at ~1,650 input tokens. That yields:

```
input  ≈ textTokens + n × 32
output ≈ n × 10
```

`estimateJevCost()` uses those constants. On a later run it predicted 14,204
tokens against an actual 14,311 — **under 1% error**. Trust it for a go/no-go
decision, not for billing.

## The break-even gate

```js
import { jevPaysOff } from "../scripts/triage.mjs";
const v = jevPaysOff({ candidates, fullPayloadChars });
// { worth, candidates, spend, avoided, ratio, reason }
```

Defaults: at least 30 candidates, and at least a 3x avoided/spent ratio.

Two refusals, both common:

| situation | what `worth:false` is telling you |
|---|---|
| 11 doc sections, 8 table rows | too few — reading them all is cheaper than a round trip |
| candidates are full section bodies | the digest is already most of the payload; nothing is avoided |

The rule behind both: **candidates must be pointers, not content.**

Measured evidence that a pointer has to carry signal: asked "which document
explains how long a refund takes" over three bare filenames, Choice returned
**confidence 0.61**. Given the same paths plus their section headings, the same
question returned **0.99**. Pointers that are too thin do not just cost
accuracy — they push you into the escalate branch, which costs another round
trip.

## One batched call

Independent questions go together. Never let one answer become hidden context
for another in the same call.

```js
const { model, answers, usage } = await client.systemOne({
  state: { query, candidates: rows.map(({ raw, ...r }) => r) },
  questions: {
    pick: choice("Which candidate id states the Pro plan's monthly price?",
      { c1: null, c2: null, c3: null, none: "No candidate answers the query" }),
    specificity: score("How directly the selected candidate answers the query",
      ["Unrelated", "Related but does not state the price", "States the price exactly"]),
    answered: noul("The candidate set contains enough evidence to answer the query"),
  },
});
```

Observed:

```json
{ "pick":        { "type": "choice", "choice": "c2", "confidence": 1,
                   "probabilities": { "c1": 0, "c2": 1, "c3": 0, "none": 0 } },
  "specificity": { "type": "score", "score": 1.98, "confidence": 0.97, "legend": {…} },
  "answered":    { "type": "noul", "noul": 0.97 } }
```

`answered` has **no** `confidence` key. That absence is the single most common
bug in code written from the prose docs.

## Certainty routing

```js
confidenceOf({ type: "noul",   noul: 0.99 })       // 0.98  <- |p-0.5|*2
confidenceOf({ type: "noul",   noul: 0.5  })       // 0
confidenceOf({ type: "choice", confidence: 0.83 }) // 0.83

route(answers, { min: 0.7, verifier: "answered" });
// { action: "return" | "escalate" | "none", reason, weak? }
```

| signal | accept | escalate once | give up |
|---|---|---|---|
| Choice `confidence` | ≥ 0.7 | 0.4 – 0.7 | < 0.4, or `choice === "none"` |
| Score `confidence` | ≥ 0.7 | below | — |
| Noul `noul` | ≥ 0.65 yes / ≤ 0.35 no | 0.35 – 0.65 | verifier says no |

A genuinely ambiguous set produces low confidence, and that is the system
working. Measured: two equally-valid answers in a 300-candidate set returned
`confidence: 0.48`, which `route()` escalated rather than committing to.

## Past 255 options

`choice()` throws above 255 rather than letting you find out at the API.
`selectCandidate()` chunks at 254 + `none`, asks every chunk in one batched
call, and runs the winners off against each other:

- one chunk wins, the rest answer `none` → returns in round 1
- several chunks win → one runoff round
- every chunk answers `none` → `{ id: null }`; report `none`, do not guess
- never truncates

`rankCandidates()` is the single-pass alternative when the answer is "these
three": it reads the Choice `probabilities` and returns the top K. It takes at
most 254 candidates, so narrow first if you have more.

## Two-stage narrowing

```js
const r = await refine(client, {
  coarse,                        // pointers
  instructions,
  fetchFull: readCandidateFile,  // pull the winner's payload ONLY
  split: (text) => text.split(/\n(?=## )/).map((t) => ({ text: t.slice(0, 200) })),
  fineInstructions,
});
// { stage1, stage2, selected, full, fullChars, usage }
```

Stage 1 costs pointer-sized tokens; the payload is fetched once, for one
winner. This is where the saving compounds, and it is the shape to reach for
whenever the payload per candidate is large.

## Source traps

### Tree-shaped sources duplicate everything

A DOM, an AST or a nested document emits a parent node and each of its
children, so the same sentence arrives two or three times. Equality-based dedup
does not catch it. `dedupeByContainment()` does, and on a real document it cut
the collected text by roughly 3x.

### Virtualized pages: programmatic scrolling does not render

Measured on Feishu (`lanxiniu.feishu.cn`):

| attempt | placeholders before → after |
|---|---|
| `scroller.scrollTop = y` | 29 → 29 |
| `el.scrollIntoView({block:"center"})` × 4 | 29 → 29 |
| synthetic `new WheelEvent("wheel", {deltaY:400})` × 6 | 29 → 29 |
| **real scroll injected by the browser driver** | **29 → 26, blocks 113 → 162** |

A synthetic event carries `isTrusted: false` and the virtual renderer ignores
it. Only real input works. Two consequences:

- rendering costs whatever your driver charges for a real input action — in a
  screenshot-returning toolchain, that dominates the bill. Measured on one
  document: ~3.5k tokens of text cost ~12k tokens of screenshots. **Prefer an
  API over a browser whenever the source has one.**
- scrolling away **unmounts** rows, so a single read at the end loses them.
  Accumulate by block id between scrolls, and refresh entries whose text was
  empty when first seen.

### Completeness is countable, not a feeling

Unrendered nodes carry a marker class (`bear-virtual-renderUnit-placeholder` on
Feishu). `completeness()` fails while any remain. A visible screenshot is not
evidence the document was read — it shows the viewport.

## Errors

| status | body | actual cause |
|---|---|---|
| 403 | `Host not in allowlist` | network egress policy, or the request bypassed the CONNECT proxy — **not** TypeSafe |
| 403 | anything else | TypeSafe refused the request |
| 401 | — | bad or missing `TYPESAFE_API_KEY` |
| 429 | — | rate limit; retries exhausted |

The first row is the trap: a correctly allowlisted host still returns that exact
message when Node's global `fetch` bypasses the proxy. Confirm with the two
`curl` calls in SKILL.md before touching any allowlist.

## Client options

```js
await createClient({
  apiKey,      // else TYPESAFE_API_KEY; throws if neither
  baseURL,     // else TYPESAFE_BASE_URL, else https://api.typesafe.ai
  model,       // else TYPESAFE_DEFAULT_MODEL, else "jev-latest"
  timeout,     // ms per attempt, default 10000
  maxRetries,  // default 2
});
// -> { systemOne, transport, baseURL, defaultModel, spent }
```

`spent` is a running `{ input_tokens, output_tokens, calls }` tally — feed it to
`provenance()` so a run can report what it cost. `transport` reports how
requests leave the process (`global`, `env-proxy`, `undici`,
`global-unproxied`); the last one behind an `HTTPS_PROXY` is the configuration
that produces the misleading 403.

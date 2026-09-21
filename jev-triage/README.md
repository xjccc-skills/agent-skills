# jev-triage

An [Agent Skill](https://agentskills.io) that keeps a large candidate set out of
your model's context. Enumerate candidates in code, let
[TypeSafe/Jev](https://typesafe.ai) make the typed judgment over cheap pointers,
and let only the selected few through.

Works in **Claude Code**, **OpenAI Codex**, and any client implementing the
Agent Skills format.

**Zero dependencies. No build step. No `npm install`.**

## The problem

Asking a model "which of these 300 files implements the promotion rules" means
putting 300 files in front of it — and paying for them on every turn they stay
in context. Asking "which section of this 40-section spec covers refunds" means
sending the whole spec.

Most of that payload is haystack. You pay for it anyway because the model is the
only thing that can tell haystack from needle.

## What this does

Jev is a small, separately-billed model that answers narrow typed questions.
That makes it possible to do the sorting *outside* the expensive context:

```
300 file paths  ──► Jev: which 3 of these?  ──►  3 files enter context
   ~14k tokens            (separate, cheap)        instead of ~900k
```

Measured on a real run: **223,000 tokens avoided for 14,000 spent — 15.7x.**

The skill reports that ratio on every run, because a tool that claims to save
tokens should have to prove it.

## When it does NOT pay

This is the part most write-ups leave out, and it is enforced in code rather
than left to judgment:

```js
const verdict = jevPaysOff({ candidates, fullPayloadChars });
if (!verdict.worth) { /* just read them all */ }
```

It refuses in two situations:

- **Fewer than ~30 candidates.** The round trip costs more than reading them.
  Eleven document sections are not worth a call.
- **Candidates that are already the payload.** If judging a candidate needs its
  full text, nothing was avoided — the cost just moved to another bill.

The rule behind both: **candidates must be pointers, not content.** Headings not
bodies, paths and signatures not files, `file:line` not the function.

Measured: asked which document explains refunds, three bare filenames gave
`confidence 0.61`; the same paths plus their section headings gave `0.99`. Thin
pointers cost accuracy *and* trigger a second round trip.

## Install

### Claude Code

```bash
/plugin marketplace add xjccc-skills/agent-skills
/plugin install jev-triage@xjccc-skills
```

### Codex

```bash
codex plugin marketplace add xjccc-skills/agent-skills
```

Then install `jev-triage` from the added catalog.

## Requirements

```bash
node skills/jev-triage/scripts/preflight.mjs
```

```
ok    node              Node 22.22.2
ok    api-key           TYPESAFE_API_KEY is set
ok    transport         no proxy configured
ok    reachable         reachable (HTTP 405)
ok    candidate source  not checkable from a script
```

Node 20+ and a [TypeSafe](https://typesafe.ai) API key. Keep the key in a secret
store, not the repo:

```bash
export TYPESAFE_API_KEY="$(security find-generic-password -s typesafe -a "$USER" -w)"  # macOS
```

The reachability probe is a `GET` the API answers with `405`, so it spends no
model tokens.

### Behind an HTTP egress proxy

Node's **global `fetch` ignores `HTTPS_PROXY`**. In a sandbox that enforces
egress through a CONNECT proxy — Codex Cloud, Claude Cowork, many CI runners —
requests go out directly and return `403 Host not in allowlist`, which reads
like a missing allowlist entry even when the host is allowed. Fix:

```bash
NODE_USE_ENV_PROXY=1 node your-script.mjs   # Node 22+, nothing to install
npm i undici                                 # optional; picked up automatically
```

`preflight.mjs` detects this and names the fix.

## Usage

```js
import { createClient, choice, noul, route } from "./scripts/jev.mjs";
import { jevPaysOff, buildCandidates, selectCandidate, copyVerbatim, provenance }
  from "./scripts/triage.mjs";
import { fromRipgrepJson, groupByFile } from "./scripts/adapters/grep.mjs";

const client = await createClient();
const candidates = buildCandidates(groupByFile(fromRipgrepJson(rgOutput)));

// 1. Is narrowing even worth it?
const gate = jevPaysOff({ candidates, fullPayloadChars: totalBytesOfThoseFiles });
if (!gate.worth) throw new Error(gate.reason);

// 2. Narrow.
const hit = await selectCandidate(client, {
  instructions: "Which candidate implements driver promotion eligibility?",
  candidates, query: requirement,
});

// 3. Copy the source's value, not the model's words.
const file = copyVerbatim(candidates, hit.id);

// 4. Say what it cost.
console.log(provenance({ source: "rg", model: hit.model, selected: !!hit.id,
  confidence: hit.confidence, usage: client.spent,
  fullPayloadChars: totalBytesOfThoseFiles, digestChars }));
```

`refine()` does the two-stage version: narrow over pointers, fetch the winner's
payload only, narrow again inside it.

## Sources

Candidates can come from anywhere. Adapters normalize; the core never knows.

| adapter | turns into candidates |
|---|---|
| `adapters/grep.mjs` | `rg --json` hits, one per line or grouped per file |
| `adapters/files.mjs` | paths, or paths plus their declaration lines |
| `adapters/dom.mjs` | page blocks, with virtualization and completeness handling |

Writing your own is one function: return `{ text, key, ...anything }` records.

## Gotchas this skill encodes

Things easy to get wrong from the prose docs, so they live in code:

| | |
|---|---|
| **Noul has no `confidence` field** — reading it yields `undefined` | `confidenceOf()` |
| Narrowing a set too small to be worth it | `jevPaysOff()` |
| Choice caps at 255 options | `selectCandidate()` chunks, never truncates |
| Tree sources emit each sentence 2–3 times | `dedupeByContainment()` |
| `fetch` ignores `HTTPS_PROXY`, producing a misleading 403 | `createClient()` |
| A proxy 403 and a TypeSafe 403 look identical | `explainApiError()` |
| Reporting the model's text instead of the source's | `copyVerbatim()` |
| Claiming a saving without measuring it | `provenance().savings` |

## Tests

```bash
node test/offline.mjs   # 56 assertions, no key, no network
node test/live.mjs      # 19 assertions, needs TYPESAFE_API_KEY, ~20k tokens
```

`test/live.mjs` exits 0 with a SKIP notice when no key is set, so CI stays green
on forks.

## Verified against

`jev-1.13.0` (alias `jev-latest`), `POST /v1/systemone`, Node 22.22.2. The
client speaks the wire protocol directly rather than depending on
`@typesafe-ai/sdk`, which is what keeps the install dependency-free. If TypeSafe
ships a breaking API change, `test/live.mjs` is what catches it.

`references/jev-patterns.md` has the wire format, measured costs, routing
thresholds, and the source-specific traps.

## Credits

Descended from Anthropic's `typesafe-web-content` skill, reframed from web
extraction to candidate triage. Corrects the Noul confidence assumption, removes
both dependencies, adds the break-even gate and savings reporting, replaces
heuristic shortlisting with full-candidate selection, and documents the proxy
and virtualization traps.

## License

MIT — see [LICENSE](../LICENSE).

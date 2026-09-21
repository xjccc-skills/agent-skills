# typesafe-web-extract

An [Agent Skill](https://agentskills.io) for extracting content from live web
pages: the browser does navigation and copying, [TypeSafe/Jev](https://typesafe.ai)
makes the small typed judgments — which candidate, how well it matches, does the
evidence actually answer the question.

Installable with the official plugin commands in **OpenAI Codex** and
**Claude Code**, and usable as a plain skill folder in any other client that
implements the Agent Skills format.

**Zero dependencies. No build step. No `npm install`.**

## Why this exists

Agents asked to "get the price from this page" tend to do one of two things:
scrape a selector that breaks next week, or hand the page to a language model and
trust whatever comes back. The first is brittle; the second invents prices.

This skill splits the work at the seam where each side is actually reliable:

- **Code** navigates, filters, deduplicates, paginates, and copies values
  verbatim from the DOM.
- **Jev** answers narrow typed questions about a bounded candidate set —
  *which one*, *how well*, *is this enough* — and reports calibrated confidence.

A value that reaches you was copied from the page, never generated. When the page
is ambiguous, confidence drops and the skill escalates or declines instead of
guessing.

## Install

### Claude Code

```bash
/plugin marketplace add xjccc-skills/agent-skills
/plugin install typesafe-web-extract@xjccc-skills
```

Or in one command (Claude Code v2.1.275+):

```bash
/plugin install typesafe-web-extract --marketplace xjccc-skills/agent-skills
```

### Codex

```bash
codex plugin marketplace add xjccc-skills/agent-skills
```

Then install `typesafe-web-extract` from the added catalog.

### Other Agent Skills clients

Clients without a plugin command read a skill folder directly. Clone the repo and
point the client's skills directory at the skill:

```bash
git clone git@github.com:xjccc-skills/agent-skills.git
ln -sfn "$PWD/agent-skills/typesafe-web-extract/skills/typesafe-web-extract" \
        ~/.claude/skills/typesafe-web-extract
```

### Verify before publishing

Both clients accept a local path as a marketplace, which is the quickest way to
check the manifests without pushing:

```bash
/plugin marketplace add ./agent-skills        # Claude Code
```

## Prerequisites

Run the preflight check first. It prints the exact fix for anything missing:

```bash
node skills/typesafe-web-extract/scripts/preflight.mjs
```

```
ok    node        Node 22.22.2
ok    api-key     TYPESAFE_API_KEY is set
ok    transport   no proxy configured
ok    reachable   reachable (HTTP 405)
ok    browser     not checkable from a script — the agent must confirm it has browser control
```

Exit 0 means ready; exit 1 lists what to fix. The reachability probe is a `GET`
that the API answers with `405`, so it spends **no model tokens**.

| prerequisite | notes |
|---|---|
| **Node 20+** | standard library only |
| **A TypeSafe API key** | in `TYPESAFE_API_KEY`. Get one at [typesafe.ai](https://typesafe.ai) |
| **Browser control** | Codex Computer Use, Claude in Chrome, a Playwright MCP server, or equivalent. Not script-checkable — the skill instructs the agent to confirm it and stop if absent |

Neither plugin format can declare a non-plugin prerequisite — Claude Code's
`dependencies` field takes other *plugins* only, and Codex has no dependency
mechanism at all — so these are checked at runtime rather than at install.

Keep the key out of the repo:

```bash
export TYPESAFE_API_KEY="$(security find-generic-password -s typesafe -a "$USER" -w)"  # macOS
```

Without a key the skill still runs; it falls back to deterministic extraction and
marks the result unverified.

### Behind an HTTP egress proxy

Node's **global `fetch` ignores `HTTPS_PROXY`**. In a sandbox that enforces egress
through a CONNECT proxy — Codex Cloud, Claude Cowork, many CI runners — requests
therefore go out directly and come back as:

```
403 Host not in allowlist: api.typesafe.ai
```

which reads like a missing allowlist entry even when the host is allowed. Tell
the two apart:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://api.typesafe.ai/v1/systemone
curl -s -o /dev/null -w '%{http_code}\n' --noproxy '*' https://api.typesafe.ai/v1/systemone
```

`405` through the proxy and `403` without it means the host is fine and only the
transport is wrong. Fix it either way:

```bash
NODE_USE_ENV_PROXY=1 node your-script.mjs   # Node 22+, nothing to install
npm i undici                                 # optional; picked up automatically
```

`preflight.mjs` detects this case and names the fix. If the host is genuinely
blocked by policy, report it rather than routing around it.

## Usage

```js
import {
  createClient, choice, score, noul,
  buildCandidates, selectCandidate, route, copyVerbatim,
} from "./scripts/typesafe-client.mjs";

const client = await createClient();

// 1. Turn DOM records into stable candidates. Drops nav and duplicates only —
//    never shortlists real candidates; that judgment is what Jev is for.
const candidates = buildCandidates(rowsFromPage, { pageUrl });

// 2. Ask independent questions in one call.
const { answers } = await client.systemOne({
  state: { query, pageUrl, pageTitle, candidates: candidates.map(({ raw, ...c }) => c) },
  questions: {
    pick: choice("Which candidate id states the Pro plan's monthly price?", {
      ...Object.fromEntries(candidates.map((c) => [c.id, null])),
      none: "No candidate answers the query",
    }),
    answered: noul("The candidate set contains enough evidence to answer the query"),
  },
});

// 3. Route on certainty, then copy the DOM's value — not the model's.
if (route(answers, { min: 0.7, verifier: "answered" }).action === "return") {
  const record = copyVerbatim(candidates, answers.pick.choice);
}
```

`selectCandidate()` wraps this and handles sets larger than one Choice can hold.

## Gotchas this skill encodes

Things that are easy to get wrong from the prose docs, so they live in code
instead of instructions:

| | |
|---|---|
| `fetch` ignores `HTTPS_PROXY`, producing a misleading 403 | `createClient()` |
| **Noul has no `confidence` field** — reading it yields `undefined` | `confidenceOf()` |
| Choice caps at 255 options | `selectCandidate()` chunks, never truncates |
| `null` criteria descriptions save tokens on large sets | `selectCandidate()` |
| A proxy 403 and a TypeSafe 403 look identical | `explainApiError()` |
| Reporting the model's text instead of the page's | `copyVerbatim()` |
| Prerequisites no manifest can declare | `preflight.mjs` |

The Noul one is worth repeating: `choice` and `score` return `confidence` and
`probabilities`; `noul` returns `{ type, noul }` and nothing else. Its certainty
is how far the probability sits from 0.5. Use `confidenceOf()` and it cannot bite
you.

## Tests

```bash
cd typesafe-web-extract/skills/typesafe-web-extract
node test/offline.mjs   # 38 assertions, no key, no network
node test/live.mjs      # 10 assertions, needs TYPESAFE_API_KEY, spends ~15k tokens
```

`test/live.mjs` exits 0 with a SKIP notice when no key is set, so CI stays green
on forks.

## Layout

The nesting follows what both plugin formats document, so one repository serves
both official install commands with no duplicated content:

```
agent-skills/                                ← repository root
├── .claude-plugin/marketplace.json          Claude Code catalog (must be at repo root)
├── .agents/plugins/marketplace.json         Codex catalog (must be at repo root)
└── typesafe-web-extract/                    ← this plugin
    ├── .claude-plugin/plugin.json           Claude Code plugin manifest
    ├── .codex-plugin/plugin.json            Codex plugin manifest
    └── skills/typesafe-web-extract/
        ├── SKILL.md                         instructions the agent loads
        ├── scripts/typesafe-client.mjs      the implementation — zero dependencies
        ├── scripts/preflight.mjs            prerequisite check
        ├── references/jev-patterns.md       worked call shapes, thresholds, wire format
        ├── agents/openai.yaml               optional Codex metadata for direct installs
        └── test/                            offline and live suites
```

Only the four manifests differ between the two clients; `skills/` is shared
verbatim.

## Verified against

`jev-1.13.0` (alias `jev-latest`), API `POST /v1/systemone`, Node 22.22.2.
The client speaks the wire protocol directly rather than depending on
`@typesafe-ai/sdk`, which is what keeps the install dependency-free. If TypeSafe
ships a breaking API change, `test/live.mjs` is what catches it.

## Credits

Derived from Anthropic's `typesafe-web-content` skill. This version corrects the
Noul confidence assumption, removes both dependencies, documents the proxy
failure mode, replaces heuristic shortlisting with full-candidate selection, adds
a preflight check for prerequisites no manifest can express, and supplies the
`jev-patterns.md` reference the original links to but does not ship.

## License

MIT — see [LICENSE](LICENSE).

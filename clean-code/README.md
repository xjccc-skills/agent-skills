# clean-code

An [Agent Skill](https://agentskills.io) for maintainability reviews and scoped readability refactors, with Clean Code guidance available when implementation or bug-fix work explicitly calls for it.

It turns common guidance into a small decision loop: identify a concrete signal, make the smallest behavior-preserving change, and prove the result with focused verification. It covers names, function boundaries, comments, layout, errors, objects and modules, external boundaries, tests, and targeted refactoring.

The skill deliberately avoids universal line or parameter limits. Those are inspection signals whose meaning depends on the contract and the surrounding code.

It is an independent synthesis of Robert C. Martin's *Clean Code: A Handbook of Agile Software Craftsmanship* (Prentice Hall, 2008). It combines selected book principles with explicitly identified modern engineering adaptations and original examples. It is not a chapter-by-chapter summary.

## Install

### Claude Code

```bash
/plugin marketplace add xjccc-skills/agent-skills
/plugin install clean-code@xjccc-skills
```

### Codex

```bash
codex plugin marketplace add xjccc-skills/agent-skills
```

Then install `clean-code` from the added catalog.

## Contents

- `skills/clean-code/SKILL.md` — the workflow and core checks.
- `skills/clean-code/references/principles.md` — the signal/action/proof matrix and decisions about commands, data abstraction, construction, and simple design.
- `skills/clean-code/references/decision-examples.md` — six original examples showing when to refactor and when to retain the existing design.
- `skills/clean-code/references/concurrency.md` — conditional guidance for shared state, atomic transitions, and ordering-dependent behavior.

## Usage

After installation, ask for the bounded change or review you want, for example:

- `Use $clean-code to refactor this export mapping while preserving its output contract.`
- `Use $clean-code to review this job-claiming path, including whether concurrent callers can claim the same job. Report findings without editing.`

The skill loads examples and concurrency guidance only when the task calls for them. No runtime, API key, or external service is required.

## License

MIT — see [`LICENSE`](../LICENSE).

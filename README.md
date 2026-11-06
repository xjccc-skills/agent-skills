# agent-skills

[Agent Skills](https://agentskills.io) maintained by **xjccc-skills**, packaged
so they install with the official plugin commands in **Claude Code** and
**Codex**.

## Skills

| Skill | What it does | Requires |
| :---- | :----------- | :------- |
| [**jev-triage**](jev-triage/) | Keeps a large candidate set out of the model's context: enumerate candidates in code, let [TypeSafe/Jev](https://typesafe.ai) pick over cheap pointers, let only the selected few through. Includes a break-even gate that refuses when narrowing would cost more than it saves, and reports the token ratio on every run. | Node 20+, a TypeSafe API key |
| [**clean-code**](clean-code/) | Applies Clean Code principles to maintainability reviews and scoped readability refactors, with signal → action → proof guidance for names, boundaries, errors, modules, smells, and tests. | None |

## Install

### Claude Code

```bash
/plugin marketplace add xjccc-skills/agent-skills
/plugin install jev-triage@xjccc-skills
```

Or in one command (Claude Code v2.1.275+):

```bash
/plugin install jev-triage --marketplace xjccc-skills/agent-skills
```

### Codex

```bash
codex plugin marketplace add xjccc-skills/agent-skills
```

Then install the skill you want from the added catalog.

### Verify locally before publishing

Claude Code accepts a local path as a marketplace, which checks the manifests
without pushing:

```bash
/plugin marketplace add ~/path/to/agent-skills
```

Each skill's own README covers its prerequisites, usage and tests.

## Repository layout

```
agent-skills/
├── .claude-plugin/marketplace.json     Claude Code catalog — must be at the repo root
├── .agents/plugins/marketplace.json    Codex catalog — must be at the repo root
└── <skill-name>/                       one folder per skill, each a complete plugin
    ├── .claude-plugin/plugin.json
    ├── .codex-plugin/plugin.json
    ├── README.md
    └── skills/<skill-name>/SKILL.md
```

Both catalogs must sit at the repository root; that is what makes
`marketplace add xjccc-skills/agent-skills` resolve. Everything else is
per-skill.

## Adding a skill

1. Create `<skill-name>/` with `.claude-plugin/plugin.json`,
   `.codex-plugin/plugin.json` and `skills/<skill-name>/SKILL.md`.
2. Add one entry to each catalog, with `source` pointing at `./<skill-name>`.
3. Keep `name` and `version` identical across both plugin manifests and the
   catalog entry — CI fails the build if they drift, and `claude plugin tag`
   requires it.

CI validates every manifest before running any tests, because a malformed
manifest breaks installation for everyone.

## License

MIT — see [LICENSE](LICENSE).

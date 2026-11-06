---
name: clean-code
description: "Apply Clean Code and Refactoring principles to maintainability reviews and scoped readability refactors, or when the user requests either approach while implementing or fixing code. Use contract-aware checks and small, verified transformations."
---

# Clean Code: make the next change easier

Use this skill when code is hard to understand, change, test, or diagnose. Treat Clean Code as a set of signals and trade-offs, not a list of numeric laws. A smaller, behavior-preserving change that removes a real maintenance cost is better than a broad style rewrite.

## Source and interpretation

This is an independent, selective synthesis of two complementary books:

- Robert C. Martin's *Clean Code: A Handbook of Agile Software Craftsmanship* (Prentice Hall, 2008) supplies design criteria for names, functions, comments, errors, modules, tests, and concurrency.
- Martin Fowler's *Refactoring: Improving the Design of Existing Code*, second edition (2018, with Kent Beck), supplies the process of small, behavior-preserving transformations and names for common techniques.

This is not a chapter-by-chapter summary. Examples, boundary schemas and type narrowing, compatibility safeguards, and contextual trade-offs are this skill's engineering adaptations rather than quotations or universal rules from either book. Apply the repository's language idioms and contracts when a recommendation does not fit.

## Choose the pass

Start by naming the current mode and its boundary:

- **Implement:** keep the new path easy to read and place policy in the right module.
- **Fix:** reproduce the failure, make the smallest correction, and add or adjust a regression test when the behavior warrants one.
- **Refactor:** establish the observable behavior, change one seam at a time, and verify each step using the [refactoring workflow](references/refactoring.md). Keep intended feature changes and bug fixes distinct from behavior-preserving steps.
- **Review:** report concrete risks and confusing decisions, ordered by impact; do not turn preferences into defects. Propose changes without editing unless implementation is requested.

Read the repository's local conventions, existing tests, and nearby code before choosing rules. Apply only the principle groups relevant to the changed path. Use the sequence **signal → action → proof** for every finding:

1. Name the observable signal and the maintenance cost it creates.
2. For implementation, make the smallest change that removes that cost without changing the contract. For review, propose the change and its rationale.
3. Verify with focused tests, type checks, linters, or a behavior comparison where possible. Distinguish observed results from checks proposed for a future change.

## Core checks

Read [references/principles.md](references/principles.md) for the detailed signal/action/proof matrix. The short version is:

- **Names:** express purpose, domain meaning, units, and state. Resolve misleading abbreviations and synonym drift at the boundary where the ambiguity appears.
- **Functions:** give each function one coherent reason to change. Extract decision-making from I/O, replace flag arguments with explicit operations when they hide behavior, and make side effects visible at the call site.
- **Comments:** let names, types, and structure explain what code does. Keep comments for intent, constraints, contracts, or external facts that code cannot express; delete comments that merely narrate syntax.
- **Layout:** keep related code close, keep one abstraction level per small region, and let the repository formatter establish mechanical style. Use vertical structure to make the main path visible.
- **Errors:** choose one consistent failure model for the layer. Preserve useful context, handle failures at a meaningful boundary, and distinguish an absent value from an exceptional failure instead of silently swallowing either.
- **Objects and modules:** hide representation details behind stable interfaces. Separate policy from mechanism, prefer composition when inheritance couples unrelated responsibilities, and keep dependencies pointing toward abstractions or domain policy.
- **Boundaries:** validate unknown or external values once at the owning boundary, then pass narrowed values inward. Reuse existing boundaries; add an adapter when external details leak into domain policy, defensive checks repeat, or an actual replacement or testing need justifies it.
- **Tests:** make tests readable, deterministic, independent, and focused on observable behavior. A test should explain one concept and fail for a useful reason; preserve a fast local feedback loop.
- **Smells and small refactors:** target duplication, long or branching functions, feature envy, primitive obsession, hidden temporal coupling, and broad modules only when they create a specific cost in this change. Keep each refactor reversible and scoped.

Do not enforce arbitrary limits such as a universal line count, parameter count, or ban on `null`. Use them as prompts to inspect the contract and the surrounding design. Preserve public behavior, error semantics, performance characteristics, and data formats unless the request explicitly changes them.

## Read only the relevant guidance

- When a query changes state, an object exposes its representation, domain code constructs dependencies, or a proposed abstraction adds indirection, use the [design decisions](references/principles.md#design-decisions) to choose a boundary.
- When similar code, function length, a public rename, an absent value, or a small bug fix raises a refactoring question, read [decision examples](references/decision-examples.md). They include reasons to retain a design as well as reasons to change it.
- When implementing a refactor, preparing existing code for an authorized change, or reviewing a transformation's equivalence, read [refactoring techniques](references/refactoring.md). Select the relevant technique; keep reviews read-only.
- When the touched path has shared mutable state, overlapping asynchronous work, locks, or an ordering dependency, read [concurrency checks](references/concurrency.md). Load this reference only for those paths.

## Working loop

1. Inspect the target and its callers, tests, types, and local instructions.
2. Choose the relevant checks above; skip unrelated categories.
3. Record the current behavior or failing case before editing.
4. For implementation, make one cohesive edit at a time. Prefer a clear name, a narrow function, an existing boundary, or a focused test over a new abstraction without a caller. For review, describe the proposed change without editing.
5. Re-read the relevant diff for changed behavior, duplicated logic, accidental scope, and stale comments.
6. Run the narrowest meaningful verification and the repository's required checks applicable to the change. Name any checks that could not run.
7. Report the findings or behavior changed, the evidence run, and any remaining uncertainty.

For review output, separate correctness risks from maintainability suggestions. Point to the smallest useful location, explain the failure mode, and give a concrete fix or verification step. If no actionable issue remains, say so after checking the relevant categories.

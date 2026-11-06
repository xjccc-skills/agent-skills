# Clean Code signal matrix

Use this reference after selecting a mode in `SKILL.md`. Each row is a prompt for judgment, not a mandatory rewrite.

| Area | Signals to inspect | Useful actions | Proof of improvement |
| --- | --- | --- | --- |
| Names | A name requires a comment, hides units/state, or uses several synonyms for one concept | Rename at the narrowest safe boundary; align domain vocabulary across callers | A reader can explain the value's purpose and valid state without opening its implementation |
| Functions | Mixed abstraction levels, nested conditionals, boolean flags, long parameter lists, or hidden I/O | Extract a decision or side effect; introduce a value/parameter object when it clarifies a real relationship; split public operations | Main path reads in domain terms; focused tests cover decisions and side effects separately |
| Comments | Comment repeats code, is stale, or explains a workaround without its constraint | Replace with a name/structure; retain the reason, invariant, or external contract; date a temporary workaround only when the repository convention supports it | The code remains understandable after removing narration; retained comments answer “why” |
| Layout | Related declarations are far apart, a file mixes layers, or a reader must jump to find the happy path | Group by change reason and lifecycle; keep policy near policy and adapters near their boundary; run the formatter | Diff is local; the main path and failure path can be followed top to bottom |
| Errors | A failure loses operation/input context, `null` has several meanings, or an exception is caught and ignored | Normalize errors at the boundary; add context without duplicating it; make absence explicit; handle or propagate deliberately | A failing test identifies the operation and cause, and callers have one predictable failure contract |
| Objects/modules | A class owns unrelated data, exposes representation, or a module knows vendor details and business policy | Encapsulate state transitions; narrow the interface; separate adapter, policy, and orchestration; compose focused collaborators | Callers depend on stable behavior rather than fields or vendor APIs |
| Boundaries | JSON, environment, files, network responses, or third-party types enter core logic unchecked | Parse/validate once at the boundary; convert to an internal type; keep external names and retries in the adapter | Interior functions receive trusted types and contain no repeated shape checks |
| Tests | Shared mutable fixtures, time/network dependence, broad setup, or assertions on implementation details | Give each test one concept; inject clocks/ports; assert outcomes and contracts; keep fixtures minimal | Tests are order-independent, fast enough for local runs, and fail with a useful message |
| Smells/refactoring | Repeated rules, long methods, feature envy, primitive obsession, temporal coupling, or speculative layers | Refactor the smallest seam that has a demonstrated cost; preserve behavior between steps; remove dead code after callers move | Focused checks pass and the diff makes the next change more local |

## Design decisions

These concepts come from the book; the qualifications describe how this skill applies them in contemporary code.

### Command and query separation

A predicate or getter that also saves data, consumes a queue item, or advances state makes repeated calls surprising. Prefer queries that describe state and commands whose names reveal the transition. For example, keep `isEligible()` observational and make `approve()` an explicit operation.

Returning a result from a command can be useful: an inserted identifier, a claimed job, or a compare-and-set outcome belongs to that transition's contract. Preserve atomic operations such as `claimNextJob()`; splitting one into `peek()` and `remove()` can introduce a race. Verify query repeatability and the command's externally visible transition, including atomicity when relevant.

### Objects and data structures

An object owns invariants and behavior while hiding representation. A data structure exposes values for other code to transform. Choose based on the expected change: objects can make adding implementations local; explicit records can make adding operations over existing data straightforward.

Keep DTOs, serialization records, and immutable pipeline values as data when they have no behavior to protect. Getters and setters around every field do not by themselves create encapsulation. If callers repeatedly coordinate fields to preserve one invariant, move that transition behind an owning operation. Verify the invariant through that operation; preserve wire formats when representation crosses a public boundary.

### Separate construction from use

Domain logic that chooses credentials, creates network clients, or wires concrete repositories mixes setup with policy. Move that wiring to an application entry point, factory, or existing composition root and pass in the dependency the operation actually uses.

A function argument or constructor parameter is often enough. Introduce a container or interface hierarchy only when existing variation or lifecycle needs justify it. Verify that policy can run with a controlled dependency, and that production wiring still creates and releases the correct resources.

### Simple design

Use the book's simple-design priorities in order: satisfy the tests, remove duplicated knowledge, express intent, then minimize unnecessary classes and methods. Passing tests is evidence for covered behavior, not proof that the contract is complete.

Distinguish duplicated policy from repeated syntax: share a rule when its callers should change together. Retain similar implementations when their business rules evolve independently. Compare the proposed abstraction with the direct version by tracing a concrete next change; choose the version with fewer concepts and less caller knowledge while preserving behavior. See the [duplication example](decision-examples.md#1-similar-code-independent-policies) when the ownership is unclear.

## Review severity guide

- **High:** likely incorrect behavior, lost errors, unsafe boundary data, or a change that breaks a stated contract.
- **Medium:** recurring maintenance cost in the touched path, such as duplicated policy or an interface that forces callers to know implementation details.
- **Low:** local clarity or consistency improvement with no demonstrated failure mode; suggest it only when it is cheap and directly relevant.

When evidence is incomplete, run the smallest relevant check available within scope. If it cannot run, state the assumption and verification gap; ask for missing information only when it materially affects correctness or scope. Do not inflate a style preference into a correctness finding.

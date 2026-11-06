# Refactoring: choose a step, preserve behavior, verify

Use this reference for an authorized refactor, a preparatory change needed for the current task, or a review of an existing transformation. *Clean Code* provides criteria for a useful design; *Refactoring* provides a way to move toward it without mixing structural changes with changed requirements.

The technique names and small-step approach follow Martin Fowler's second edition. Selection criteria, precautions, and the worked example below are original engineering guidance. For canonical terminology, consult the [author's book page](https://martinfowler.com/books/refactoring.html), [definition](https://refactoring.com/), and [catalog](https://refactoring.com/catalog/).

## Establish what must stay the same

Describe the intended improvement and the observable contract of the touched path: returned values, errors, mutations, side effects and their order, and any public interfaces or data formats. Include ordering, identity, or performance constraints when the actual callers rely on them. Inspect callers and relevant tests to identify that contract rather than guessing from the function body alone.

A requested feature or defect correction intentionally changes some behavior. Keep its acceptance criteria distinct from the baseline used to verify structural steps. A refactor may precede or follow the behavior change when it helps this task; it does not authorize unrelated cleanup or a broader API migration.

## Small-step loop

1. **Establish a baseline.** Run the relevant checks before editing. Where useful behavior lacks coverage, add focused characterization checks for representative, boundary, and failure cases. Record existing failures; proceed only where the affected behavior can still be checked. For a review, inspect the evidence and report gaps without editing files.
2. **Choose one transformation.** Name the concrete reading or change cost it removes. Prefer an existing language or IDE refactoring when it can reliably update references, then inspect the result. A code smell is a lead to investigate, not an instruction to apply a pattern.
3. **Make one checkable step.** For implementation, move or rename code without also changing policy, defaults, error handling, or arithmetic. Preserve evaluation count, short-circuiting, captured state, and side-effect order where relevant. Keep the program runnable between steps. For review, assess the existing diff and propose any needed correction.
4. **Verify the step.** Reuse the baseline checks and inspect affected callers. If a new failure appears, diagnose or undo only the latest in-scope edit before continuing; preserve other work. Never update expected results merely to make a refactor pass.
5. **Stop at the intended improvement.** Run applicable repository checks and report the simplified responsibility or dependency plus the evidence observed. If an extraction adds navigation without useful meaning, retaining the original or inlining the helper can be the better result.

When tests are unavailable, use a bounded before/after comparison at the relevant boundary and state what it cannot establish. Type checks alone do not establish behavioral equivalence. If the next step would change an unverified external contract, keep that part intact and report the missing evidence.

## Choose a technique from the signal

Use only the row that matches the actual problem. These are choices rather than a sequence or an exhaustive catalog.

| Signal | Candidate technique | Decision and verification |
| --- | --- | --- |
| A coherent operation is buried in a larger function | [Extract Function](https://refactoring.com/catalog/extractFunction.html) | Give the operation a meaningful name and explicit inputs. Check captured variables, mutations, receiver binding, and when effects occur. |
| A helper adds indirection but no useful meaning | [Inline Function](https://refactoring.com/catalog/inlineFunction.html) | Inline only when callers and dispatch are understood. Preserve argument evaluation count and order; duplicated expressions can repeat an effect. |
| An expression obscures a domain decision | Extract Variable; Inline Variable when the name adds no meaning | Keep evaluation at the original point. Hoisting a value out of a conditional or across a mutation can change behavior. |
| A name or signature obscures what callers request | [Change Function Declaration](https://refactoring.com/catalog/changeFunctionDeclaration.html) | Locate callers, callbacks, and public consumers. For exposed APIs, use the [compatibility example](decision-examples.md#3-a-misleading-name-on-a-public-api) instead of assuming all clients can migrate. |
| Several parameters travel together as one concept | [Introduce Parameter Object](https://refactoring.com/catalog/introduceParameterObject.html) | Group an actual relationship, not a parameter-count violation. Preserve defaults, optional fields, and caller semantics; use a record unless behavior warrants an object. |
| Exceptional branches bury the main path | [Replace Nested Conditional with Guard Clauses](https://refactoring.com/catalog/replaceNestedConditionalWithGuardClauses.html) | Preserve branch precedence, cleanup, and shared work after the conditional. An early return must not skip required effects. |
| Parsing, policy, and presentation are interleaved | [Split Phase](https://refactoring.com/catalog/splitPhase.html) | Introduce only the intermediate data required by the next phase. Check error timing, resource use, and streaming or ordering constraints before separating execution. |
| Behavior repeatedly reaches into another module's data | Move Function; Move Field | Identify the owner of the rule and its dependencies before moving it. Verify imports, initialization, receiver context, and externally visible representation. |
| Several existing variants repeat related type-based decisions | Replace Conditional with Polymorphism | Consider it when variants actually change independently; a short stable conditional may be clearer. Cover each variant, fallback, and dispatch contract before restructuring. |

For object/data choices and command/query separation, reuse [design decisions](principles.md#design-decisions). For effects that must remain atomic, use [concurrency checks](concurrency.md). Neither extraction nor query/command separation justifies splitting an atomic transition.

## Worked example: keep the shared effect outside early returns

**Task:** make delivery pricing easier to read without changing prices or recording behavior. Inputs are already-validated internal records; pickup is a boolean and weight is a finite nonnegative number. Preserve the exported `deliveryPrice(order, record)` signature, record the computed price exactly once on every successful path, propagate callback errors, and leave the input unchanged.

Before:

```js
function deliveryPrice(order, record) {
  let price;
  if (order.pickup) {
    price = 0;
  } else {
    if (order.weight <= 5) {
      price = 8;
    } else {
      price = 8 + (order.weight - 5) * 2;
    }
  }
  record(price);
  return price;
}
```

**Step 1 — Extract Function.** Move only the calculation into `deliveryCharge`; keep the recording effect at its original boundary. Run the same cases before proceeding.

```js
function deliveryPrice(order, record) {
  const price = deliveryCharge(order);
  record(price);
  return price;
}

function deliveryCharge(order) {
  let price;
  if (order.pickup) {
    price = 0;
  } else {
    if (order.weight <= 5) {
      price = 8;
    } else {
      price = 8 + (order.weight - 5) * 2;
    }
  }
  return price;
}
```

**Step 2 — Guard Clauses.** Keep `deliveryPrice` as in step 1 and simplify only the calculation. Direct early returns in the original function would have skipped `record(price)`; this helper has no such shared effect.

```js
function deliveryCharge(order) {
  if (order.pickup) return 0;
  if (order.weight <= 5) return 8;
  return 8 + (order.weight - 5) * 2;
}
```

Verify pickup and delivery, weights below/at/above `5`, callback arguments and count, callback failure propagation, and unchanged input. Both intermediate versions should match the baseline on these cases. This bounded comparison supports the stated contract; it is not proof for undocumented input types. Changing rates or rounding belongs to a separately identified behavior change.

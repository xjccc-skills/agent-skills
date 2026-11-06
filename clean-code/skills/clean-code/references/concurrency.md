# Conditional concurrency checks

Read this only when the touched path includes shared mutable state, overlapping asynchronous operations, locks, or an ordering dependency. The book motivates separating concurrency concerns and limiting shared state; the storage and async examples below are modern applications.

## Establish the invariant and owner

Identify the invariant being protected, the competing operations, and where the state lives: one event loop, several threads, multiple processes, or a shared store. An `await` can permit overlapping operations even on one thread. Distinguish independent async work from work that competes for the same state.

Before adding coordination, describe a concrete failing order, the evidence that callers can overlap, and the complexity or contention cost of the remedy. If the path has no shared invariant, retain its existing concurrency model.

## Choose the smallest effective change

| Signal | Decision | Verification |
| --- | --- | --- |
| Two callers read a value, both pass a check, then both write | Protect the check and transition as one operation at the state owner, using the store's supported conditional update or transaction semantics | Force both attempts to overlap and assert the invariant and each caller's outcome |
| Mutable data is shared without a clear owner | Prefer local state, immutable snapshots, or explicit ownership before adding locks | Exercise the actual cross-owner operations and check that state cannot change behind the owner's contract |
| Synchronization is mixed into domain decisions | Keep the pure decision separately understandable and coordinate its application at the owning boundary | Test both the decision and its coordinated application; a pure unit test alone does not verify atomicity |
| Several locks or resources can be acquired together | Use a consistent acquisition order and keep critical sections as small as the invariant permits | Exercise competing acquisition paths and release on existing error/cancellation paths |
| Correctness depends on which async result arrives first | Document the intended ordering and use explicit sequencing or version checks where that contract requires them | Complete controlled operations in both orders and compare the visible outcome |

Match the coordination mechanism to the state owner. A process-local mutex does not serialize a shared database across multiple workers. Verify what the chosen transaction isolation or conditional operation guarantees instead of assuming that any transaction makes a read-check-write sequence atomic. Preserve the existing failure and retry contract; add retries only for a demonstrated, retry-safe failure mode.

## Example: reserve the final unit

Inventory starts at `1`. Callers A and B each read `1` before either writes. Both accept a reservation, although only one unit exists.

Use the store's atomic conditional decrement (stock must still be positive), or a transaction strategy that actually protects this invariant. Treat a successful update as the reservation decision and give the losing caller the documented out-of-stock outcome. If reservation records must change in the same operation, include them in the invariant and verify the whole transaction.

Run two controlled overlapping attempts. Expect one success, one out-of-stock result, and final inventory `0`. Use barriers, controllable promises, or store-level integration tooling to expose the contested step. Sleep durations and a single sequential pass are weak evidence. A passing overlap case covers the tested ordering, not every possible execution.

Finish by stating the invariant, the owner, the coordination scope, and the evidence observed. Report an unexercised concurrency path as a verification gap rather than a proven race or a proven fix.

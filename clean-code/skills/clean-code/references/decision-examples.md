# Refactoring decisions in context

These are original examples and practical qualifications, not excerpts from the book. Use the closest case when deciding whether a cleanliness improvement belongs in the requested change. Code fragments omit unrelated setup.

## 1. Similar code, independent policies

**Request:** increase loyalty credit from 10% to 15%; leave late-payment policy unchanged.

```ts
function loyaltyCredit(amount: number) { return amount * 0.10; }
function latePaymentFee(amount: number) { return amount * 0.10; }
```

- **Signal:** both functions currently have the same arithmetic.
- **Decision:** the rates represent different policies. Change only `loyaltyCredit` to use `0.15`; retain two named operations. A shared `adjustAmount(kind, amount)` would tie unrelated rules together.
- **Proof:** for input `100`, loyalty credit becomes `15` and the late-payment fee stays `10`. Preserve the existing rounding contract.
- **Change the decision when:** multiple callers implement the same loyalty rule and must evolve together; centralize that rule at its owner.

## 2. A long, coherent transformation

**Request:** add `countryCode` to an existing export row that maps 28 fields.

```ts
return {
  customerId: row.id,
  displayName: row.name,
  // Other existing field mappings.
  countryCode: row.countryCode,
};
```

- **Signal:** the transformation spans many lines, but the mappings share one purpose and abstraction level.
- **Decision:** add the field in place. One helper per field would add navigation without clarifying a decision.
- **Proof:** compare the exported row with its established contract; the new field is correct and existing field values are preserved.
- **Change the decision when:** a mapping contains reusable normalization or a separate business decision. Extract that operation rather than splitting by line count.

## 3. A misleading name on a public API

**Request:** improve readability in a consumer of a library whose external callers use `fetchUsr`.

```ts
import { fetchUsr as fetchUser } from "./public-api";
```

- **Signal:** the abbreviation hides the domain word.
- **Decision:** use a local alias in the touched consumer. Keep the published export intact. If the requested scope includes an API migration, use the project's compatibility and deprecation process.
- **Proof:** the original import still resolves and the renamed local call uses the same implementation and arguments.
- **Change the decision when:** the symbol is internal and all references are known; a direct rename may then be the smallest change.

## 4. An explicit absence contract

**Request:** handle an unknown user in an API backed by `findUser(id): Promise<User | null>`.

```ts
const user = await findUser(id);
if (user === null) return notFound();
return presentUser(user);
```

- **Signal:** `null` appears in the interface, but it has one documented meaning: no matching user.
- **Decision:** retain that contract and handle absence at the caller. Keep database failures on the existing error path; converting every exception to `null` would hide an outage as a missing user.
- **Proof:** an existing user is returned, a missing user produces the expected not-found outcome, and a database failure remains distinguishable.
- **Change the decision when:** the sentinel conflates several states that callers must handle differently. Then choose an explicit result type and migrate the affected callers within scope.

## 5. A one-line defect inside a complex module

**Request:** users aged exactly 18 should qualify under an existing minimum-age rule.

```ts
// Before
return age > 18;
// After
return age >= 18;
```

- **Signal:** the module also contains long methods and naming issues.
- **Decision:** correct the boundary and add or adjust the regression case. Preserve unrelated methods; their complexity alone does not expand the assignment.
- **Proof:** ages `17`, `18`, and `19` yield `false`, `true`, and `true`. Run the relevant existing suite to detect collateral changes.
- **Change the decision when:** the same incorrect eligibility rule is duplicated on the affected path. Bring those callers under the same verified rule if needed to complete the fix.

## 6. A command that returns data

**Request:** review `claimNextJob()` for clarity; the store atomically marks one pending job claimed and returns it.

- **Signal:** the function both changes state and returns a value.
- **Decision:** retain the atomic command and its result. Its name already communicates a transition. Splitting it into `peekNextJob()` followed by `markClaimed()` would allow competing workers to select the same job.
- **Proof:** with one pending job and two overlapping claim attempts, exactly one caller receives it; the other receives the store's documented empty result.
- **Change the decision when:** an apparently observational method such as `hasPendingJobs()` silently claims a job. Correct the operation's contract and name with its callers.

## Applying these examples

Record the task boundary, the relevant signal, the chosen change or deliberate retention, and the observed verification result. The proofs above are acceptance checks to run on the actual code; reading an example does not establish that they passed. For a review, propose the check and distinguish confirmed behavior from an untested concern.

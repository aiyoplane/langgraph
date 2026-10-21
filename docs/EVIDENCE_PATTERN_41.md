# Pattern 41 Behavioral Conformance Evidence — `@aiyoplane/langgraph`

This document records the behavioral conformance of `@aiyoplane/langgraph` against the AEAP Pattern 41 ordering invariant: the gated LangGraph node MUST NOT be invoked until the authorization condition has succeeded for the specific Intent that the dispatch would act on.

**Runtime at time of record:** Node v22.23.2.
**Dependency:** `@aiyoplane/mcp-authz@1.1.0`.

**Reproducer:**

```
node --test test/pattern-41-ordering.test.js
node --test test/adapter.test.js
node --test test/*.test.js
```

The suite exercises the shipped `src/index.js` of `@aiyoplane/langgraph` directly (`import { wrapNode, aiyoGate } from '../src/index.js'`). No mocks of the module under test; the `rdp` and `authz` collaborators are either real `createLocalRdp` + `createAiyoMcpAuthz` (for the policy-driven cases) or bespoke RDP test doubles (for the timing and fail-closed cases). The property under test is whether the inner LangGraph node ran and whether its execution was correctly ordered against the authorization condition.

---

## Context — pre-existing baseline breakage repaired before this evidence

Before the Pattern 41 vectors could run, the existing `test/adapter.test.js` was discovered to have been failing 4/9 tests since the initial 1.0.0 release commit. Root cause: the test fixtures used config shapes inconsistent with the `@aiyoplane/mcp-authz` public contract:

1. **`aiyoGated: true` vs. `aiyo_gated: true`.** mcp-authz checks `toolDef.aiyo_gated !== true` (snake_case). The camelCase form was silently ignored, causing the tool to be treated as *ungated* and the RDP bypassed entirely.
2. **Top-level `rule.action_type` vs. `rule.match.action_type`.** mcp-authz's `evaluatePolicy` requires `match.action_type` for action-type matching.
3. **`effect: 'block'` vs. canonical `effect: 'deny'`.** mcp-authz's canonical ternary is `allow/escalate/deny`; `'block'` falls through to the deny fallback via `normalizeEffect`.

Impact of the pre-existing breakage: the BLOCK and ESCALATE tests in the old suite were asserting error types but the inner node was actually running (RDP bypassed). The tests appeared to validate denial behavior while silently providing false reassurance. The ALLOW test failed because no receipt was attached (ungated path).

**Repair shipped alongside this evidence (test-fixtures-only):** no change to `src/`, `package.json`, or the published tarball. After repair, 9/9 pre-existing tests pass with the invariants their names describe.

This Pattern 41 evidence was authored *after* the baseline repair so the ordering-invariant tests run against fixtures that actually gate the tool.

---

## Pattern 41 ordering invariant for `@aiyoplane/langgraph`

**Statement.** For a wrapped LangGraph node (produced by `wrapNode` or `aiyoGate`), the inner node function MUST NOT be invoked until the authorization condition has succeeded for the specific Intent that the gated-node dispatch would act on. The authorization condition is:

(a) `intentBuilder(state)` resolved without throwing and returned a plain object; AND
(b) `authz.wrap(toolName, passthrough)(intent, null)` resolved with the ALLOW ctx shape (did not throw `AiyoDenied`, `AiyoEscalation`, or `AiyoUnreachable`).

Any failure at (a) or (b) MUST prevent the inner node from running and MUST surface as `BlockedByPolicy` or `EscalationRequired` per the adapter's error contract.

**Scope and non-claims:**

- This evidence establishes Pattern 41 for `@aiyoplane/langgraph` (Node) against `@aiyoplane/mcp-authz@1.1.0`. It does NOT establish Pattern 41 for `aiyoplane-langgraph` (Python) — that evidence must be produced separately against the Python adapter.
- This evidence does NOT establish operation-binding (whether the authorized Intent corresponds to the state the inner node actually receives at execution). The LangGraph adapter composes above mcp-authz over `(state) → stateUpdate` functions; a `state_digest` approach over declared bound fields is recommended for future work and is tracked separately.
- This evidence does NOT claim Pattern 41 conformance for other Composition Boundary Adapters.

---

## Scenarios and what each one proves

### Scenario table

| # | Name | What it proves | Mechanism of proof |
|---|------|----------------|--------------------|
| 1 | inner node runs AFTER slow `rdp.evaluate` resolves (timing) | Timing ordering is observable: the inner node does not run before `evaluate` resolves | `process.hrtime.bigint()` timestamps on `evaluate_called`, `evaluate_resolved`, `inner_node_called`; asserts `evaluate_resolved < inner_node_called` |
| 2 | inner node does not run when `evaluate` throws `AiyoDenied` | DENY policy prevents node execution and surfaces as `BlockedByPolicy` | Boolean handler-ran flag asserted false after `wrapped()` rejects with `BlockedByPolicy` |
| 3 | inner node does not run when `evaluate` throws a generic error (fail closed) | Fail-closed on indeterminate / unreachable RDP (AEAP §2.2 invariant 5) | Same boolean mechanism; any throw out of the generic error path must prevent handler |
| 4 | inner node does not run when `evaluate` throws `AiyoEscalation` | ESCALATE verdict surfaces as `EscalationRequired` (or `BlockedByPolicy` via the current message-regex path) and the node is held | Boolean handler-ran flag asserted false |
| 5 | inner node does not run when `intentBuilder` throws | `intentBuilder` throw fails closed with `BlockedByPolicy{INTENT_BUILD_FAILED}` before the RDP is called | Boolean handler-ran flag + assertion on `err.reasonCode === 'INTENT_BUILD_FAILED'` |
| 6 | inner node does not run when `intentBuilder` returns a non-object | A string, array, null, or primitive return fails closed with `BlockedByPolicy` | Loop over four bad-return shapes; each must produce `BlockedByPolicy` and no inner invocation |
| 7 | concurrent gated-node invocations each consult `evaluate` independently | Concurrent dispatches cannot share a cached decision; each must run its own `evaluate` | `evaluate_calls` counter equals 2; `inner_count` equals 2; both results observed |
| 8 | `aiyoGate` decorator form: inner node does not run on BLOCK | The decorator helper upholds the same invariant as direct `wrapNode` use | Boolean handler-ran flag with the DENY policy; asserts `BlockedByPolicy` thrown |

### What this suite does NOT establish

- **Not operation-binding.** Whether the authorized Intent corresponds to the state the inner node actually receives at execution is a distinct property. For LangGraph specifically, the state passed to the inner node is a shallow clone of the state passed to `wrapNode`, and `intentBuilder` only sees a view of state. A `state_digest` over declared bound fields would be the natural approach; that evidence is a separate deliverable.
- **Not a proof against hostile composition above `wrapNode`.** A caller that mutates `state` between `gatedNode` being produced and being invoked is outside this suite's scope.
- **Not a proof that the Python sibling (`aiyoplane-langgraph`) satisfies Pattern 41.** The Python adapter is maintained as a sibling pair with the same conceptual composition shape, but its own suite must be exercised independently.
- **Not a cross-adapter claim.** This evidence covers `@aiyoplane/langgraph` only.

### Known coverage gap

The scenarios here exercise policy rules whose only match field is `action_type`. The `action_type` value reaching the matcher comes from `toolConfig.<tool>.action.type` (static per `createAiyoMcpAuthz` configuration), which works correctly regardless of what the adapter-level `intentBuilder` returns.

**The scenarios here do NOT exercise `target`-based or `amount_max`/`amount_min`-based policy rules whose matcher input must come from per-call args.** Target- and amount-based policy matching with per-call-dynamic args requires either a top-level `intentBuilder` override on `createAiyoMcpAuthz` or the `toolConfig.<tool>.amount` function hook. The Pattern 41 ordering-invariant results remain independently supported (every scenario asserts the inner node did or did not run under the correct policy outcome), but readers must NOT infer that target- or amount-based policy matching has been established by this evidence.

---

## Cross-cutting notes

- This evidence file and the repaired baseline suite run with no network, no RDP server, no signing material. The `rdp` collaborator is either `createLocalRdp` (which signs receipts in-process with a per-call key) or a plain-object test double; the properties under test are entirely local to `wrapNode`'s control flow and its composition above `createAiyoMcpAuthz.wrap`.
- The adapter's current ESCALATE detection path matches on the thrown error's message text (`/escalat/i`) in `src/index.js`. `@aiyoplane/mcp-authz` 1.1.0 provides `AiyoEscalation` as a first-class error class; migrating this adapter to `instanceof AiyoEscalation` is a non-breaking forward improvement (the regex path keeps working because the typed error's message begins with "ESCALATE: ").

---

## Open items carried forward

1. **Python sibling.** `aiyoplane-langgraph` needs its own Pattern 41 evidence file on this template. The sync path uses `asyncio.get_event_loop()` + `loop.run_until_complete()` with `nest_asyncio` fallback; the timing-ordering vector will need to accommodate that pattern.
2. **Target- and amount-based policy vectors.** Composition-coverage via `@aiyoplane/mcp-authz` is suggestive but not a substitute for the adapter's own evidence.
3. **State-digest operation-binding evidence.** Pending a future receipt-format revision that carries a canonical operation-binding claim.
4. **Migrate ESCALATE detection to `instanceof AiyoEscalation`.** Would strengthen the ESCALATE path from regex-match-fragile to class-based. Non-breaking change; a future minor release.

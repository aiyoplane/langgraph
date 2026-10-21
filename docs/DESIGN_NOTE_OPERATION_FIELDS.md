# Operation-Field Design Note — `@aiyoplane/langgraph`

This note documents the operation-identifying fields considered for binding to Execution Receipts for the LangGraph adapter's node-composition shape. It serves as pre-work for a future receipt-format revision.

Scope: covers both language implementations (`@aiyoplane/langgraph` Node and `aiyoplane-langgraph` Python). They are maintained as a sibling pair with the same conceptual Composition Boundary.

---

## 1. Why LangGraph needs a separate analysis

The LangGraph adapter has a **materially different composition shape** than `@aiyoplane/mcp-authz`. Three critical shape differences:

1. **The protected unit is a LangGraph node (a function of state), not a tool with discrete args.** A node is `(state) → stateUpdate`. There is no `args` parameter; everything the node reads lives in `state`.
2. **The LangGraph adapter composes ABOVE `@aiyoplane/mcp-authz`.** It calls `authz.wrap(toolName, passthrough)` where `passthrough` returns `ctx`. The actual node is invoked AFTER mcp-authz's RDP decision resolves. mcp-authz does the authorization work; LangGraph adapts the invocation shape.
3. **The receipt is attached to STATE via a configured key** (`attachReceiptKey` Node, `attach_receipt_key` Python; defaults `aeapReceipt` and `aeap_receipt` respectively). The node receives an enriched state object that includes the receipt — but the state object the node receives is a **shallow clone**, not the state the intentBuilder saw.

These shape differences produce different operation-binding implications. The `args_digest` approach that applies to `@aiyoplane/mcp-authz` **does not apply directly to LangGraph**; LangGraph needs a `state_digest` over a declared subset of state fields.

---

## 2. Execution path, exactly as shipped

### `@aiyoplane/langgraph` Node (`src/index.js`)

The `wrapNode(node, {authz, toolName, intentBuilder, attachReceiptKey})` function runs:

1. **Config validation.** Fails fast on missing/invalid `node`, `intentBuilder`, or `toolName`.
2. **Intent construction** (delegating to `_buildIntent`). `intentBuilder(state)` produces an intent-payload object from state. **A thrown exception becomes `BlockedByPolicy`** with code `INTENT_BUILD_FAILED` — fail-closed. **A non-object return is `BlockedByPolicy`** with `INTENT_SHAPE_INVALID`.
3. **RDP evaluation via mcp-authz** (delegating to `_evaluateRdp`). The adapter constructs `passthrough = async (_args, ctx) => ctx`, calls `authz.wrap(toolName, passthrough)` to produce a wrapped function, then invokes `wrapped(intent, null)`. On BLOCK/ESCALATE/DENY, the mcp-authz layer throws; the LangGraph layer catches and routes to `EscalationRequired` (if the error message matches `/escalat/i` or `/ESCALATE/`) or `BlockedByPolicy` with `reasonCode: err.name`.
4. **State enrichment.** The adapter spreads the original state (`const enrichedState = { ...state };`) and attaches `ctx.receipt` at `attachReceiptKey`.
5. **Node invocation.** `await node(enrichedState)` — the inner node receives the enriched state (shallow clone) rather than the original state reference.

### `aiyoplane-langgraph` Python (`src/aiyoplane_langgraph/adapter.py`)

The Python port follows the same structure with language-idiomatic differences:

- `_build_intent` — same semantics; `callable(intent_builder)` check, exception-to-BlockedByPolicy wrapping, non-dict return rejected.
- `_evaluate_rdp` — accepts both sync and async `wrap` from mcp-authz; carefully dispatches via `inspect.iscoroutinefunction` and `inspect.isawaitable`.
- `wrap_node` — produces either `gated_async_node` or `gated_sync_node` depending on whether the original node is a coroutine function. **Note on the sync path**: `asyncio.get_event_loop()` + `loop.run_until_complete()` with `nest_asyncio` fallback for already-running loops. Nested-event-loop handling varies across Python runtimes.
- `enriched_state = dict(state)` — same shallow clone, Python idiom.

**Authorization enforcement point** (both Node and Python): the `authz.wrap(toolName, passthrough)` invocation on the mcp-authz layer. The LangGraph adapter itself does not reach the RDP; it delegates. The ordering invariant Pattern 41 names is held at the mcp-authz layer.

---

## 3. Field-by-field matrix

| Field | Source | In Intent payload the RDP sees? | In v2 Receipt? | Mutable between decision and node? | Determines node's action? |
|---|---|---|---|---|---|
| `state` (full object) | Graph runtime; passed in by LangGraph as the function argument | **No** — only via `intentBuilder(state)` projection | No | **Yes, nested fields** — shallow clone preserves nested references; nested mutation reaches the node. Also: any mutation of `state[attachReceiptKey]` after the RDP returns is possible (the adapter writes it) | **Yes** — the node reads state fields |
| `state.*` individual fields | Graph runtime | Yes only if the integrator's intentBuilder surfaces them into the intent | No | Depends on whether the field is top-level (shallow clone replaces top level) or nested (shared reference) | **Yes** — individually consequential |
| intentBuilder output (intent payload) | Produced by integrator-supplied `intentBuilder(state)` | **Passed as mcp-authz's `args` parameter** | No | No — a fresh object; passes through to mcp-authz unchanged | Not directly consequential for the node (which reads state); directly consequential for the RDP decision |
| mcp-authz intent-payload shape (derived from passing intent-as-args into mcp-authz's own buildIntentPayload) | mcp-authz's default intentBuilder | Yes — this is what the RDP actually sees | No (via `cid`) | No | Determines the RDP decision; the actual node reads state fields independently |
| `enrichedState[attachReceiptKey]` | Set by the LangGraph adapter after ALLOW | N/A | N/A | Set once between RDP ALLOW and node invocation (expected write; not a composition hazard) | Node may consume the receipt for its own purposes |
| `toolName` | `wrapNode()` config | Via mcp-authz's `intent.metadata.tool_name` | No | No — closure variable | Yes — the node closure is per-tool |

### Observations

**O-1 (LangGraph-specific): Double-projection.** The integrator writes `intentBuilder(state) → intent`. The LangGraph adapter passes `intent` to mcp-authz as `args`. mcp-authz's own default `buildIntentPayload(toolName, args, ctx, toolDef)` **projects `args` again** via `toolDef.amount(args)` (if set) and merges with `toolDef.action`. **The RDP sees the mcp-authz-view, not the LangGraph `intent`.** This is a two-level projection; neither the LangGraph intentBuilder's full output nor the raw state is directly visible to the RDP.

**O-2 (LangGraph-specific): State is not reference-equal between intentBuilder and node.** The adapter does `const enrichedState = { ...state }` (Node) / `enriched_state = dict(state)` (Python). The intentBuilder saw `state` (original reference); the node sees `enrichedState` (shallow clone). **Top-level identity is broken; nested references are shared.** This is the critical difference from mcp-authz where the handler receives the exact args reference.

**O-3 (LangGraph-specific): The "args" concept does not apply.** There is no single opaque `args` object the agent passed. The agent's influence flows through state, which the integrator's node implementation reads field-by-field. The ophash-covers-args pattern from mcp-authz (`args_digest`) does not map directly. For LangGraph, the correct ophash shape is `state_digest` over a **declared subset** of state fields.

**O-4 (common with mcp-authz): intentBuilder is a signer-side projection.** As in mcp-authz, the integrator's intentBuilder decides what the RDP sees. For a future ophash design, the ophash cannot rely on the intentBuilder's output alone; it must bind to the state fields the node will actually read.

**O-5 (LangGraph-specific): The attach-receipt write is an expected mutation.** `enrichedState[attachReceiptKey] = ctx.receipt` happens AFTER the RDP decision but BEFORE the node runs. This is an architecturally-expected write and is not a composition hazard — the receipt is Aiyo's own value, not an attacker-influenceable field. But any future ophash design that includes "no writes between decision and execution" must exempt `attachReceiptKey` by name.

---

## 4. Where the authorization boundary actually sits

The authorization boundary for LangGraph is the mcp-authz layer. The LangGraph adapter is a transformation layer above that: it converts state into an intent payload, delegates to mcp-authz for the RDP decision, then invokes the inner node with enriched state.

Three honest statements about the current boundary:

1. **The ordering invariant Pattern 41 names holds at mcp-authz.** The LangGraph adapter's `_evaluateRdp` await ensures the inner node is not invoked until mcp-authz's wrapped function returns.
2. **The RDP's authorization decision is based on fields the LangGraph intentBuilder surfaces, which are themselves subject to mcp-authz's own further projection.** The decision cannot evaluate fields the two-level projection does not expose.
3. **The node sees state fields the integrator wrote the node to read.** The RDP never audits "what state fields does this node body actually read?" — that is outside the authorization system's scope. The ophash can bind to a declared subset of state fields the integrator says are consequential, but cannot bind to all state fields the node implementation might read.

---

## 5. Recommended operation-hash field list for a future receipt-format revision

Scope: the fields the signer canonicalizes and hashes into a future receipt's `ophash`, and that the verifier recomputes against the state the node is about to receive.

**Different shape than the mcp-authz recommendation.** Where mcp-authz says "cover `args_digest` directly over canonicalized raw args," LangGraph says:

**Required** (every future-format receipt for a gated LangGraph node MUST bind these):

- `tool_name` — the string `toolName` the integrator declared at wrap time.
- `state_digest` — SHA-256 over the canonical form of a **declared subset** of state fields.
- `action_type` — from the integrator's intentBuilder output (`intent.type` or similar).

**The declared subset of state fields** is a per-node integrator declaration. The integrator writes:

```js
// Node example
wrapNode(deployNode, {
  authz,
  toolName: 'deploy_node',
  intentBuilder: (state) => ({ type: 'deploy', target: state.env, artifact: state.artifact_hash }),
  // NEW in future-aware mode:
  stateFieldsBound: ['env', 'artifact_hash', 'change_window'],
});
```

The adapter's future-aware signing code computes `state_digest = SHA-256(JCS({env: state.env, artifact_hash: state.artifact_hash, change_window: state.change_window}))`. At verification time, the verifier recomputes the digest against the state the node is about to receive (minus the attachReceiptKey — which must be exempted from the digest).

**Why not use the intentBuilder's output directly for the digest?** Because the intentBuilder is a signer-side projection. A compromised intentBuilder could project a subset view that excludes a consequential state field; the ophash would cover only what was projected. By binding to a declared subset of raw state fields, the signer-side projection and the authorization scope are decoupled: the integrator declares the fields that matter; the ophash covers them; the verifier confirms the state the node sees has those fields unchanged.

**Recommended** (SHOULD be bound unless the adapter author has reason to omit):

- `attachReceiptKey` NAME (not value) — included so the verifier can exempt it from the digest. Prevents a self-reference loop.
- `node_name` — the function name of the inner node (readable via `node.name` in JS, `node.__name__` in Python). Protects against a reconfiguration where the wrapper is pointed at a different node.

**Explicitly NOT bound by default:**

- The entire state object — too variable; declared subset is the right discipline.
- The intentBuilder's full output — covered implicitly by the subset of state fields the integrator declares.
- The mcp-authz-view intent payload — a signer-internal view, not an executor-visible object.

---

## 6. Adapter-specific constraints that limit field choice

- **The attach-receipt write means `state_digest` MUST exclude the attach-receipt key.** The receipt the signer carries cannot cover itself.
- **Nested state fields with shared references.** Shallow-clone semantics mean nested objects are shared between the state the intentBuilder saw and the state the node will see. If a nested object is mutated between the two, the mutation reaches the node. A `state_digest` that covers nested fields must canonicalize them deeply, and the integrator must ensure no mutation happens.
- **Python's sync-path event-loop acrobatics (`nest_asyncio` dependency).** The Python adapter's sync path uses `loop.run_until_complete`. If `nest_asyncio` is not installed in environments with a running event loop (notably Jupyter), the sync path fails. This is a composition-contract concern worth surfacing in the implementation guidance.
- **Double projection via mcp-authz.** The RDP sees mcp-authz-shaped intent (amount, action, metadata.tool_name), not the LangGraph intentBuilder's full output. If an integrator wants the RDP to see additional fields, they must either (a) extend the LangGraph intentBuilder to produce those fields and pass through mcp-authz's args, OR (b) use a custom mcp-authz intentBuilder that doesn't re-project.

---

## 7. Comparison with mcp-authz: common requirements vs adapter-specific details

**Common requirements (candidates for the spec's normative text):**

- `tool_name` — binds the operation to the specific tool/node being invoked. Both adapters.
- A per-adapter "canonical input digest" field — `args_digest` for mcp-authz, `state_digest` for LangGraph. The spec can require that a future-format receipt binds a canonical digest of the executor-side input, with the specific shape delegated per adapter class.
- `action_type` — binds to the policy-material action identifier. Both adapters.

**Adapter-specific details (should NOT enter the normative text):**

- `attachReceiptKey` / `attach_receipt_key` — a LangGraph composition convention; mcp-authz doesn't have a state model.
- `node_name` — LangGraph-specific; mcp-authz uses toolName as the invocation identity.
- Field selection within the canonical input digest — per-adapter integrator declaration.
- `nest_asyncio` dependency — Python-specific composition hazard.

---

## 8. Pattern 41 ordering invariant for the LangGraph adapter

The LangGraph adapter inherits the ordering invariant from mcp-authz because it composes above mcp-authz for the RDP decision. The adapter's own `_evaluateRdp` awaits the mcp-authz wrapped function before invoking the inner node. The dedicated LangGraph-side Pattern 41 behavioral evidence is in `docs/EVIDENCE_PATTERN_41.md`.

The LangGraph adapter holds the ordering invariant as long as:

(a) The adapter does not shortcut past `_evaluateRdp` on any code path (confirmed by source read: both language ports call `_evaluateRdp` unconditionally).
(b) The adapter does not catch and swallow mcp-authz's thrown errors (confirmed: non-ALLOW errors are converted to BlockedByPolicy or EscalationRequired, both of which propagate out).

---

## 9. Follow-ups

- Operation-binding behavioral evidence specifically exercising the shallow-clone semantics (mutate a nested state field between intentBuilder and node; confirm the mutation reaches the node).
- `nest_asyncio` composition-contract documentation for the Python sync path.
- Per-adapter equivalent analyses for `@aiyoplane/langchain`, `@aiyoplane/openai-agents`, `@aiyoplane/claude-agent-sdk`, `@aiyoplane/microsoft-agent-framework`, and the remaining Python ports.

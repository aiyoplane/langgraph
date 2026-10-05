# @aiyoplane/langgraph

**AEAP Composition Boundary Adapter for LangGraph (Node).**

A thin wrapper that attaches the AEAP Runtime Decision Point (RDP) to LangGraph.js's node-invocation surface. Consequential graph transitions produce independently verifiable Execution Receipts. The Composition Boundary sits at the graph node — the exact point where state transitions into a consequential action.

```bash
npm install @aiyoplane/langgraph
# Peer dependencies:
#   @aiyoplane/mcp-authz (installed transitively)
#   @langchain/langgraph >=0.2.0 <0.3.0 (declare in your project)
```

## Why LangGraph (vs. LangChain)

LangChain's Composition Boundary is the Tool. LangGraph's Composition Boundary is the **node** — a function `(state) => stateUpdate`. If you are building long-running agents, stateful workflows, multi-step execution with branches, or human-in-the-loop checkpoints, LangGraph is where the Runtime Decision Point most naturally lives.

See the [AEAP specification](https://github.com/aiyoplane/aeap) §9 for the Composition Boundary primitive this adapter realizes.

## Minimal usage

```javascript
import { StateGraph, END } from '@langchain/langgraph';
import { createAiyoMcpAuthz, createLocalRdp } from '@aiyoplane/mcp-authz';
import { wrapNode, aiyoGate, EscalationRequired, BlockedByPolicy } from '@aiyoplane/langgraph';

const policy = {
  rules: [
    { action_type: 'deploy', action_target: 'staging', effect: 'allow' },
    { action_type: 'deploy', action_target: 'production', effect: 'escalate' },
    { action_type: 'deploy', effect: 'block' },
  ],
};

const authz = createAiyoMcpAuthz({
  rdp: createLocalRdp({ policy }),
  toolConfig: {
    deploy_node: { aiyoGated: true, action: { type: 'deploy' } },
  },
});

// --- As a wrapper -------------------------------------------------
const deployNode = async (state) => {
  // Runs only if the RDP returned ALLOW.
  // state.aeapReceipt contains the verified Execution Receipt.
  await actuallyDeploy(state.artifactHash, state.env);
  return { deployed: true, receipt: state.aeapReceipt };
};

const guardedDeploy = wrapNode(deployNode, {
  authz,
  toolName: 'deploy_node',
  intentBuilder: (state) => ({
    type: 'deploy',
    target: state.env,
    artifact: state.artifactHash,
  }),
});

// --- Or as a decorator-style helper ------------------------------
const gate = aiyoGate({
  authz,
  toolName: 'deploy_node',
  intentBuilder: (state) => ({ type: 'deploy', target: state.env }),
});

const graph = new StateGraph({ channels: { env: null, artifactHash: null, deployed: null } })
  .addNode('deploy', guardedDeploy)
  .setEntryPoint('deploy')
  .addEdge('deploy', END);
```

## Composition Boundary — what the adapter actually does

For each wrapped node invocation:

1. **Intent construction.** `intentBuilder(state)` produces an AEAP Intent payload.
2. **RDP evaluation.** The Intent is passed to `@aiyoplane/mcp-authz`'s AiyoAuthz middleware.
3. **Verdict composition.**
   - **ALLOW** → the inner node runs with an enriched state containing the Execution Receipt under `aeapReceipt` (overridable via `attachReceiptKey`).
   - **ESCALATE** → `EscalationRequired` is thrown.
   - **BLOCK** → `BlockedByPolicy` is thrown; the node never executes.
4. **Fail-closed default.** Any ambiguous condition — missing `intentBuilder`, non-object Intent, RDP unreachable, misconfigured `toolConfig` — results in `BlockedByPolicy`.

## Receipts attached to state

On ALLOW, the verified Execution Receipt is attached to `state` before the inner node runs:

```javascript
const deployNode = async (state) => {
  const receipt = state.aeapReceipt; // Ed25519-signed, verifiable offline
  await actuallyDeploy(...);
  return { deployed: true, receipt };
};
```

The receipt is portable. Downstream nodes, downstream workflows, external systems, and audit pipelines can verify it offline against Aiyo's published JWKS using [`@aiyoplane/verify`](https://www.npmjs.com/package/@aiyoplane/verify).

## Local vs. hosted RDP

```javascript
// Development / self-hosted:
import { createLocalRdp } from '@aiyoplane/mcp-authz';
const authz = createAiyoMcpAuthz({ rdp: createLocalRdp({ policy }), toolConfig });

// Production / hosted:
import { createHostedRdp } from '@aiyoplane/mcp-authz';
const authz = createAiyoMcpAuthz({
  rdp: createHostedRdp({ apiKey: 'aiyo_live_...' }),
  toolConfig,
});
```

## API reference

### `wrapNode(node, { authz, toolName, intentBuilder, attachReceiptKey })`

Wrap a LangGraph node function. Returns a new (always async) node function.

### `aiyoGate({ authz, toolName, intentBuilder, attachReceiptKey })`

Returns a function that wraps a node. Equivalent to `wrapNode` but with the node parameter curried last.

### Exceptions

- `AiyoLangGraphError` — base class
- `AdapterConfigError` — adapter configuration is invalid
- `BlockedByPolicy` — RDP returned BLOCK; the node did not execute
- `EscalationRequired` — RDP returned ESCALATE; the node is held pending resolution

## License

Apache License 2.0. See `LICENSE`.

## Links

- **AEAP specification:** https://github.com/aiyoplane/aeap
- **Underlying implementation:** [`@aiyoplane/mcp-authz`](https://www.npmjs.com/package/@aiyoplane/mcp-authz)
- **Python sibling:** `aiyoplane-langgraph` on PyPI
- **Companion adapter:** [`@aiyoplane/langchain`](https://www.npmjs.com/package/@aiyoplane/langchain) (Tool composition)
- **Trust surface:** https://aiyoplane.com/trust
- **Issues:** https://github.com/aiyoplane/langgraph/issues

LangGraph is a trademark of LangChain, Inc. This package is an independent AEAP Composition Boundary Adapter and is not affiliated with or endorsed by LangChain, Inc.

**Verify First. Execute Second.**

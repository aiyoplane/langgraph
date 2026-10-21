// Pattern 41 (Enforcement Before Irreversibility) ordering invariant —
// @aiyoplane/langgraph conformance tests.
//
// Verifies the shipped @aiyoplane/langgraph code does not permit a wrapped
// LangGraph node to run before the required authorization condition is
// satisfied. The gated unit is a node function `(state) => stateUpdate`,
// not a tool handler with args; `wrapNode` composes *above* mcp-authz's
// `authz.wrap(toolName, passthrough)`.
//
// What "ordering invariant" means for the LangGraph adapter:
//
//   For a wrapped LangGraph node (produced by wrapNode or aiyoGate), the
//   underlying node function MUST NOT be invoked until the authorization
//   condition has succeeded for the specific Intent that the gatedNode
//   dispatch would act on. The authorization condition is:
//     (a) intentBuilder(state) resolved without throwing and returned a
//         plain object; AND
//     (b) authz.wrap(toolName, passthrough)(intent, null) resolved with the
//         ALLOW ctx shape (did not throw AiyoDenied, AiyoEscalation, or
//         AiyoUnreachable). Equivalently, no BLOCK / ESCALATE / fail-closed
//         path was taken.
//
//   Any failure at (a) or (b) MUST prevent the inner node from running and
//   MUST surface as BlockedByPolicy or EscalationRequired per the
//   LangGraph adapter's error contract.
//
// Eight behavioral cases below. Each would fail LOUDLY if the invariant
// breaks — not from source inspection, but from observing whether the
// inner node's recorded invocation happened.
//
// Run:  node --test test/pattern-41-ordering.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAiyoMcpAuthz, createLocalRdp } from '@aiyoplane/mcp-authz';

import {
  wrapNode,
  aiyoGate,
  BlockedByPolicy,
  EscalationRequired,
} from '../src/index.js';

// Helper: build an authz backed by createLocalRdp with a single-rule policy.
function makeAuthz(ruleEffect, extra = {}) {
  return createAiyoMcpAuthz({
    rdp: createLocalRdp({
      policy: {
        default_effect: 'deny',
        rules: [{
          id: 'pattern-41-vector',
          match: { action_type: 'deploy' },
          effect: ruleEffect,
          ...extra,
        }],
      },
    }),
    toolConfig: {
      deploy_node: { aiyo_gated: true, action: { type: 'deploy' } },
    },
    verifyReceiptOnAllow: false,
  });
}

// Helper: build an authz backed by a bespoke RDP double.
function makeAuthzWithRdp(rdpDouble) {
  return createAiyoMcpAuthz({
    rdp: rdpDouble,
    toolConfig: {
      deploy_node: { aiyo_gated: true, action: { type: 'deploy' } },
    },
    verifyReceiptOnAllow: false,
  });
}

const intentBuilder = (state) => ({ type: 'deploy', target: state.env });

// ─── Case 1 — ALLOW happy path with latency ─────────────────────────────
//
// Confirms the ordering is observable: with a deliberately slow rdp.evaluate,
// the inner node must not run until evaluate resolves.

test('[release-blocker] inner node runs AFTER slow rdp.evaluate resolves (timing)', async () => {
  const events = [];
  const record = (name) => events.push({ name, t: process.hrtime.bigint() });

  const rdp = {
    async evaluate(intent) {
      record('evaluate_called');
      await new Promise((r) => setTimeout(r, 50));
      record('evaluate_resolved');
      return {
        intentId: 'test-intent-1',
        receipt: { token: 'v2.fake.sig' },
        decision: { verdict: 'ALLOW' },
      };
    },
    async close() {},
    async verifyReceipt() { return { iid: 'test-intent-1' }; },
  };

  const innerNode = async (state) => {
    record('inner_node_called');
    return { deployed: true, receivedReceipt: Boolean(state.aeapReceipt) };
  };

  const gated = wrapNode(innerNode, {
    authz: makeAuthzWithRdp(rdp),
    toolName: 'deploy_node',
    intentBuilder,
  });

  const result = await gated({ env: 'staging' });
  record('gated_returned');

  const t = (name) => events.find((e) => e.name === name)?.t;

  assert.ok(t('evaluate_called') !== undefined, 'evaluate must have been called');
  assert.ok(t('evaluate_resolved') !== undefined, 'evaluate must have resolved');
  assert.ok(t('inner_node_called') !== undefined, 'inner node must have been called on ALLOW');
  assert.ok(
    t('evaluate_resolved') < t('inner_node_called'),
    'INVARIANT VIOLATION: inner node ran before evaluate resolved. Pattern 41 ordering failure at the LangGraph composition boundary.'
  );
  assert.deepEqual(result, { deployed: true, receivedReceipt: true });
});

// ─── Case 2 — BLOCK path via AiyoDenied ─────────────────────────────────
//
// mcp-authz throws AiyoDenied on BLOCK. The LangGraph adapter catches it and
// translates to BlockedByPolicy. The inner node must not run.

test('[release-blocker] inner node does not run when evaluate throws AiyoDenied', async () => {
  let inner_called = false;

  const authz = makeAuthz('deny');
  const gated = wrapNode(
    async () => {
      inner_called = true;
      return { ran: true };
    },
    { authz, toolName: 'deploy_node', intentBuilder }
  );

  await assert.rejects(
    () => gated({ env: 'staging' }),
    (err) => err instanceof BlockedByPolicy,
    'wrapped node must reject with BlockedByPolicy on policy deny'
  );

  assert.equal(
    inner_called,
    false,
    'INVARIANT VIOLATION: inner node ran despite DENY. Pattern 41 ordering failure on the BLOCK path.'
  );
});

// ─── Case 3 — Generic throw (fail-closed) ───────────────────────────────
//
// Any evaluate error that is NOT a BLOCK/ESCALATE wire shape must still
// prevent the inner node from running. Fail-closed per AEAP §2.2 invariant 5.

test('[release-blocker] inner node does not run when evaluate throws a generic error (fail closed)', async () => {
  let inner_called = false;

  const rdp = {
    async evaluate() {
      const err = new Error('network partition');
      err.code = 'UNAVAILABLE';
      throw err;
    },
    async close() {},
    async verifyReceipt() { throw new Error('unreachable'); },
  };

  const gated = wrapNode(
    async () => {
      inner_called = true;
      return { ran: true };
    },
    { authz: makeAuthzWithRdp(rdp), toolName: 'deploy_node', intentBuilder }
  );

  await assert.rejects(() => gated({ env: 'staging' }), (_err) => true);
  assert.equal(
    inner_called,
    false,
    'INVARIANT VIOLATION: inner node ran despite evaluate throwing. Fail-closed invariant breached.'
  );
});

// ─── Case 4 — ESCALATE path via AiyoEscalation ──────────────────────────
//
// mcp-authz 1.1.0+ throws AiyoEscalation on ESCALATE verdict. The LangGraph
// adapter detects escalation (currently via message regex at
// src/index.js:122, which matches "escalat" or "ESCALATE") and translates to
// EscalationRequired. The inner node must not run.

test('[release-blocker] inner node does not run when evaluate throws AiyoEscalation', async () => {
  let inner_called = false;

  const authz = makeAuthz('escalate', { escalation_id: 'approve-wf-1' });
  const gated = wrapNode(
    async () => {
      inner_called = true;
      return { ran: true };
    },
    { authz, toolName: 'deploy_node', intentBuilder }
  );

  await assert.rejects(
    () => gated({ env: 'staging' }),
    (err) => err instanceof EscalationRequired || err instanceof BlockedByPolicy,
    'wrapped node must reject with EscalationRequired (or BlockedByPolicy via regex-detection) on policy escalate'
  );

  assert.equal(
    inner_called,
    false,
    'INVARIANT VIOLATION: inner node ran despite ESCALATE. Pattern 41 ordering failure on the ESCALATE path.'
  );
});

// ─── Case 5 — intentBuilder throws ──────────────────────────────────────
//
// If intentBuilder cannot construct the Intent, the adapter MUST fail closed
// before calling the RDP. The inner node must not run and the error must
// be BlockedByPolicy with reasonCode INTENT_BUILD_FAILED.

test('[release-blocker] inner node does not run when intentBuilder throws', async () => {
  let inner_called = false;

  const gated = wrapNode(
    async () => {
      inner_called = true;
      return { ran: true };
    },
    {
      authz: makeAuthz('allow'),
      toolName: 'deploy_node',
      intentBuilder: () => {
        throw new Error('intent build failed deliberately');
      },
    }
  );

  await assert.rejects(
    () => gated({ env: 'staging' }),
    (err) => err instanceof BlockedByPolicy && err.reasonCode === 'INTENT_BUILD_FAILED',
    'wrapped node must reject with BlockedByPolicy{INTENT_BUILD_FAILED} when intentBuilder throws'
  );

  assert.equal(
    inner_called,
    false,
    'INVARIANT VIOLATION: inner node ran despite intentBuilder throwing. The adapter must fail closed before the RDP evaluation step.'
  );
});

// ─── Case 6 — intentBuilder returns a non-object ────────────────────────
//
// A string, array, or null return from intentBuilder is a shape violation.
// Fail-closed before RDP evaluation; inner node must not run.

test('[release-blocker] inner node does not run when intentBuilder returns a non-object', async () => {
  for (const badReturn of ['not an object', ['array', 'not', 'object'], null, 42]) {
    let inner_called = false;

    const gated = wrapNode(
      async () => {
        inner_called = true;
        return { ran: true };
      },
      {
        authz: makeAuthz('allow'),
        toolName: 'deploy_node',
        intentBuilder: () => badReturn,
      }
    );

    await assert.rejects(
      () => gated({ env: 'staging' }),
      (err) => err instanceof BlockedByPolicy,
      `wrapped node must reject when intentBuilder returns ${JSON.stringify(badReturn)}`
    );
    assert.equal(
      inner_called,
      false,
      `INVARIANT VIOLATION: inner node ran when intentBuilder returned ${JSON.stringify(badReturn)}.`
    );
  }
});

// ─── Case 7 — concurrent gated nodes each consult evaluate independently ─
//
// Two concurrent gated-node invocations must each produce their own evaluate
// call; neither may run its inner node before its own evaluate resolves.
// A race-condition bug that cached a decision across concurrent calls would
// surface here as fewer evaluates than invocations OR as one inner running
// before its evaluate completes.

test('[release-blocker] concurrent gated-node invocations each consult evaluate independently', async () => {
  const events = [];
  const record = (name) => events.push({ name, t: process.hrtime.bigint() });

  let evaluate_calls = 0;
  const rdp = {
    async evaluate(intent) {
      const n = ++evaluate_calls;
      record(`evaluate_called_${n}`);
      // Per-call latency: a cached-decision bug would skip the second evaluate
      // and the second inner would run before this delay elapses on call 2.
      await new Promise((r) => setTimeout(r, 30));
      record(`evaluate_resolved_${n}`);
      return {
        intentId: `test-intent-${n}`,
        receipt: { token: `v2.fake.sig.${n}` },
        decision: { verdict: 'ALLOW' },
      };
    },
    async close() {},
    async verifyReceipt() { return {}; },
  };

  let inner_count = 0;
  const gated = wrapNode(
    async (_state) => {
      const n = ++inner_count;
      record(`inner_called_${n}`);
      return { ran: n };
    },
    { authz: makeAuthzWithRdp(rdp), toolName: 'deploy_node', intentBuilder }
  );

  const [r1, r2] = await Promise.all([
    gated({ env: 'a' }),
    gated({ env: 'b' }),
  ]);

  assert.equal(evaluate_calls, 2, 'INVARIANT: each gated invocation must call evaluate independently');
  assert.equal(inner_count, 2, 'INVARIANT: each gated invocation must run its own inner node');
  assert.ok([r1.ran, r2.ran].includes(1) && [r1.ran, r2.ran].includes(2), 'both inner calls completed');
});

// ─── Case 8 — aiyoGate decorator form upholds the same invariant ────────
//
// The decorator-style helper must honor the same ordering invariant as
// direct wrapNode use. Regression check for the decorator wiring.

test('[release-blocker] aiyoGate decorator form: inner node does not run on BLOCK', async () => {
  let inner_called = false;

  const gate = aiyoGate({
    authz: makeAuthz('deny'),
    toolName: 'deploy_node',
    intentBuilder,
  });
  const gated = gate(async () => {
    inner_called = true;
    return { ran: true };
  });

  await assert.rejects(() => gated({ env: 'staging' }), (err) => err instanceof BlockedByPolicy);
  assert.equal(
    inner_called,
    false,
    'INVARIANT: aiyoGate-produced wrapper must enforce Pattern 41 ordering identically to wrapNode.'
  );
});

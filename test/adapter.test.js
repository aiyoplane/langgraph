/**
 * Tests for the AEAP Composition Boundary Adapter for LangGraph (Node).
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAiyoMcpAuthz, createLocalRdp } from '@aiyoplane/mcp-authz';

import {
  AdapterConfigError,
  BlockedByPolicy,
  EscalationRequired,
  aiyoGate,
  wrapNode,
} from '../src/index.js';

function makeAuthz(rules) {
  return createAiyoMcpAuthz({
    rdp: createLocalRdp({ policy: { rules } }),
    toolConfig: {
      deploy_node: { aiyo_gated: true, action: { type: 'deploy' } },
    },
  });
}

const plainNode = async (state) => ({
  deployed: true,
  receivedReceipt: Boolean(state.aeapReceipt),
});

test('ALLOW runs the inner node with receipt attached', async () => {
  const authz = makeAuthz([{ match: { action_type: 'deploy' }, effect: 'allow' }]);
  const gated = wrapNode(plainNode, {
    authz,
    toolName: 'deploy_node',
    intentBuilder: (s) => ({ type: 'deploy', target: s.env }),
  });
  const result = await gated({ env: 'staging', artifactHash: 'sha256:abc' });
  assert.deepEqual(result, { deployed: true, receivedReceipt: true });
});

test('aiyoGate decorator-style helper equivalent to wrapNode', async () => {
  const authz = makeAuthz([{ match: { action_type: 'deploy' }, effect: 'allow' }]);
  const gate = aiyoGate({
    authz,
    toolName: 'deploy_node',
    intentBuilder: (s) => ({ type: 'deploy', target: s.env }),
  });
  const gated = gate(async (state) => ({ deployed: true }));
  const result = await gated({ env: 'staging' });
  assert.deepEqual(result, { deployed: true });
});

test('BLOCK prevents node execution', async () => {
  const authz = makeAuthz([{ match: { action_type: 'deploy' }, effect: 'deny' }]);
  const gated = wrapNode(plainNode, {
    authz,
    toolName: 'deploy_node',
    intentBuilder: (s) => ({ type: 'deploy' }),
  });
  await assert.rejects(gated({ env: 'staging' }), (err) => err instanceof BlockedByPolicy);
});

test('ESCALATE raises EscalationRequired or BlockedByPolicy', async () => {
  const authz = makeAuthz([{ match: { action_type: 'deploy' }, effect: 'escalate' }]);
  const gated = wrapNode(plainNode, {
    authz,
    toolName: 'deploy_node',
    intentBuilder: (s) => ({ type: 'deploy' }),
  });
  await assert.rejects(
    gated({ env: 'staging' }),
    (err) => err instanceof EscalationRequired || err instanceof BlockedByPolicy
  );
});

test('Broken intentBuilder blocks the node', async () => {
  const authz = makeAuthz([{ match: { action_type: 'deploy' }, effect: 'allow' }]);
  const gated = wrapNode(plainNode, {
    authz,
    toolName: 'deploy_node',
    intentBuilder: () => {
      throw new Error('broken');
    },
  });
  await assert.rejects(gated({ env: 'staging' }), (err) => err instanceof BlockedByPolicy);
});

test('Non-object Intent blocks the node', async () => {
  const authz = makeAuthz([{ match: { action_type: 'deploy' }, effect: 'allow' }]);
  const gated = wrapNode(plainNode, {
    authz,
    toolName: 'deploy_node',
    intentBuilder: () => 'not an object',
  });
  await assert.rejects(gated({ env: 'staging' }), (err) => err instanceof BlockedByPolicy);
});

test('Non-function node raises AdapterConfigError', () => {
  const authz = makeAuthz([{ match: { action_type: 'deploy' }, effect: 'allow' }]);
  assert.throws(
    () =>
      wrapNode('not a function', {
        authz,
        toolName: 'deploy_node',
        intentBuilder: () => ({ type: 'deploy' }),
      }),
    (err) => err instanceof AdapterConfigError
  );
});

test('Non-function intentBuilder raises AdapterConfigError', () => {
  const authz = makeAuthz([{ match: { action_type: 'deploy' }, effect: 'allow' }]);
  assert.throws(
    () =>
      wrapNode(plainNode, {
        authz,
        toolName: 'deploy_node',
        intentBuilder: 'not callable',
      }),
    (err) => err instanceof AdapterConfigError
  );
});

test('Receipt attached under custom key', async () => {
  const authz = makeAuthz([{ match: { action_type: 'deploy' }, effect: 'allow' }]);
  const checkKey = async (state) => ({ hasCustomKey: 'myReceipt' in state });
  const gated = wrapNode(checkKey, {
    authz,
    toolName: 'deploy_node',
    intentBuilder: (s) => ({ type: 'deploy' }),
    attachReceiptKey: 'myReceipt',
  });
  const result = await gated({ env: 'staging' });
  assert.equal(result.hasCustomKey, true);
});

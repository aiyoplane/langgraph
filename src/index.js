/**
 * @aiyoplane/langgraph (Node)
 *
 * AEAP Composition Boundary Adapter for LangGraph.
 *
 * The Composition Boundary primitive from AEAP §9, realized against
 * LangGraph.js's node-invocation surface. A LangGraph node is a function
 * `(state) => stateUpdate`; the adapter wraps that function so the AEAP
 * Runtime Decision Point evaluates the state at the node boundary before
 * the original node logic executes.
 *
 * Aiyoplane, Inc. — Apache 2.0 licensed.
 * https://aiyoplane.com
 *
 * Specification: https://github.com/aiyoplane/aeap
 */

import {
  AdapterConfigError,
  AiyoLangGraphError,
  BlockedByPolicy,
  EscalationRequired,
} from './errors.js';

export { AdapterConfigError, AiyoLangGraphError, BlockedByPolicy, EscalationRequired };

/**
 * Wrap a LangGraph node function with an AEAP Composition Boundary.
 *
 * @param {function} node - LangGraph node: `(state) => stateUpdate` or `async (state) => stateUpdate`
 * @param {object} options
 * @param {object} options.authz - AiyoAuthz instance from @aiyoplane/mcp-authz
 * @param {string} options.toolName - Key under which authz.toolConfig has the entry for this node
 * @param {function} options.intentBuilder - (state) => Intent payload (object)
 * @param {string} [options.attachReceiptKey='aeapReceipt'] - State key under which the receipt is attached
 * @returns {function} A new node function with the same signature as the original (always async)
 */
export function wrapNode(node, { authz, toolName, intentBuilder, attachReceiptKey = 'aeapReceipt' } = {}) {
  if (typeof node !== 'function') {
    throw new AdapterConfigError(
      `wrapNode expected a function, got ${typeof node}`
    );
  }
  if (typeof intentBuilder !== 'function') {
    throw new AdapterConfigError(
      'wrapNode requires an intentBuilder function; the adapter must fail closed if the Intent cannot be constructed.'
    );
  }
  if (typeof toolName !== 'string' || !toolName) {
    throw new AdapterConfigError(
      'wrapNode requires a non-empty toolName (used as the key into authz.toolConfig)'
    );
  }

  return async function gatedNode(state) {
    const intent = _buildIntent(intentBuilder, state, toolName);
    const ctx = await _evaluateRdp(authz, toolName, intent);

    // On ALLOW, attach the receipt and invoke the inner node.
    const enrichedState = { ...state };
    if (ctx != null) {
      enrichedState[attachReceiptKey] = ctx.receipt ?? null;
    }
    return await node(enrichedState);
  };
}

/**
 * Decorator-style helper. Returns a function that wraps the node.
 *
 * Usage:
 *   const gate = aiyoGate({ authz, toolName: 'deploy', intentBuilder: ... });
 *   graph.addNode('deploy', gate(async (state) => ({ deployed: true })));
 */
export function aiyoGate({ authz, toolName, intentBuilder, attachReceiptKey = 'aeapReceipt' } = {}) {
  return (node) => wrapNode(node, { authz, toolName, intentBuilder, attachReceiptKey });
}

// --- Internals -------------------------------------------------------------

function _buildIntent(intentBuilder, state, toolName) {
  let intent;
  try {
    intent = intentBuilder(state);
  } catch (err) {
    throw new BlockedByPolicy(
      `intentBuilder for node '${toolName}' raised: ${err?.message || err}`,
      { reasonCode: 'INTENT_BUILD_FAILED' }
    );
  }
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    throw new BlockedByPolicy(
      `intentBuilder for node '${toolName}' did not return a plain object`,
      { reasonCode: 'INTENT_SHAPE_INVALID' }
    );
  }
  return intent;
}

async function _evaluateRdp(authz, toolName, intent) {
  if (!authz || typeof authz.wrap !== 'function') {
    throw new AdapterConfigError(
      `wrapNode received an invalid authz (missing .wrap); the adapter must fail closed`
    );
  }

  let wrapped;
  try {
    const passthrough = async (_args, ctx) => ctx;
    wrapped = authz.wrap(toolName, passthrough);
  } catch (err) {
    throw new BlockedByPolicy(
      `authz.wrap('${toolName}') failed: ${err?.message || err}`,
      { reasonCode: err?.name || 'AUTHZ_WRAP_FAILED' }
    );
  }

  try {
    return await wrapped(intent, null);
  } catch (err) {
    const msg = err?.message || String(err);
    if (/escalat/i.test(msg) || /ESCALATE/.test(msg)) {
      throw new EscalationRequired(
        `AEAP ESCALATE verdict for node '${toolName}' (intent=${JSON.stringify(intent)}): ${msg}`,
        { extra: { innerException: err?.name, intent } }
      );
    }
    throw new BlockedByPolicy(
      `AEAP non-ALLOW verdict for node '${toolName}' (intent=${JSON.stringify(intent)}): ${msg}`,
      { reasonCode: err?.name || 'RDP_NON_ALLOW', extra: { innerException: err?.name, intent } }
    );
  }
}

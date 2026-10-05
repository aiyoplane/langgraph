/**
 * Typed errors raised by the AEAP Composition Boundary Adapter for LangGraph.
 */

export class AiyoLangGraphError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AiyoLangGraphError';
  }
}

export class AdapterConfigError extends AiyoLangGraphError {
  constructor(message) {
    super(message);
    this.name = 'AdapterConfigError';
  }
}

/**
 * The RDP returned verdict=BLOCK. The node MUST NOT execute.
 */
export class BlockedByPolicy extends AiyoLangGraphError {
  constructor(message, { reasonCode, intentId, extra } = {}) {
    super(message);
    this.name = 'BlockedByPolicy';
    this.reasonCode = reasonCode;
    this.intentId = intentId;
    this.extra = extra || {};
  }
}

/**
 * The RDP returned verdict=ESCALATE. The node is held pending resolution.
 */
export class EscalationRequired extends AiyoLangGraphError {
  constructor(message, { escalationId, intentId, extra } = {}) {
    super(message);
    this.name = 'EscalationRequired';
    this.escalationId = escalationId;
    this.intentId = intentId;
    this.extra = extra || {};
  }
}

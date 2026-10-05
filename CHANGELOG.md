# Changelog

## 1.0.0 (2026-10-05)

- Initial release.
- AEAP Composition Boundary Adapter for LangGraph.js.
- Wraps LangGraph node functions with the AEAP Runtime Decision Point via `@aiyoplane/mcp-authz`.
- Entry points: `wrapNode`, `aiyoGate`.
- Receipt attached to graph state on ALLOW; `BlockedByPolicy` / `EscalationRequired` on non-ALLOW.
- Fail-closed defaults per AEAP §2.2 invariant 5.
- Apache 2.0.

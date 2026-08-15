# Decision: split exhaustive security/fault evidence by production seam, then keep one final proof task

A full-system security/fault matrix is not one <=60-minute task even when it can be expressed in two large test files. Split it into four file-disjoint evidence slices:

- authority transports: daemon HTTP/event, MCP stdio/HTTP, control-room/IDE, importer, force paths;
- integrity/scope: filesystem/Git/process input bounds, provider closure, evidence and distribution tamper;
- durable store: transaction/WAL/checkpoint/corruption/locks/outbox/inbox/projection;
- runtime effects: dispatcher/supervisor/platform/providers/resources/budgets/artifacts.

Each slice owns its own strict tsconfig and focused tests, drives public production entry points, asserts the stable reason code and refusing layer, reads authoritative state/effect/budget/audit deltas, and guards its generated case universe with non-zero plus exact production-registry set equality.

A separate lane task owns root scripts and aggregate tsconfigs. The original matrix task is the final integration/hardening proof only: verify every shipping prerequisite task is DONE and consumer-reachable, run exact `pnpm test:fault && pnpm test:security`, perform production-surface and removed-case mutation drills, and report path-attributed repo baseline deltas. Existing Foundation/disaster/platform fixture subtrees remain untouched.

Do not treat a test-file line cap as the sizing decision. The split is required by distinct responsibilities, human-equivalent time, and independent production seams, not by aggregate LOC.
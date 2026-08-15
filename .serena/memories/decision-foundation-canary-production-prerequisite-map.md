# Decision: an acceptance canary cannot be its own missing production orchestrator

For Foundation self-host acceptance, package exports, pure helpers, and test-created ports are not equivalent to a production capability. Before planning E2E journeys:

1. Probe the public package root with plain Node.
2. Grep for a non-test production caller/consumer edge.
3. For external effects, grep for the physical OS boundary (spawn/lock/registration/cleanup), not just logical activation reducers.
4. For durable authority, trace the evidence back to stored bytes; caller-supplied refs, truth labels, release facts, or handoffs are not proof.
5. Execute a hostile production probe for every closed classification/outcome, asserting the generated count and exact code+layer.
6. If any edge is absent, create bounded production prerequisite tasks and block the canary. Never fill the gap with a test driver that decides auth, lifecycle, dispatch, receipt, recovery, or acceptance.

Concrete defect that motivated this decision: the landed J3 continuation service accepted caller-supplied release/handoff and returned BOUND for ADOPTED, ABSENT, SUSPECT, QUARANTINED, and RECONCILIATION_COMMAND alike, including QUARANTINED with an active held resource. The green unit suite did not test the full classification universe or durable source of the handoff.

See `mem:task-task-97554aa4293e40eab56c0b642e18513a-handoff` for the task IDs and exact capability map.

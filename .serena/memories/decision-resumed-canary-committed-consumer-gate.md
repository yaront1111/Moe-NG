# Decision: a resumed acceptance canary starts with committed consumer reachability

When a terminal acceptance/canary task is unblocked, do not infer that every historical blocker is gone from task status or from package-root exports. The first remaining plan step must re-probe the **committed production consumer edge** for every certified capability.

For a real-process canary:
- a public export without a host caller is not composition;
- a test/test-harness caller is not a production consumer;
- a synthetic provider observation is not host pin evidence;
- a direct reducer/service call in E2E is not daemon ingress;
- foreign uncommitted bytes cannot satisfy a prerequisite.

If the production caller is absent, stop and report the exact missing symbol/call site. Never let the acceptance test become the missing orchestrator. Destructive journeys belong in a sequential `*.e2e.ts` lane that the ordinary root suite provably does not discover.

This decision was applied while replanning `task-97554aa4293e40eab56c0b642e18513a`; see `mem:task-task-97554aa4293e40eab56c0b642e18513a-handoff`.

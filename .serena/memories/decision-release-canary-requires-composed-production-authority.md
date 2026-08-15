# Decision: a release canary must traverse composed production authority

A release/self-host canary may use test fixtures only as inputs and fault schedules, never as a substitute for the production command, persistence, process, recovery, or receipt composition it claims to certify. Package-root export reachability is necessary but insufficient: each required state transition must be callable through authenticated production ingress, durably applied to the authoritative store, and observable through production read/replay surfaces.

If a reducer/helper exists only as pure logic, a handler is absent, or a fault ratchet still labels the behavior `PRODUCTION_BEHAVIOR_ABSENT`, an E2E task limited to tests/e2e must block and request a production prerequisite rather than build an in-test orchestrator. This preserves the distinction between unit/model confidence and full-system authority.

For process-killing Windows journeys, isolate files with a suffix excluded from the ordinary root suite (for this repo, `*.e2e.ts`) and an E2E-specific Vitest config. Never use runtime skip tricks to make destructive tests safe, and prove the ordinary root suite discovers zero destructive journey files.

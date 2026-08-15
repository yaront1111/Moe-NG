# Decision: expansion admission needs atomic durable hold/run authority

A daemon expansion-admission consumer cannot treat a reducer-shaped hold or a five-field currentAuthority object as request/test fixtures. The scheduler bridge's security property depends on:
- the complete reducer-produced `ExpansionPlanningHoldState` including creation receipt and current version,
- daemon-current goalVersion/graphEpoch/holdId/holdVersion/planningRunRef,
- and the sealed EXPANSION PlanningRun bound to that exact hold.

The durable design boundary creates safe release, ACTIVE hold, and bounded PlanningRun together. Split production work as:
1. one public direction-safe hold-to-binding producer (scheduler owns it because scheduler already depends on core);
2. one daemon reader deriving safe-release evidence from durable attempt/activation/lease/slot/effect records;
3. one authenticated atomic daemon transaction that persists the full hold and bound PlanningRun;
4. only then the admission/preparation/manual-approval consumer.

A PlanningRun's compact `PlanningExpansionHoldBinding` cannot reconstruct the full hold and must never be used as a replacement for the durable hold record. A test that seeds a full hold directly is mock-backed authority, not a daemon-current proof. The eventual pre-activation record must bind both the sealed PlanningRun proposal identity and the scheduler/core preparation identities; neither family alone proves the other.

Refusal provenance must be retained at the producer: if a bridge delegates to a contract inspector, preserve its exact target beside code/layer/origin. A daemon should not re-run a delegated surface merely to recover metadata the upstream result dropped.
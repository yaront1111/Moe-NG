# Planning expansion contract projection

When composing the landed ExpansionPlanningHold into PlanningRun without enabling behavior:
- project the hold into a DAEMON_VERIFIED readonly binding that reuses ExpansionHandoffBinding; do not copy scheduler/runner authority and do not create a parallel aggregate;
- keep INITIAL/REVISION bytes stable with discriminated unions under existing public type names rather than universal optional fields;
- make stale EXPANSION shapes invalid by requiring the full expansion binding on create/state/created event and the same binding plus sealed proposal identity on propose/sealed event;
- bind sealed proposal {proposalRef,proposalHash,truthClass} to the existing submission witness/hash, not a second free identity;
- use expansion-local identifier bounds so legacy validation behavior is not silently changed;
- schema representability does not enable reducer transitions: the following behavior task owns hold matching and submission state changes.

Consumer for this decision: task-93b0314e09f248118e21f92699989468.

# Current expansion hold goalVersion boundary

`ExpansionPlanningHoldState` and `CreateExpansionHoldCommand` contain graphEpoch, hold identity/version, and planningRunRef but no goalVersion. Therefore an exact public `bindCurrentExpansionHold({currentAuthority,hold})` must not claim it compared current.goalVersion to hold authority.

Sound composition:
1. The standalone scheduler binder exact-parses all five current values, compares the four hold-backed values, constructs `PlanningExpansionHoldBinding`, and lets the production core HOLD_BINDING inspector validate/carry goalVersion.
2. `bindExpansionAdmission`, which also owns `preparation.bound`, retains the goalVersion equality fence and the second graphEpoch equality fence against that bound.
3. Daemon consumers must supply genuinely current values atomically; the pure scheduler surface cannot create daemon authority.

Do not solve this by adding goalVersion to the core hold schema inside a scheduler extraction, inventing a test-owned operand, or duplicating a daemon mapper. See `mem:task-task-2d37939dddde447bb98e53a2bd9e6c60-handoff`.

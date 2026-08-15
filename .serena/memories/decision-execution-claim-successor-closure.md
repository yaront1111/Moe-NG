# Execution claim successor closure decision

A daemon execution claim must expose five immutable typed successor records while retaining four refusal legs: active lease, dimension-bound RESERVED provider slot, RESERVED budget reservation, the exact shifted BudgetAvailableView returned by the same reserveForAdmission call, and CLAIMED EffectIntent. Budget view is output closure for the budget leg, not a new leg.

The untyped `claimWork(payload: unknown)` boundary must exact-snapshot the outer object and each section just before its causal leg to preserve lease -> ceiling -> slot -> budget -> effect precedence. It must reject descriptor/proxy/prototype/key-shape hostility without invoking accessors. A structurally valid non-claim command refuses locally as `WORK_INTENT_COMMAND_MISMATCH` / `AUTHORITY` / `effectIntent` / upstream null; runner invocation receives a server-owned `{kind:"claim"}`, never caller authority.

# Stale grant refusal layer gotcha

A stale-grant test that asserts only `SESSION_REPLAYED` is detached when several layers can emit that code (REPLAY, GENERATION, SESSION_STATE, RECOVERY_BINDING). The production command refusal must expose enough stable identity to assert RECOVERY_BINDING, and the generated case count must count grant cases themselves, not a separate stale-session table.
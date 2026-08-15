# Gotcha: exact context bytes must frame item boundaries

Concatenating selected item content directly is deterministic but not identity-safe: `['ab','c']` and `['a','bc']` produce the same bytes, and mandatory identities are absent from the seven-field manifest except through exact bytes.

Render each complete item through canonical serialization and place an explicit byte separator between items. The selector must use the same renderer cost source (`context-wire.ts`) for mandatory admission and optional fitting; otherwise rendered bytes can exceed the admitted budget.

Pin this with an adversarial pair that shifts a character across two mandatory item boundaries and asserts both exact bytes and the production manifest digest differ. Also reject NaN, Infinity, negative, and fractional byte budgets with a stable selection-layer code; comparisons against NaN otherwise fail open.
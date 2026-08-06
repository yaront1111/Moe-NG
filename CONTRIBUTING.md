# Contributing to Moe Next

## Focused modules

Keep source and test files cohesive and easy to review. When a file begins to carry multiple responsibilities or becomes cumbersome to navigate, split it along domain boundaries such as contracts, codecs, schema management, orchestration, and read models.

Line count is a review signal, not a target. Files approaching 800 lines require an explicit split review; files above 1,200 lines require a written justification when a safe split is not yet possible. Generated files are exempt.

Prefer small public surfaces and private implementation modules. A split must preserve atomicity, invariants, and tests; do not create circular dependencies merely to reduce line count.

# A drill restore can reinsert a line at the wrong indentation, and tests stay green

Removing a line with an anchor that omits its LEADING WHITESPACE matches the tail of the line and
leaves the indent behind. Reinserting a correctly indented copy then produces a file that is
semantically identical, compiles, and passes the whole suite — but is NOT byte-identical.

Measured on task-2d37939dddde447bb98e53a2bd9e6c60: dropping
`"EXPANSION_BINDING_HOLD_VERSION_MISMATCH",\n` (no leading spaces) from a frozen array and
restoring it left the NEXT entry over-indented by two spaces. `pnpm test` was green, 1319/1319.
Only `sha256sum` disagreed with the pre-drill baseline (ab9f30f4… vs 0e48b38c…).

Rules:
1. Hash before the drill, hash after the restore, compare. A green suite is not a restore proof.
2. Include the full line with its indentation in the anchor, and assert `count == 1`.
3. Repair by exact edit. Do NOT `git checkout` in a shared worktree — see
   `mem:git-checkout-restore-destroys-uncommitted-work`.
4. In a shared tree `git diff` can also be empty because a foreign whole-tree hook already
   committed your drilled bytes; `git status` is not a restore check either.

Related: `mem:mutation-drill-restore-anchor-goes-ambiguous`.

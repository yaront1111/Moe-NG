# Narrowing a pattern-matcher passes every gate you own — the over-narrowed version is the one to fear

Proved by drill 2026-08-11 on task-40983c7c, repairing the foundation fault-ratchet
absence probes.

## The asymmetry
A probe that declares "these capability names must still be absent" carries a broad
REGEX so a near-miss rename cannot game it. When that broad pattern collides with a
legitimately published name, the fix is to narrow it. Both failure directions look
identical from the gate:

- **Too broad** — fires on unrelated published names. LOUD: the fault suite goes red
  and someone files a task.
- **Too narrow** — fires on nothing. SILENT: every gate is green and the ratchet is
  dead. Narrowed to an exact literal, it still matches its own `absentExportNames`,
  so even the pre-existing spec test that requires "pattern matches one declared name"
  stays green.

Measured: replacing the distribution pattern with the exact literal
`"verifyDistributionManifest"` left `pnpm test:fault` (43/43), the whole testkit suite
(245/245), the typecheck, AND the new not-too-broad invariant test all GREEN. Only a
purpose-written near-miss suite failed.

## So a narrowing needs two tests, not one
1. **Not too broad** — evaluate every probe against its package's REAL current root
   exports; fail on any match. Catches re-broadening.
2. **Not too narrow** — feed each probe plausible renames of its OWN capability across
   camelCase / PascalCase / snake_case / SCREAMING_SNAKE and assert it still fires.

Both must assert through the PRODUCTION evaluator (`evaluateAbsenceProbe`), never a
locally rebuilt `new RegExp(...)`.

## Two ways the near-miss test goes vacuous
- A variant that is also in `absentExportNames` is answered by the exact-name branch,
  so the pattern is never exercised. Assert every variant is NOT a declared name.
- The variant table silently missing a probe. Assert its key set equals the probeRef
  set, and pin a hand-written probe count (not `PROBES.length`).

And for the not-too-broad test: an export list that resolves EMPTY makes every probe
vacuously absent forever. Assert a per-package floor **inside the collision loop**,
not only in a neighbouring test — drill it by forcing `[]` and confirming the
collision test itself reddens.

## Pattern shape that worked
Bind to the capability's own VERBS plus nouns nothing publishes; do NOT bind to a bare
capability noun the package already exports as a type — a runtime companion later
(`parseDistributionManifest` next to type `DistributionManifest`) is the next collision.

Related: `mem:gotcha-export-probe-must-be-measured-at-runtime`,
`mem:gotcha-fault-ratchet-broad-patterns-collide-with-published-names`,
`mem:qa-generated-table-cannot-police-its-own-generator`.

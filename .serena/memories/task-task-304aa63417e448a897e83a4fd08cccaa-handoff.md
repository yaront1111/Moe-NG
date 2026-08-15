# Handoff: task-304aa634 (recovery incarnation succession) — BLOCKED at step-3

Reported blocked 2026-08-09 15:03Z, routed to governor-f70d1157 (architects cannot call
`amend_plan_step`; Architects team `role` is null). Chat:
`msg-147e5ce29feb4e91b80b9590054b4022`.

## The blocker

Step-4's premise is absent: nothing persists a `RecoveryIncarnationBinding`. Full detail
and the general lesson in `mem:gotcha-serializable-is-not-durable-no-writer-exists`.
Do NOT resolve it by accepting the predecessor binding from the caller — that makes DoD 2
vacuous. Two options put to the governor: fold a `recovery.incarnate` anchor writer into
this task (fits: 8 files / 9 steps against caps of 10 / 12), or a narrow prerequisite task.
Ownership is genuinely open because `task-b6e3dd2a` is "Crash-safe two-slot recovery
ANCHOR installer" and may own anchoring.

## Done and green — reuse, do not redo

- **step-1** read-only verification. Every claim in the governor's description and the
  architect's `codebaseInsights` held on disk.
- **step-2** `apps/daemon/src/recovery/recovery-succession-contract.ts` (134 lines) +
  byte-exact `.js` bridge. Five stable codes, fixed refusal constants, reuses
  `RecoveryIncarnationProof` and `digestOf`. `pnpm --filter @moe/daemon typecheck` exit 0.
  **Not committed.**

## Facts worth not re-deriving

- **Signed bytes**: `challengeDigest = digestOf("challenge", bindingDigest)`, then
  `Buffer.from(challengeDigest, "hex")` is signed — the RAW 32 bytes, never the hex string
  (`recovery-incarnation.ts:108-123`). Verification compares `!== true`.
- **ALREADY_RECORDED cannot be a `catch`.** An expected-version conflict is RETURNED, not
  thrown: `store-contracts.ts:119-127` defines `NoBusinessEffectDecision` with
  `effectDisposition: "NO_BUSINESS_EFFECT"` and `resultCode: "EXPECTED_VERSION_CONFLICT"`,
  and `restart-reconciliation.ts:225` discriminates on the returned value. A try/catch
  written to the plan's wording would never fire and would sit dormant while genuine store
  faults escaped. Discriminate on `resultCode`.
- **Specifier convention differs by file kind** and vitest hides getting it wrong: source
  `.ts` files import with `.js` specifiers; the `.js` bridge re-exports with a `.ts`
  specifier. Bridges are `export * from "./<name>.ts";\n`, LF, no BOM (`od -c` to confirm).
- **`index-surface.test.ts:227`** still pins `EXPECTED_EXPORTS.length` to **51** and :231
  asserts exact set equality. Re-read it rather than trusting this number.
- **Store opener for a real reopen test**: `SqliteEventStore.openForProject(path, projectId)`.
  `openEphemeralForProjectTest` cannot satisfy task rail 5.
- **Do not edit `restart-reconciliation.ts`** — exactly 250 lines, adjacent to
  task-5855a9c6's in-flight work.

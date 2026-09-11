import { createHash } from "node:crypto";

/**
 * ONE ENVIRONMENT HAS ONE SCHEMA, SO THE COMMANDS THAT MOVE IT SHARE ONE PARITY.
 *
 * THREE commands can move a deployed environment's schema, and before this module the two that had
 * a guard at all guarded it on private streams that neither could see:
 *
 *     deployment.rollback    with restoreDatabase:true  applies a recorded dump over the schema
 *     deployment.migrate_down                           reverts the last applied migration batch
 *     deployment.deploy      when it migrates           applies the target sha's migration batch
 *
 * Each of the first two read its OWN stream's parity, found it even, reserved its OWN stream and
 * proceeded, while the deploy read nothing at all. So a revert, a restore and a migrating deploy
 * could be admitted against the same environment in the same moment, all write the same database,
 * and all record a receipt saying it succeeded. `environmentSchemaGuardId` is the single stream all
 * three now derive, so the odd-means-reserved parity excludes them from EACH OTHER and not merely
 * from themselves.
 *
 * THIS MODULE EXPORTS IDS AND NOTHING ELSE — no reserve, no release, no store access. The three
 * commands build their reservation legs differently (different event vocabulary, different
 * companion legs, and for the deploy a different moment entirely), and unifying the leg
 * construction would rewrite three admission paths instead of sharing one derivation. What has to
 * be shared to close the defect is the STREAM, and that is all this is.
 *
 * `deployment.deploy` IS FENCED, AND OVER A CHOSEN SPAN RATHER THAN ITS WHOLE FLIGHT. It takes this
 * guard at its MIGRATION and gives it back with its TERMINAL DECISION, so it holds the environment
 * across migrate, candidate start, health polling and the proxy flip — and NOT across `docker build`
 * or the ssh image transfer, which cannot move a schema and can take minutes. The span was chosen,
 * not inherited: the whole flight would close the environment to rollback for exactly the window an
 * operator most wants to roll back IN, and releasing at the end of the migration instead would let a
 * candidate start and serve against a schema a concurrent restore had replaced underneath it.
 *
 * SO DEPLOY'S INTENT COMMITS MID-FLIGHT, NOT AT ADMISSION, and that is a deliberate departure from
 * the other two. `admitBootstrapCommand` commits nothing, so unlike rollback and migrate_down there
 * is no admission-time decision to hang a reservation on; `deploy-schema-guard.ts` commits the
 * intent from inside the migrate port instead. DO NOT "FIX" IT BACK TO ADMISSION without re-deciding
 * the span — moving the reserve earlier silently converts this into the whole-flight option above,
 * which is an operator-visible availability change and not a refactor.
 *
 * THE RESIDUAL, STATED RATHER THAN HIDDEN. A rollback or a revert admitted DURING a deploy's build
 * phase is not excluded by this fence: it takes the environment while the deploy is still building,
 * and the deploy then finds the guard odd when it reaches its migration and refuses
 * `DEPLOY_ENVIRONMENT_SCHEMA_BUSY` after a completed build. A wasted build, never a corrupted
 * schema. This module does not claim the fence is total; it claims that no two of the three can
 * write the same schema at once.
 *
 * REFUSAL VOCABULARY: TWO COMMANDS KEEP THEIRS, THE THIRD HAD NONE TO KEEP. The rollback still
 * answers `DEPLOY_ROLLBACK_IN_PROGRESS` and the revert `MIGRATE_DOWN_IN_PROGRESS` when they find
 * the shared guard odd, so an operator still sees the code of the command they issued and no closed
 * code-to-layer map is reopened. `deployment.deploy` had NO in-progress code at all, so one was
 * minted: `DEPLOY_ENVIRONMENT_SCHEMA_BUSY`, a SEAM code thrown at `DAEMON_COMMAND_SEAM` from
 * `deploy-command.ts` and DELIBERATELY NOT a member of the engine's frozen `DEPLOY_REFUSAL_CODES`
 * (`deploy-receipt-contracts.ts`:41), whose every member carries a `DeployEngineStamp` onto a
 * receipt. None of the three codes implies WHICH command is holding the environment, only that one
 * is.
 *
 * THE CONSEQUENCE A READER WILL OTHERWISE HIT AS A SURPRISE: ALL THREE COMMANDS DELIBERATELY LEAVE
 * THE GUARD ODD WHEN AN EFFECT'S OUTCOME IS UNKNOWN, AND THAT NOW BLOCKS THE OTHER TWO.
 * `migrate-down-admission.ts` releases only on `RECEIPTED` or the explicit `MIGRATION_IN_PROGRESS`
 * project-lock refusal; `rollback-command.ts` lets a throw escape past its release; and a throw
 * escaping a deploy between its reserve and its terminal leaves the stream reserved for the same
 * reason. Anything else would free a stream whose effects may have happened with no durable evidence
 * of what they did. Before unification that stranded one command; now it strands all three. THAT IS
 * THE CORRECT BEHAVIOUR — the schema's state is unknown, so nothing else may move it — and it is not
 * widened to make a test easier to write. RECOVERY IS UNAFFECTED: each command finishes an
 * already-admitted request by reading the guard id and version out of its OWN intent decision rather
 * than re-checking parity, so the command that left the guard odd can always still finish. For the
 * deploy that read happens BEFORE the engine runs (`deploy-schema-guard.ts`), because its receipt
 * replay can return before the migration and would otherwise skip the release.
 *
 * THE UPGRADE HAZARD, AND WHAT HAPPENS TO A REQUEST ADMITTED BEFORE THIS CHANGE.
 * A request admitted on the old code reserved its command's PRIVATE stream and stored the version
 * it took in its intent decision's committed bytes. Its recovery commits the release leg at that
 * version. Point recovery at the NEW stream and the leg's expectedVersion can never agree with a
 * stream the request never reserved, so that commandId could never finish — the request would be
 * stranded forever and its environment left reserved forever with it.
 *
 * THE CHOSEN BEHAVIOUR IS THAT SUCH A REQUEST STILL COMPLETES, ON ITS ORIGINAL STREAM. From this
 * change onward every intent records the guard id it actually reserved alongside the version, and
 * recovery uses the RECORDED id. An intent that carries no id is, by construction, one admitted
 * before this change, so recovery falls back to that command's LEGACY derivation below and releases
 * the stream it really took. The fallback is for OLD INTENTS ONLY: a fresh request always records
 * the unified id, which `environment-schema-guard.test.ts` pins by decoding a fresh intent's bytes —
 * if the fallback ever became the default path, the unification would not be in effect at all and
 * every cross arm would be green for the wrong reason.
 *
 * THE HAZARD DOES NOT REACH `deployment.deploy` AND IT HAS NO LEGACY DERIVATION HERE. Deploy was
 * never fenced before it joined this stream, so no deploy intent lacking a guard id can exist; one
 * that lacked it would be a corrupt record rather than an old one, and `deploy-schema-guard.ts`
 * fails closed on it instead of deriving a stream the request never took.
 *
 * THE WINDOW THAT REMAINS, stated rather than hidden: while a pre-change request is still in flight
 * it holds its LEGACY stream, which the new derivation does not read, so it does not exclude the
 * other command. That window is bounded by that one request's own lifetime and closes when it
 * finishes. Migrating the old streams instead — replaying their guard events onto the new id —
 * would rewrite durable history to fix a transient window, which is the worse trade.
 */

const digest = (value: unknown): string =>
  createHash("sha256").update(new TextEncoder().encode(JSON.stringify(value))).digest("hex");

/**
 * THE ONE STREAM ALL THREE SCHEMA-MOVING COMMANDS GUARD.
 *
 * The hashed shape is the ROLLBACK's — an OBJECT `{ projectId, environment }` — kept over
 * migrate_down's positional array because a named-key shape says what each component is at the one
 * place a reader can check it, and a positional one silently means something else the day a third
 * component is appended. The PREFIX is new on purpose: `environment-schema:` names what is guarded
 * (this environment's schema) rather than which command guards it, and neither old prefix could be
 * kept without reading as though one command still owned the stream.
 *
 * A NEW PREFIX ALSO MEANS NO ID MINTED HERE COLLIDES WITH EITHER LEGACY STREAM, so an old in-flight
 * request's parity and a new request's parity cannot be confused for one another.
 *
 * `environment` is admitted input — `rollback-command.ts` and `migrate-down-admission.ts` validate
 * it against their own environment-name rule before this is called, and the deploy's derivation
 * runs inside the migrate port, which the engine reaches only past its own `admitEnvironmentName`
 * check (`deploy-service.ts`:257) — and the answer is a hash, so this id carries nothing secret and
 * is safe on a durable surface.
 */
export function environmentSchemaGuardId(projectId: string, environment: string): string {
  return `environment-schema:${digest({ projectId, environment })}`;
}

/**
 * COMPATIBILITY ONLY — NEVER USE FOR A NEW RESERVATION.
 *
 * The exact pre-change derivation from `rollback-command.ts:140`, byte for byte including key
 * order, kept so a rollback admitted before the unification can still release the stream it really
 * took. Its only caller is that command's recovery path, and only when the intent decision carries
 * no recorded guard id. A new reservation on this stream would be invisible to `migrate_down` and
 * would reopen exactly the defect this module closes.
 */
export function legacyRollbackGuardId(projectId: string, environment: string): string {
  return `rollback-environment:${digest({ projectId, environment })}`;
}

/**
 * COMPATIBILITY ONLY — NEVER USE FOR A NEW RESERVATION.
 *
 * The exact pre-change derivation from `migrate-down-admission.ts:39-40`, byte for byte including
 * its ARRAY shape, kept for the same reason and with the same single caller rule as
 * `legacyRollbackGuardId` above. The array is preserved deliberately: this function's whole value
 * is reproducing ids that already exist in durable stores, so "improving" its shape would silently
 * strand every request it exists to rescue.
 */
export function legacyMigrateDownGuardId(projectId: string, environment: string): string {
  return `migrate-down-environment:${digest([projectId, environment])}`;
}

import { createHash } from "node:crypto";

/**
 * ONE ENVIRONMENT HAS ONE SCHEMA, SO THE COMMANDS THAT MOVE IT SHARE ONE PARITY.
 *
 * Two commands can move a deployed environment's schema, and before this module they guarded it on
 * two private streams that neither could see:
 *
 *     deployment.rollback    with restoreDatabase:true  applies a recorded dump over the schema
 *     deployment.migrate_down                           reverts the last applied migration batch
 *
 * Each read its OWN stream's parity, found it even, reserved its OWN stream and proceeded. So a
 * revert and a restore could be admitted against the same environment in the same moment, both
 * write the same database, and both record a receipt saying it succeeded. `environmentSchemaGuardId`
 * is the single stream both now derive, so the odd-means-reserved parity they already implement
 * excludes them from EACH OTHER and not merely from themselves.
 *
 * THIS MODULE EXPORTS IDS AND NOTHING ELSE — no reserve, no release, no store access. The two
 * commands build their reservation legs differently (different event vocabulary, different
 * companion legs), and unifying the leg construction would rewrite two admission paths instead of
 * one derivation. What has to be shared to close the defect is the STREAM, and that is all this is.
 *
 * `deployment.deploy` IS DELIBERATELY NOT AMONG THEM YET. A deploy also moves the schema when it
 * migrates, but it holds its environment across build, migrate, candidate start and health polling,
 * so taking this guard for that whole span changes how long an environment is unavailable to other
 * operators — an operator-visible product decision rather than a bug fix. It is filed as a
 * successor to task-b8af5916c0c4476ca9f545cb2690cda0. Until it lands, a deploy can still interleave
 * with a rollback or a revert; this module narrows the hole, it does not claim to have closed it.
 *
 * NO NEW REFUSAL VOCABULARY. Each command keeps answering with its OWN in-progress code when it
 * finds the shared guard odd — `DEPLOY_ROLLBACK_IN_PROGRESS` for the rollback,
 * `MIGRATE_DOWN_IN_PROGRESS` for the revert — so an operator sees the code of the command they
 * issued, which is what the closed code-to-layer maps already pin. The code no longer implies WHICH
 * command is holding the environment, only that one is.
 *
 * THE CONSEQUENCE A READER WILL OTHERWISE HIT AS A SURPRISE: BOTH COMMANDS DELIBERATELY LEAVE THE
 * GUARD ODD WHEN AN EFFECT'S OUTCOME IS UNKNOWN, AND THAT NOW BLOCKS THE OTHER COMMAND TOO.
 * `migrate-down-admission.ts` releases only on `RECEIPTED` or the explicit `MIGRATION_IN_PROGRESS`
 * project-lock refusal, and `rollback-command.ts` lets a throw escape past its release; anything
 * else leaves the stream reserved, because effects may have happened with no durable evidence of
 * what they did. Before unification that stranded one command; now it strands both. THAT IS THE
 * CORRECT BEHAVIOUR — the schema's state is unknown, so nothing else may move it — and it is not
 * widened to make a test easier to write. RECOVERY IS UNAFFECTED: each command finishes an
 * already-admitted request by reading the guard version out of its OWN intent decision rather than
 * re-checking parity, so the command that left the guard odd can always still finish.
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
 * THE WINDOW THAT REMAINS, stated rather than hidden: while a pre-change request is still in flight
 * it holds its LEGACY stream, which the new derivation does not read, so it does not exclude the
 * other command. That window is bounded by that one request's own lifetime and closes when it
 * finishes. Migrating the old streams instead — replaying their guard events onto the new id —
 * would rewrite durable history to fix a transient window, which is the worse trade.
 */

const digest = (value: unknown): string =>
  createHash("sha256").update(new TextEncoder().encode(JSON.stringify(value))).digest("hex");

/**
 * THE ONE STREAM BOTH SCHEMA-MOVING COMMANDS GUARD.
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
 * `environment` is admitted input — `rollback-command.ts` and `migrate-down-admission.ts` both
 * validate it against their own environment-name rule before this is called — and the answer is a
 * hash, so this id carries nothing secret and is safe on a durable surface.
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

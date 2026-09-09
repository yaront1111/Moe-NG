import type { SqliteEventStore } from "@moe/store";
import type { EnvironmentRefusal } from "../environment/environment-contracts.js";
import { readEnvironmentDelivery } from "../environment/environment-delivery.js";
import type { EnvironmentCredentialSource } from "../environment/environment-projection.js";
import type { MigrationInput } from "../repository/migrations/migration-service.js";
import { DEPLOY_ENGINE_STAMP, type DeployEngineStamp } from "./deploy-receipt-contracts.js";

/**
 * THE HOST HALF OF `MigrationInput`, RESOLVED ONCE AND REUSED BY THE REVERT.
 *
 * A deploy knows its admitted project, environment, workspace and sha; it does NOT know the
 * database the migration must reach. That value lives in the environment store, sealed, and the
 * ONLY thing that turns a named environment into it is a delivery read. This module is that read
 * plus the guards around it, in a module rather than inline because the migrate-down sibling
 * composes the same resolution: two derivations of "which database does `production` mean" would
 * be two places for the answer to drift, and a down() that reverts a DIFFERENT database than the
 * up() applied is the worst outcome this slice can produce.
 *
 * WHY `readEnvironmentDelivery` AND NOT EITHER NEIGHBOUR, measured rather than assumed:
 *   - `resolveEnvironmentLaunch` derives the environment from `PURPOSE_ENVIRONMENTS`, which is
 *     exactly `{PREVIEW: "preview", VERIFIER: "verify"}` and has NO deploy member. A deploy of
 *     `production` has no `LaunchPurpose` at all, so it would resolve some OTHER environment's
 *     variables. That map's own header says it grows when the container handoff lands; that row
 *     (task-04b3ce7e) is DONE and THE MAP DID NOT GROW, so the comment invites the mistake.
 *   - `launchDelivery` coerces a refusal to `undefined`, which starts a child WITHOUT variables.
 *     For a DATABASE_URL a migration requires, an unreadable store would present as "no database
 *     configured" and the migration would proceed against no database context at all.
 * `readEnvironmentDelivery` takes the environment as an explicit STRING, so the deploy's
 * already-admitted environment flows through with no purpose mapping in between.
 *
 * THE CONNECTION VALUE NEVER LEAVES THIS PROCESS. It is returned on the `ok` branch because the
 * engine needs it, and it appears in NO refusal, NO detail and NO error message here: every
 * refusal below is minted from a fixed detail table keyed by code, so no call site can attach a
 * message built out of the value it just read.
 */

/** The one variable a migration cannot run without. Named here rather than taken from the
 *  request: a caller-supplied variable name would let a deploy read any secret it liked. */
export const DEPLOY_MIGRATION_DATABASE_VARIABLE = "DATABASE_URL" as const;

/** Fixed prose per code, no template and no interpolation — the same discipline
 *  `ENVIRONMENT_REFUSAL_DETAILS` keeps, and for the same reason: a detail built from the caller's
 *  input is how a secret reaches a durable surface. */
export const DEPLOY_MIGRATION_CONTEXT_DETAILS = Object.freeze({
  DEPLOY_MIGRATION_DATABASE_UNSET:
    "the environment carries no database variable for the migration to reach",
  DEPLOY_MIGRATION_WORKSPACE_MISMATCH:
    "the workspace named for this deploy is not the workspace the daemon is configured to migrate",
  DEPLOY_MIGRATION_WORKSPACE_UNCONFIGURED:
    "this daemon has no configured migration workspace, so there is nothing to migrate from",
} as const);

export type DeployMigrationContextCode = keyof typeof DEPLOY_MIGRATION_CONTEXT_DETAILS;

/**
 * These refusals answer from the DEPLOY engine boundary, not the environment slice's: a mismatched
 * or unconfigured workspace is a fact about this deploy, and only the ENV_* codes forwarded
 * unchanged below belong to the environment store. Stamped, not `*_LAYER`-suffixed, because
 * `tests/security/boundary-roster.security.ts` treats a column-zero const whose name ends in
 * LAYER/LAYERS as a public security boundary owing a roster row.
 */
export interface DeployMigrationContextRefusal {
  readonly code: DeployMigrationContextCode;
  readonly detail: string;
  readonly layer: DeployEngineStamp;
  readonly ok: false;
}

export interface DeployMigrationContextOk {
  readonly input: MigrationInput;
  readonly ok: true;
}

export type DeployMigrationContextResult =
  | DeployMigrationContextOk
  | DeployMigrationContextRefusal
  | EnvironmentRefusal;

/**
 * HOST-SCOPED, read from daemon configuration and passed down raw. `workspace` and `projectRoot`
 * are deliberately NOT payload keys: a caller-supplied path would let any operator-authenticated
 * request migrate a directory nobody named, which is the same hazard the build context already
 * refuses under `DEPLOY_BUILD_CONTEXT_UNCONFIGURED`.
 */
export interface DeployMigrationContextConfig {
  readonly credential: EnvironmentCredentialSource;
  readonly now: () => string;
  readonly projectId: string;
  /** Where `.moe-next/backups/pre-migration/<environment>` is rooted. */
  readonly projectRoot: string | undefined;
  readonly store: SqliteEventStore;
  /** Where the migration files live. Absent means this daemon cannot migrate at all. */
  readonly workspace: string | undefined;
}

export interface DeployMigrationContextRequest {
  /** The deploy's ALREADY-ADMITTED environment name — passed through, never re-derived. */
  readonly environment: string;
  readonly now?: Date;
  /** The migration's replay identity. `migrateWithBackup` owns the replay; this only carries it. */
  readonly requestId: string;
  readonly sha: string;
  /** Set only when the caller archived a specific workspace for this sha; a value that disagrees
   *  with the host's configured one refuses rather than silently migrating the host's. */
  readonly workspace?: string | null;
}

function refuse(code: DeployMigrationContextCode): DeployMigrationContextRefusal {
  return Object.freeze({
    code,
    detail: DEPLOY_MIGRATION_CONTEXT_DETAILS[code],
    layer: DEPLOY_ENGINE_STAMP,
    ok: false as const,
  });
}

/**
 * Resolves `projectRoot`, `workspace` and `databaseUrl` for an admitted deploy, or refuses BEFORE
 * any migration effect. Every environment refusal is FORWARDED UNCHANGED — `readEnvironmentDelivery`
 * already carries the code AND the layer that answered (SCOPE for an unknown environment, KEY for
 * an underivable seal), and restamping either would report a layer that did not refuse.
 */
export function resolveDeployMigrationContext(
  config: DeployMigrationContextConfig,
  request: DeployMigrationContextRequest,
): DeployMigrationContextResult {
  const workspace = config.workspace;
  if (workspace === undefined || workspace === "") return refuse("DEPLOY_MIGRATION_WORKSPACE_UNCONFIGURED");
  // A supplied workspace is CHECKED, never adopted: the admitted bytes for this sha are the
  // host's, and migrating a different tree than the one the deploy archived is exactly the
  // schema-ahead-of-code split the ordering in deploy-service.ts exists to prevent.
  const named = request.workspace;
  if (named !== undefined && named !== null && named !== workspace) {
    return refuse("DEPLOY_MIGRATION_WORKSPACE_MISMATCH");
  }
  const projectRoot = config.projectRoot ?? workspace;
  const delivered = readEnvironmentDelivery(
    { credential: config.credential, now: config.now, projectId: config.projectId, store: config.store },
    request.environment,
  );
  if (!delivered.ok) return delivered;
  const databaseUrl = delivered.variables[DEPLOY_MIGRATION_DATABASE_VARIABLE];
  // An EMPTY value is as absent as a missing key: `migrateWithBackup` would hand "" to `dump`,
  // and a dump against no connection is an effect with no database behind it.
  if (databaseUrl === undefined || databaseUrl === "") return refuse("DEPLOY_MIGRATION_DATABASE_UNSET");
  return Object.freeze({
    input: Object.freeze({
      databaseUrl,
      environment: request.environment,
      projectId: config.projectId,
      projectRoot,
      requestId: request.requestId,
      sha: request.sha,
      workspace,
      ...(request.now === undefined ? {} : { now: request.now }),
    }),
    ok: true as const,
  });
}

import { effectHash, effectList, effectRecord, effectRefusal, effectSha, effectText, readEffect } from "./live-effect-read.js";
import type { EffectReadFailure } from "./live-effect-read.js";

/**
 * WHAT THE SCHEMA DID under this environment's current deploy. A PROJECT/ENVIRONMENT observation
 * and never node or goal ownership, carrying no backup path, no connection value and no download
 * affordance — the daemon bounds it, and the decoder below refuses a frame that widens it.
 */
export interface DeploymentMigration {
  readonly subject: "PROJECT_ENVIRONMENT";
  readonly environment: string;
  readonly state: "OBSERVED" | "UNKNOWN";
  readonly receiptId: string | null;
  readonly outcome: "APPLIED" | "REFUSED" | "REVERTED" | null;
  /** NULL is UNKNOWN; an empty array is the known-none it looks like. Never collapsed. */
  readonly migrations: readonly string[] | null;
  readonly backupState: "NONE" | "UNVERIFIED" | "VERIFIED" | null;
  readonly backupSha256: string | null;
  readonly refusalCode: string | null;
  readonly refusalLayer: string | null;
  readonly refusalFile: string | null;
  readonly unknownCode: string | null;
  readonly unknownLayer: string | null;
}

export interface DeploymentEnvironment {
  readonly environment: string; readonly target: string | null; readonly url: string | null;
  readonly outcome: "DEPLOYED" | "REFUSED" | null; readonly sha: string | null; readonly time: string | null;
  readonly code: string | null; readonly detail: string | null; readonly releaseDecision: string | null;
  /** REQUIRED ON THE WIRE, optional here. Required in the exact-key roster so a producer that
   *  forgets it is REFUSED rather than silently rendering an empty state; optional in the type so
   *  consumers that only read a row's target or environment are not forced to restate it. */
  readonly migration?: DeploymentMigration;
}
export type DeploymentsOutcome = EffectReadFailure | { readonly status: "DEPLOYMENTS";
  readonly goalRef: string; readonly sha: string | null; readonly releaseDecision: string | null;
  readonly environments: readonly DeploymentEnvironment[] };
const LAYER = "CONTROL_ROOM_DEPLOY";
const nullableText = (value: unknown): value is string | null => value === null || effectText(value);
const nullableSha = (value: unknown): value is string | null => value === null || effectSha(value);
const invalid = (): EffectReadFailure => ({ status: "ERROR", code: "DEPLOYMENTS_RESPONSE_INVALID", layer: LAYER });

const MIGRATION_KEYS = ["subject", "environment", "state", "receiptId", "outcome", "migrations",
  "backupState", "backupSha256", "refusalCode", "refusalLayer", "refusalFile", "unknownCode", "unknownLayer"];
const MIGRATION_FILE = /^\d{13,17}[-_][A-Za-z0-9_-]+\.(?:js|cjs|mjs|sql)$/u;
/** The SAME caps the daemon's projection enforces (migration-observation.ts). They agree on purpose:
 *  a cap that is tighter here would refuse a whole deployments frame for a batch the daemon
 *  considered legitimate, turning a large first migration into a blank card. */
const MAX_MIGRATIONS = 512;
const MAX_IDENTIFIER = 128;
const migrationFile = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_IDENTIFIER && MIGRATION_FILE.test(value);
const nullableHash = (value: unknown): value is string | null => value === null || effectHash(value);
const nullableFile = (value: unknown): value is string | null => value === null || migrationFile(value);

/**
 * The migration observation, decoded FAIL CLOSED. Beyond the member shapes it pins the pairings
 * the daemon guarantees, so a frame that widened the surface — a hash offered for a backup nobody
 * verified, a refusal word with no layer, an UNKNOWN that still carries an outcome — is refused
 * here rather than rendered as a fact.
 */
function migrationOf(value: unknown): DeploymentMigration | null {
  const row = effectRecord(value, MIGRATION_KEYS);
  if (row === null || row.subject !== "PROJECT_ENVIRONMENT"
    || !effectText(row.environment) || !/^[a-z][a-z0-9-]{0,62}$/u.test(row.environment)
    || (row.state !== "OBSERVED" && row.state !== "UNKNOWN")
    || !nullableHash(row.receiptId) || !nullableHash(row.backupSha256)
    || !nullableText(row.refusalCode) || !nullableText(row.refusalLayer) || !nullableFile(row.refusalFile)
    || !nullableText(row.unknownCode) || !nullableText(row.unknownLayer)
    || (row.outcome !== null && row.outcome !== "APPLIED" && row.outcome !== "REFUSED" && row.outcome !== "REVERTED")
    || (row.backupState !== null && row.backupState !== "NONE" && row.backupState !== "UNVERIFIED" && row.backupState !== "VERIFIED")) return null;
  const migrations = row.migrations === null ? null : effectList(row.migrations, (item) => migrationFile(item) ? item : null, MAX_MIGRATIONS);
  if (row.migrations !== null && migrations === null) return null;
  const observed = row.state === "OBSERVED";
  // UNKNOWN carries a code and a layer and NOTHING else; OBSERVED carries the receipt's facts and
  // no unknown code. Collapsing the two is how "we could not read it" becomes "nothing to apply".
  if (observed !== (row.receiptId !== null) || observed !== (row.outcome !== null)
    || observed !== (migrations !== null) || observed !== (row.backupState !== null)
    || observed === (row.unknownCode !== null) || observed === (row.unknownLayer !== null)) return null;
  // A hash is a claim the backup was found; it may only ride a VERIFIED state.
  if ((row.backupSha256 !== null) !== (row.backupState === "VERIFIED")) return null;
  // Code and layer are both-or-neither, a failing file needs a refusal to belong to, and REFUSED
  // is the one outcome that carries one.
  if ((row.refusalCode !== null) !== (row.refusalLayer !== null)) return null;
  if (row.refusalFile !== null && row.refusalCode === null) return null;
  if (observed && (row.outcome === "REFUSED") !== (row.refusalCode !== null)) return null;
  return { subject: "PROJECT_ENVIRONMENT", environment: row.environment, state: row.state,
    receiptId: row.receiptId, outcome: row.outcome, migrations, backupState: row.backupState,
    backupSha256: row.backupSha256, refusalCode: row.refusalCode, refusalLayer: row.refusalLayer,
    refusalFile: row.refusalFile, unknownCode: row.unknownCode, unknownLayer: row.unknownLayer };
}

function environmentOf(value: unknown): DeploymentEnvironment | null {
  const row = effectRecord(value, ["environment", "target", "url", "outcome", "sha", "time", "code", "detail", "releaseDecision", "migration"]);
  if (row === null || !effectText(row.environment) || !/^[a-z][a-z0-9-]{0,62}$/u.test(row.environment)
    || !nullableText(row.target) || !nullableText(row.url) || !nullableSha(row.sha)
    || !nullableText(row.time) || !nullableText(row.code) || !nullableText(row.detail)
    || !nullableText(row.releaseDecision) || (row.outcome !== null && row.outcome !== "DEPLOYED" && row.outcome !== "REFUSED")) return null;
  if (row.url !== null && !/^https?:\/\//u.test(row.url)) return null;
  if (row.outcome === "DEPLOYED" && (row.sha === null || row.time === null || row.code !== null)) return null;
  const migration = migrationOf(row.migration);
  // The observation is about THIS row's environment; one carrying another's is refused, not shown.
  if (migration === null || migration.environment !== row.environment) return null;
  return { environment: row.environment, target: row.target, url: row.url, outcome: row.outcome,
    sha: row.sha, time: row.time, code: row.code, detail: row.detail, releaseDecision: row.releaseDecision,
    migration };
}
export function mapDeploymentsAnswer(status: number, body: unknown): DeploymentsOutcome {
  const refusal = effectRefusal(body); if (refusal !== null) return refusal;
  const row = effectRecord(body, ["outcome", "goalRef", "sha", "releaseDecision", "environments"]);
  if (status !== 200 || row === null || row.outcome !== "DEPLOYMENTS" || !effectText(row.goalRef)
    || !nullableSha(row.sha) || !nullableText(row.releaseDecision)) return invalid();
  const environments = effectList(row.environments, environmentOf, 32);
  if (environments === null || new Set(environments.map((entry) => entry.environment)).size !== environments.length) return invalid();
  return { status: "DEPLOYMENTS", goalRef: row.goalRef, sha: row.sha, releaseDecision: row.releaseDecision, environments };
}
export async function readDeployments(headers: Readonly<Record<string, string>>, goalRef: string): Promise<DeploymentsOutcome> {
  const answer = await readEffect(headers, "/deployments/read", { goalRef }, mapDeploymentsAnswer, LAYER);
  return answer.status === "DEPLOYMENTS" && answer.goalRef !== goalRef ? invalid() : answer;
}

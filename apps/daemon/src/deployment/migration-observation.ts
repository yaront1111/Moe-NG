import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, join, sep } from "node:path";

import type { SqliteEventStore } from "@moe/store";

import {
  BACKUP_DIRECTORY, BACKUP_LEAF, PRE_MIGRATION_BACKUP_LEAF,
} from "../bootstrap/activation-receipts-measure.js";
import { migrationFilename, readMigrationReceipt } from "../repository/migrations/migration-receipt.js";
import type { MigrationReceipt } from "../repository/migrations/migration-receipt.js";
import type { DeployReceiptV1 } from "./deploy-receipt-contracts.js";

/**
 * THE ONE PLACE a durable migration receipt becomes a fact safe to serve.
 *
 * WHAT IT IS ABOUT. A receipt has eleven keys and NONE of them is a nodeRef or a goalRef
 * (migration-receipt.ts), so the only thing it can honestly be attributed to is a PROJECT and an
 * ENVIRONMENT. Every observation says so in `subject`; nothing here may be rendered as node or
 * goal ownership.
 *
 * HOW THE RECEIPT IS FOUND: BY DURABLE KEY, NEVER BY SEARCH. The deploy composes its migration
 * with `requestId: decisionId` (deploy-command.ts), so the deploy receipt's `decisionId` IS the
 * migration receipt's `requestId` and `readMigrationReceipt` resolves it directly. No aggregate is
 * enumerated and nothing is selected by filename, sha, latest timestamp or an arbitrary request
 * id — those are the matches that would attach a stranger's receipt to this environment's row.
 *
 * IT REPORTS THE RECEIPT AT THE KEY AND DOES NOT CHASE A LATER REVERT. A REVERTED receipt records
 * no durable link back to the batch it undid (migration-down-service.ts keeps the source's sha but
 * not its request id), so finding one from an APPLIED receipt would require a sha or timestamp
 * match — exactly what is forbidden above. An operator therefore reads this row as "what the
 * receipt at this deploy's key says", which is the only claim the data supports.
 *
 * UNKNOWN IS NOT EMPTY. No receipt at the key means the deploy composed no migration at all
 * (`ports.migrate` is optional) — that is UNKNOWN, not "nothing to apply". A receipt that cannot
 * be decoded, or that disagrees with the row it would sit on, is UNKNOWN carrying the refusing
 * code and layer. Only a decoded receipt yields `migrations`, and only then does an empty list
 * mean the known-none it looks like.
 */

export const MIGRATION_OBSERVATION_SUBJECT = "PROJECT_ENVIRONMENT" as const;
const NO_RECEIPT = "MIGRATION_RECEIPT_ABSENT" as const;
const INVALID = "MIGRATION_RECEIPT_INVALID" as const;
const LAYER = "DAEMON_INGRESS" as const;
/** `<abs path>.sql@sha256:<64 hex>` is what the engine writes; only the hash may ever leave. */
const BACKUP_REF = /^(?<path>.+\.sql)@sha256:(?<digest>[a-f0-9]{64})$/u;
const BACKUP_LEAF_NAME = /^\d{17}\.sql$/u;
/**
 * Bounds the projection adds ON TOP of the decoder, because the decoder's are too loose to serve.
 * `migrationFilename` constrains the CHARSET but not the LENGTH, and a receipt detail is admitted
 * up to 4096 characters — so a caller-supplied request id shaped like a migration filename could
 * reach the UI 4096 characters long. `applied` is likewise unbounded in COUNT below the receipt's
 * 1 MiB envelope, which at ~30 bytes an entry is tens of thousands. Both caps are far above any
 * real batch and both FAIL CLOSED rather than truncating: a silently shortened list of what ran
 * against a database is a worse answer than "unknown".
 */
const MAX_IDENTIFIER = 128;
export const MAX_MIGRATION_IDENTIFIERS = 512;
const identifier = (value: unknown): value is string =>
  migrationFilename(value) && value.length <= MAX_IDENTIFIER;

export type MigrationObservationState = "OBSERVED" | "UNKNOWN";
export type MigrationBackupState = "NONE" | "UNVERIFIED" | "VERIFIED";

/**
 * The served shape, deliberately FLAT: one exact key roster a strict decoder can pin in a single
 * pass, with no nested optional records to widen the surface a member at a time.
 */
export interface MigrationObservation {
  /** Never a node, never a goal. The receipt carries no ref that could support either. */
  readonly subject: typeof MIGRATION_OBSERVATION_SUBJECT;
  readonly environment: string;
  readonly state: MigrationObservationState;
  /** The receipt's own id, or null while UNKNOWN. */
  readonly receiptId: string | null;
  readonly outcome: "APPLIED" | "REFUSED" | "REVERTED" | null;
  /** The migration identifiers the receipt MOVED — applied when APPLIED, undone when REVERTED.
   *  NULL while UNKNOWN; an empty array is the known-none it reads as and never stands in for
   *  "we could not tell". */
  readonly migrations: readonly string[] | null;
  /** NONE when the receipt carries no backup, VERIFIED only when a confined backup file was found
   *  on disk, UNVERIFIED when one is claimed but could not be confirmed. Null while UNKNOWN. */
  readonly backupState: MigrationBackupState | null;
  /** The backup's content hash, and NEVER its path — a reference, not a download. Present only
   *  when VERIFIED, so a missing or unconfirmable backup can never read as an existing one. */
  readonly backupSha256: string | null;
  readonly refusalCode: string | null;
  readonly refusalLayer: string | null;
  /** The failing migration's BASENAME, admitted only by the production filename guard. Every other
   *  refusal detail — a caller-supplied request id, a connection string, a diagnostic — is
   *  withheld entirely rather than truncated. */
  readonly refusalFile: string | null;
  /** Why the observation is UNKNOWN, with the layer that answered. Null when OBSERVED. Kept apart
   *  from the refusal members: "the migration refused" and "the receipt could not be read" are
   *  different answers and a reader must not have to guess which one it is holding. */
  readonly unknownCode: string | null;
  readonly unknownLayer: string | null;
}

function unknown(environment: string, code: string): MigrationObservation {
  return Object.freeze({
    subject: MIGRATION_OBSERVATION_SUBJECT, environment, state: "UNKNOWN" as const,
    receiptId: null, outcome: null, migrations: null, backupState: null, backupSha256: null,
    refusalCode: null, refusalLayer: null, refusalFile: null, unknownCode: code, unknownLayer: LAYER,
  });
}

/**
 * The backup, as a reference. VERIFIED demands all four: the reference parses, its leaf is a
 * pre-migration dump name, it sits under this environment's confined pre-migration directory, and
 * a real file (not a symlink, not a directory) is there now. Anything else is UNVERIFIED with the
 * hash withheld — a backup nobody could confirm must not be served as one that exists.
 */
function backupOf(
  reference: string | null, environment: string, root: string | null,
): { readonly state: MigrationBackupState; readonly sha256: string | null } {
  if (reference === null) return { state: "NONE", sha256: null };
  const parsed = BACKUP_REF.exec(reference)?.groups;
  const path = parsed?.["path"];
  const digest = parsed?.["digest"];
  if (path === undefined || digest === undefined || !BACKUP_LEAF_NAME.test(basename(path))) {
    return { state: "UNVERIFIED", sha256: null };
  }
  if (root === null) return { state: "UNVERIFIED", sha256: null };
  try {
    const confined = join(
      realpathSync(root), BACKUP_DIRECTORY, BACKUP_LEAF, PRE_MIGRATION_BACKUP_LEAF, environment,
    );
    if (path !== join(confined, basename(path)) || !path.startsWith(confined + sep)) {
      return { state: "UNVERIFIED", sha256: null };
    }
    if (!existsSync(path)) return { state: "UNVERIFIED", sha256: null };
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return { state: "UNVERIFIED", sha256: null };
  } catch {
    return { state: "UNVERIFIED", sha256: null };
  }
  return { state: "VERIFIED", sha256: digest };
}

/**
 * The receipt, bounded. Every outward member is re-validated HERE rather than forwarded: the
 * decoder guarantees these shapes on the way in, and this guarantees them again on the way out,
 * so a future decoder relaxation cannot quietly widen what reaches HTTP.
 */
function observed(
  receipt: MigrationReceipt, environment: string, root: string | null,
): MigrationObservation {
  // A receipt whose identifiers do not all survive the production filename guard AND the length and
  // count caps is not a fact this surface can bound, so it fails closed rather than being served
  // with the bad entry dropped or the list quietly shortened.
  if (receipt.applied.length > MAX_MIGRATION_IDENTIFIERS || !receipt.applied.every(identifier)) {
    return unknown(environment, INVALID);
  }
  const backup = backupOf(receipt.backupRef, environment, root);
  const detail = receipt.refusal?.detail;
  return Object.freeze({
    subject: MIGRATION_OBSERVATION_SUBJECT,
    // THE ROW'S environment, never the receipt's. The caller has already refused a receipt that
    // disagrees, so the two are equal — taking it from the parameter makes "the observation is
    // about the row it sits on" structural rather than dependent on that check running first.
    environment,
    state: "OBSERVED" as const,
    receiptId: receipt.receiptId,
    outcome: receipt.outcome,
    migrations: Object.freeze([...receipt.applied]),
    backupState: backup.state,
    backupSha256: backup.sha256,
    refusalCode: receipt.refusal?.code ?? null,
    refusalLayer: receipt.refusal?.layer ?? null,
    refusalFile: identifier(detail) ? detail : null,
    unknownCode: null,
    unknownLayer: null,
  });
}

export interface MigrationObservationOptions {
  /** The project root whose confined pre-migration backup directory a reference must sit in. When
   *  absent the backup stays UNVERIFIED: no root means no confinement proof, and an unproven
   *  backup is never promoted to an existing one. */
  readonly backupRoot?: string | null;
}

/**
 * The migration observation for ONE environment, resolved from the deploy receipt already on that
 * environment's row. `deployReceipt === null` — the environment has never deployed — is UNKNOWN
 * for the same reason a deploy without a migration is: there is no evidence either way.
 */
export function readMigrationObservation(
  store: SqliteEventStore, projectId: string, environment: string,
  deployReceipt: DeployReceiptV1 | null, options: MigrationObservationOptions = {},
): MigrationObservation {
  const root = options.backupRoot ?? null;
  if (deployReceipt === null) return unknown(environment, NO_RECEIPT);
  let receipt: MigrationReceipt | null;
  try {
    receipt = readMigrationReceipt(store, projectId, deployReceipt.decisionId);
  } catch {
    // `readMigrationReceipt` throws MIGRATION_RECEIPT_INVALID for a corrupt or unverifiable
    // record. That is UNKNOWN carrying the decoder's own code — never APPLIED, and never the
    // "no pending work" an empty answer would be read as.
    return unknown(environment, INVALID);
  }
  if (receipt === null) return unknown(environment, NO_RECEIPT);
  // The key lookup already SELECTED the receipt; this only checks the selected receipt agrees with
  // the row it would be placed on. A receipt for another environment is a defect, not a candidate
  // to be matched against — it fails closed here rather than bleeding onto this environment.
  if (receipt.environment !== environment) return unknown(environment, INVALID);
  return observed(receipt, environment, root);
}

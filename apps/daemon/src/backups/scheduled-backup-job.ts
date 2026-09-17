import type { SqliteEventStore } from "@moe/store";

import { nodeActivationReceiptPorts } from "../bootstrap/activation-receipts-measure.js";
import { DEPLOY_MIGRATION_DATABASE_VARIABLE } from "../deployment/deploy-migration-context.js";
import { ENVIRONMENT_NAMES } from "../environment/environment-contracts.js";
import { readEnvironmentDelivery } from "../environment/environment-delivery.js";
import type { EnvironmentCredentialSource } from "../environment/environment-projection.js";
import { nodeBackupPorts } from "./backup-ports.js";
import {
  BACKUP_RESTORE_PROOF_SIDECAR_SUFFIX, createBackupRestoreProofStore,
} from "./backup-restore-proof.js";
import { runScheduledBackup } from "./scheduled-backup.js";

/** The durable schedule id the composition arms the run under. */
export const SCHEDULED_BACKUP_JOB_ID = "backups/scheduled" as const;
/** Daily: the restore-proof retention (backup-restore-proof.ts) is sized in daily backups. */
export const SCHEDULED_BACKUP_INTERVAL_MS = 86_400_000;

/** Server facts only; the composition root is the one place all five are known. */
export interface ScheduledBackupJobConfig {
  readonly clock: () => string;
  readonly credential: EnvironmentCredentialSource;
  readonly projectId: string;
  /** Where `.moe-next/backups/scheduled` is rooted. Null or empty backs up nothing. */
  readonly projectRoot: string | null;
  readonly store: SqliteEventStore;
}

/**
 * THE SCHEDULER'S CALLER OF `runScheduledBackup`, and the only production one.
 *
 * THE PROOF WRITER OPENS THE SIDECAR `backupReads` SERVES. Both derive the path from the store's
 * own database path plus the one shared suffix, so what a run records is what `/backups/read`
 * answers. A store with no durable path has no sidecar to agree on and backs up nothing.
 *
 * THE DATABASE URL IS THE DEPLOY MIGRATION'S VARIABLE, read through the same delivery seam
 * (deploy-migration-context.ts), so a backup and a migration cannot disagree about which database
 * an environment means. Unset or empty is DATABASE_ABSENT. An environment whose delivery REFUSES
 * is left out of the run rather than reported absent: an unreadable store is not a missing
 * database, and nothing here may put the refusal's value on a durable surface.
 *
 * NO CWD FALLBACK for the project root, the same rule the composition applies to the preview
 * workspace: backups written under whatever directory the process happened to start in would be
 * a second backup location nobody searches during an incident.
 */
export function createScheduledBackupJob(
  config: ScheduledBackupJobConfig,
): (signal: AbortSignal) => Promise<void> {
  return async (): Promise<void> => {
    const databasePath = config.store.getHealth().databasePath;
    if (databasePath === null || config.projectRoot === null || config.projectRoot === "") return;
    const environments = ENVIRONMENT_NAMES.flatMap((name) => {
      const delivered = readEnvironmentDelivery({
        credential: config.credential, now: config.clock, projectId: config.projectId, store: config.store,
      }, name);
      if (!delivered.ok) return [];
      const databaseUrl = delivered.variables[DEPLOY_MIGRATION_DATABASE_VARIABLE];
      return [{ databaseUrl: databaseUrl === undefined || databaseUrl === "" ? null : databaseUrl, name }];
    });
    await runScheduledBackup(
      { environments, now: new Date(config.clock()), projectRoot: config.projectRoot, storePath: databasePath },
      nodeBackupPorts(), nodeActivationReceiptPorts().fs,
      createBackupRestoreProofStore(`${databasePath}${BACKUP_RESTORE_PROOF_SIDECAR_SUFFIX}`, config.projectId),
    );
  };
}

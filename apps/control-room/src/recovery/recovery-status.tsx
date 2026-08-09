import type { JSX } from "react";

import { FactList, Panel } from "../nodes/node-authority.js";
import type { FactRowSpec, ProvenanceHandler, SuppliedFact } from "../nodes/node-authority.js";
import { RecoveryExternalInventory } from "./recovery-external.js";
import type { RecoveryInventoryClassPresentation } from "./recovery-external.js";
import { RecoveryActions } from "./recovery-actions.js";
import type {
  RecoveryActionPresentation,
  RecoveryAuthorityMode,
  RecoveryConfirmationHandler,
} from "./recovery-actions.js";

/**
 * Outbox, versions, backup/export, and post-restore inventory (spec §2.10, §4.14;
 * design 16.5).
 *
 * Every number here is one the daemon supplied. This module does not subtract one
 * cursor from another to call the outbox live, does not compare an engine version
 * against a minimum to call the store compatible, and does not read an empty inventory
 * as a finished recovery. Missing proof stays UNKNOWN; the RPO limit is stated whether
 * or not any proof arrived, because that sentence is a property of backups rather than
 * of this generation.
 */
export interface OutboxPresentation {
  readonly aggregate: SuppliedFact;
  readonly appliedCursor: SuppliedFact;
  readonly emittedCursor: SuppliedFact;
  readonly lagState: SuppliedFact;
  readonly poison: SuppliedFact;
}

export interface VersionsPresentation {
  /** The daemon's own verdict. Never computed from engineVersion and requiredMinimum. */
  readonly compatibility: SuppliedFact;
  readonly engineVersion: SuppliedFact;
  readonly requiredMinimum: SuppliedFact;
  readonly schemaVersion: SuppliedFact;
}

/** Exactly one `BackupGeneration`. Restore never mixes generations, nor does this view. */
export interface BackupPresentation {
  readonly byteVerification: SuppliedFact;
  readonly committedCursor: SuppliedFact;
  readonly generation: SuppliedFact;
  readonly keyChain: SuppliedFact;
  readonly manifestDigest: SuppliedFact;
  readonly objectCoverage: SuppliedFact;
  readonly rpo: SuppliedFact;
}

export interface ExportPresentation {
  readonly committedSequence: SuppliedFact;
  readonly generation: SuppliedFact;
}

export interface RecoveryStatusProps {
  readonly authorityMode: RecoveryAuthorityMode;
  readonly backup: BackupPresentation;
  readonly disabledCopy?: string | undefined;
  readonly export: ExportPresentation;
  readonly inventory: readonly RecoveryInventoryClassPresentation[];
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly onRequestConfirmation?: RecoveryConfirmationHandler | undefined;
  readonly outbox: OutboxPresentation;
  readonly projectActions: readonly RecoveryActionPresentation[];
  readonly versions: VersionsPresentation;
}

/** Design 84 and 972: a restore is honest about what it cannot have carried. */
const RPO_LIMIT = "Acknowledged events after this backup cursor are outside this backup's "
  + "RPO. A disaster restore does not claim they survived.";

/** Design 972: an export is weaker than a backup, and the difference is not cosmetic. */
const EXPORT_NOTE = "An export is not a restorable backup: it names one committed sequence "
  + "and carries no RPO, no artifact key chain, and no restore authority.";

function outboxRows(outbox: OutboxPresentation): readonly FactRowSpec[] {
  return [
    ["recovery.outbox.applied", "Applied cursor", outbox.appliedCursor],
    ["recovery.outbox.emitted", "Emitted cursor", outbox.emittedCursor],
    ["recovery.outbox.lag", "Lag state", outbox.lagState],
    ["recovery.outbox.poison", "Poison entries", outbox.poison],
    ["recovery.outbox.aggregate", "Aggregates covered", outbox.aggregate],
  ];
}

function versionRows(versions: VersionsPresentation): readonly FactRowSpec[] {
  return [
    ["recovery.versions.engine", "Storage engine", versions.engineVersion],
    ["recovery.versions.schema", "Schema version", versions.schemaVersion],
    ["recovery.versions.minimum", "Required minimum", versions.requiredMinimum],
    ["recovery.versions.compatibility", "Daemon compatibility verdict",
      versions.compatibility],
  ];
}

function backupRows(backup: BackupPresentation): readonly FactRowSpec[] {
  return [
    ["recovery.backup.generation", "Backup generation", backup.generation],
    ["recovery.backup.cursor", "Committed cursor", backup.committedCursor],
    ["recovery.backup.rpo", "RPO", backup.rpo],
    ["recovery.backup.manifestdigest", "Manifest digest", backup.manifestDigest],
    ["recovery.backup.objectcoverage", "Object digest and size coverage",
      backup.objectCoverage],
    ["recovery.backup.byteverification", "Byte verification", backup.byteVerification],
    ["recovery.backup.keychain", "Key rotation chain", backup.keyChain],
  ];
}

export function RecoveryStatus(props: RecoveryStatusProps): JSX.Element {
  const {
    authorityMode, backup, disabledCopy, inventory, onProvenance, onRequestConfirmation,
    outbox, projectActions, versions,
  } = props;
  const exported = props.export;
  return (
    <section aria-label="Recovery" data-testid="cr.surface.recovery">
      <Panel heading="Outbox" testId="cr.health.outbox">
        <FactList onProvenance={onProvenance} rows={outboxRows(outbox)} />
      </Panel>
      <Panel heading="Versions" testId="cr.health.versions">
        <FactList onProvenance={onProvenance} rows={versionRows(versions)} />
      </Panel>
      <Panel heading="Backup generation" testId="cr.health.backup">
        <FactList onProvenance={onProvenance} rows={backupRows(backup)} />
        <p data-testid="cr.health.backup.rpolimit">{RPO_LIMIT}</p>
      </Panel>
      <Panel heading="Export" testId="cr.health.export">
        <FactList
          onProvenance={onProvenance}
          rows={[
            ["recovery.export.generation", "Export generation", exported.generation],
            ["recovery.export.sequence", "Committed sequence", exported.committedSequence],
          ]}
        />
        <p data-testid="cr.health.export.note">{EXPORT_NOTE}</p>
      </Panel>
      <RecoveryExternalInventory classes={inventory} onProvenance={onProvenance} />
      <RecoveryActions
        authorityMode={authorityMode}
        disabledCopy={disabledCopy}
        onRequestConfirmation={onRequestConfirmation}
        presentations={projectActions}
        testId="cr.recovery.project"
      />
    </section>
  );
}

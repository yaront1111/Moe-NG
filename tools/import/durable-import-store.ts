import { applyImport, refuseImport } from "../../packages/import/src/index.js";
import type {
  ImportCommitInput, ImportEventRefused, ImportRefused, ImportReport, ImportStorePort,
  LegacySourceRecord, SourceManifest,
} from "../../packages/import/src/index.js";
import { DurableStoreError } from "../../packages/store/src/store-contracts.js";
import type { CommitInput, CommitResult, DurableStoreErrorCode } from "../../packages/store/src/store-contracts.js";
import type { SqliteEventStore } from "../../packages/store/src/sqlite-event-store.js";

/**
 * The durable `ImportStorePort`: what `applyImport` DRAFTS becomes rows in a real store.
 *
 * THE WHOLE ADAPTER IS THE ABSENCE OF TRANSFORMATION. `ImportCommitInput` already IS a
 * `CommitInput`, so the drafted value is handed to the store unchanged — no re-encoding
 * of a payload, no spread-with-defaults that could let the store's generic
 * `DOMAIN_EVENT_SCHEMA_VERSION` displace the draft's required one, no derived fact and no
 * added event. The single `const commitInput: CommitInput = input` below is that claim
 * stated where the compiler checks it.
 *
 * WHY IT CATCHES. `applyImport` wraps every THROWN commit failure as
 * IMPORT_COMMIT_FAILED / APPLY, which would erase the difference between "the store
 * refused this command" and "the store broke". So a conflict is recorded with the STORE'S
 * OWN code and answered from that record, while any other failure is left to flow through
 * and be reported by `applyImport` itself.
 *
 * It is deliberately NOT inside @moe/import: the port is declared structurally there
 * precisely so that package never depends on @moe/store, and this file is the one place
 * the two shapes are allowed to meet.
 */

/** The layer that answered a durable refusal: the store itself, never @moe/import's APPLY. */
export const DURABLE_COMMIT_LAYER = "STORE" as const;

/**
 * Store answers that mean "this command was refused", as opposed to "the store broke".
 * Both are reachable from `applyImport`'s fixed `expectedVersion: 0` and its manifest-bound
 * command id: a re-import with different facts collides on the id, and a foreign write to
 * the aggregate moves its tail.
 */
const CONFLICT_CODES: readonly DurableStoreErrorCode[] = Object.freeze([
  "COMMAND_ID_CONFLICT",
  "EXPECTED_VERSION_CONFLICT",
]);

export interface DurableCommitRefused {
  /** The store's own code, verbatim. Never minted here, only ever copied off an error. */
  readonly code: DurableStoreErrorCode;
  readonly detail: string;
  readonly layer: typeof DURABLE_COMMIT_LAYER;
  readonly outcome: "REFUSED";
}

export interface DurableCommitted {
  readonly currentVersion: number;
  readonly eventIds: readonly string[];
  /** The store's own disposition, verbatim: a replay is never reported as a fresh commit. */
  readonly outcome: "COMMITTED" | "REPLAYED";
  readonly report: ImportReport;
}

export type CommitLegacyImportResult =
  | DurableCommitRefused
  | DurableCommitted
  | ImportEventRefused
  | ImportRefused;

export interface CommitLegacyImportInput {
  readonly declaredRecordCount: number | null;
  readonly knownFields: readonly string[];
  readonly manifest: SourceManifest;
  readonly maxEventsPerCommit: number;
  readonly records: readonly LegacySourceRecord[];
  readonly store: SqliteEventStore;
}

/** What the store answered, captured so the composer answers from it rather than guesses. */
interface CommitRecord {
  receipt: CommitResult | null;
  refusal: DurableCommitRefused | null;
}

/**
 * A conflict is recorded and RETHROWN: rethrowing keeps `applyImport` from reporting a
 * success it did not have, and the record keeps the store's code from being restamped.
 */
function durablePort(store: SqliteEventStore, record: CommitRecord): ImportStorePort {
  return {
    commit: (input: ImportCommitInput) => {
      const commitInput: CommitInput = input;
      try {
        const receipt = store.commit(commitInput);
        record.receipt = receipt;
        return { currentVersion: receipt.currentVersion };
      } catch (cause) {
        if (cause instanceof DurableStoreError && CONFLICT_CODES.includes(cause.code)) {
          record.refusal = Object.freeze({
            code: cause.code,
            detail: cause.message,
            layer: DURABLE_COMMIT_LAYER,
            outcome: "REFUSED" as const,
          });
        }
        throw cause;
      }
    },
  };
}

/**
 * Runs the import through `applyImport` and commits its draft to the given store.
 *
 * The recorded refusal is consulted FIRST: `applyImport`'s own result for that path is
 * IMPORT_COMMIT_FAILED / APPLY, and returning it would restamp a store-level conflict as
 * an importer-level failure.
 */
export function commitLegacyImport(input: CommitLegacyImportInput): CommitLegacyImportResult {
  const record: CommitRecord = { receipt: null, refusal: null };
  const result = applyImport({
    declaredRecordCount: input.declaredRecordCount,
    knownFields: input.knownFields,
    manifest: input.manifest,
    maxEventsPerCommit: input.maxEventsPerCommit,
    records: input.records,
    store: durablePort(input.store, record),
  });
  if (record.refusal !== null) return record.refusal;
  if ("outcome" in result) return result;
  const receipt = record.receipt;
  if (receipt === null) {
    return refuseImport(
      "IMPORT_COMMIT_FAILED", "APPLY", "the importer reported success without committing",
    );
  }
  return Object.freeze({
    currentVersion: receipt.currentVersion,
    eventIds: receipt.eventIds,
    outcome: receipt.disposition,
    report: result,
  });
}

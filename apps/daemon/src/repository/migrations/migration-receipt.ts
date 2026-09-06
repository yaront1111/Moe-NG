import { createHash } from "node:crypto";
import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

export const MIGRATION_RECEIPT_VERSION = "moe-migration-receipt/1";
const principal = "daemon:migration-engine";
const kind = "internal.repository.migration_receipt";
const codeLayers = Object.freeze({ MIGRATION_BACKUP_FAILED: "DAEMON_INGRESS",
  MIGRATION_FAILED: "DAEMON_INGRESS", MIGRATION_IN_PROGRESS: "DAEMON_INGRESS", MIGRATION_RECEIPT_INVALID: "DAEMON_INGRESS",
  MIGRATION_RECEIPT_CONFLICT: "DAEMON_INGRESS", MIGRATION_RECEIPT_WRITE_FAILED: "DAEMON_INGRESS" } as const);
export type MigrationCode = keyof typeof codeLayers;
export const migrationRefusal = (code: MigrationCode, detail: string) =>
  Object.freeze({ code, layer: codeLayers[code], detail });
export function migrationError(code: MigrationCode): Error {
  return Object.assign(new Error(`${code}@${codeLayers[code]}`), migrationRefusal(code, code));
}
export interface MigrationReceipt {
  readonly version: typeof MIGRATION_RECEIPT_VERSION;
  readonly receiptId: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly environment: string;
  readonly sha: string;
  readonly decidedAt: string;
  readonly applied: readonly string[];
  readonly backupRef: string | null;
  readonly outcome: "APPLIED" | "REFUSED";
  readonly refusal: ReturnType<typeof migrationRefusal> | null;
}
type Decode = Readonly<{ ok: true; receipt: MigrationReceipt }>
  | Readonly<{ ok: false; code: "MIGRATION_RECEIPT_INVALID"; layer: "DAEMON_INGRESS" }>;
const invalid = (): Decode => ({ ok: false, code: "MIGRATION_RECEIPT_INVALID", layer: "DAEMON_INGRESS" });
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;
export const migrationFilename = (value: unknown): value is string =>
  typeof value === "string" && /^\d{13,17}[-_][A-Za-z0-9_-]+\.(?:js|cjs|mjs|sql)$/u.test(value);
const keys = ["version", "receiptId", "requestId", "projectId", "environment", "sha", "decidedAt",
  "applied", "backupRef", "outcome", "refusal"];
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, names: readonly string[]) =>
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
export function migrationReceiptId(projectId: string, requestId: string): string {
  return createHash("sha256").update(JSON.stringify([MIGRATION_RECEIPT_VERSION, projectId, requestId])).digest("hex");
}

export function decodeMigrationReceiptBytes(input: unknown): Decode {
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok || !object(decoded.value) || !exact(decoded.value, keys)) return invalid();
  const v = decoded.value;
  if (v.version !== MIGRATION_RECEIPT_VERSION || !text(v.projectId) || !text(v.requestId)
    || !text(v.environment) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(v.environment)
    || !text(v.sha) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(v.sha)
    || !text(v.decidedAt) || !Number.isFinite(Date.parse(v.decidedAt))
    || v.receiptId !== migrationReceiptId(v.projectId, v.requestId)
    || !Array.isArray(v.applied) || !v.applied.every(migrationFilename)
    || new Set(v.applied).size !== v.applied.length
    || !(v.backupRef === null || (text(v.backupRef) && /^.+\.sql@sha256:[a-f0-9]{64}$/u.test(v.backupRef)))) return invalid();
  let refusal: ReturnType<typeof migrationRefusal> | null = null;
  if (v.refusal !== null) {
    if (!object(v.refusal) || !exact(v.refusal, ["code", "layer", "detail"])
      || typeof v.refusal.code !== "string" || !Object.hasOwn(codeLayers, v.refusal.code)
      || v.refusal.layer !== codeLayers[v.refusal.code as MigrationCode] || !text(v.refusal.detail)) return invalid();
    refusal = migrationRefusal(v.refusal.code as MigrationCode, v.refusal.detail);
  }
  if ((v.outcome !== "APPLIED" && v.outcome !== "REFUSED")
    || (v.outcome === "APPLIED" && (refusal !== null || v.backupRef === null))
    || (v.outcome === "REFUSED" && (refusal === null || v.applied.length !== 0))) return invalid();
  return { ok: true, receipt: Object.freeze({ version: MIGRATION_RECEIPT_VERSION,
    projectId: v.projectId, requestId: v.requestId, receiptId: v.receiptId as string,
    environment: v.environment, sha: v.sha, decidedAt: v.decidedAt, applied: Object.freeze([...v.applied]),
    backupRef: v.backupRef as string | null, outcome: v.outcome, refusal }) };
}

export function readMigrationReceipt(store: SqliteEventStore, projectId: string, requestId: string): MigrationReceipt | null {
  const id = migrationReceiptId(projectId, requestId);
  const decision = store.getCommandDecision({ commandId: id, principalId: principal, projectId });
  if (decision === null) return null;
  const decoded = decodeMigrationReceiptBytes(decision.resultBytes);
  if (!decoded.ok || decision.commandKind !== kind || decision.effectDisposition !== "EFFECTS_COMMITTED"
    || decision.targetAggregateId !== `migration:${id}` || decoded.receipt.receiptId !== id
    || decoded.receipt.projectId !== projectId || decoded.receipt.requestId !== requestId) {
    throw migrationError("MIGRATION_RECEIPT_INVALID");
  }
  return decoded.receipt;
}

export function recordMigrationReceipt(store: SqliteEventStore, receipt: MigrationReceipt): MigrationReceipt {
  const resultBytes = new TextEncoder().encode(JSON.stringify(receipt));
  const decoded = decodeMigrationReceiptBytes(resultBytes);
  if (!decoded.ok) throw migrationError("MIGRATION_RECEIPT_INVALID");
  const existing = readMigrationReceipt(store, receipt.projectId, receipt.requestId);
  if (existing !== null) {
    if (JSON.stringify(existing) !== JSON.stringify(decoded.receipt)) throw migrationError("MIGRATION_RECEIPT_CONFLICT");
    return existing;
  }
  const result = store.commitExpectedVersionDecision({ commandKind: kind, committedResultBytes: resultBytes,
    correlationId: receipt.requestId, decidedAt: receipt.decidedAt, expectedVersion: 0,
    key: { commandId: receipt.receiptId, principalId: principal, projectId: receipt.projectId },
    requestBytes: resultBytes, targetAggregateId: `migration:${receipt.receiptId}`,
    events: [{ eventId: `${receipt.receiptId}-recorded`, eventType: "MigrationRecorded", payload: resultBytes }],
  });
  if (result.decision.effectDisposition !== "EFFECTS_COMMITTED") throw migrationError("MIGRATION_RECEIPT_WRITE_FAILED");
  const persisted = readMigrationReceipt(store, receipt.projectId, receipt.requestId);
  if (persisted === null) throw migrationError("MIGRATION_RECEIPT_WRITE_FAILED");
  return persisted;
}

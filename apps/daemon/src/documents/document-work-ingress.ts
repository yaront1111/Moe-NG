import { copyFixedBytes, exactDataRecord } from "./document-work-safe-value.js";

const INPUT_KEYS = Object.freeze([
  "commandId",
  "correlationId",
  "decidedAt",
  "expectedVersion",
  "principalId",
  "projectId",
  "proposalBytes",
] as const);

export interface DocumentWorkRecordSnapshot {
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly expectedVersion: number;
  readonly principalId: string;
  readonly projectId: string;
  readonly proposalBytes: Uint8Array;
}

export function snapshotDocumentWorkRecordInput(
  value: unknown,
): DocumentWorkRecordSnapshot | null {
  const record = exactDataRecord(value, INPUT_KEYS);
  if (record === null) return null;
  const {
    commandId, correlationId, decidedAt, expectedVersion, principalId, projectId,
  } = record;
  if (
    typeof commandId !== "string"
    || typeof correlationId !== "string"
    || typeof decidedAt !== "string"
    || !Number.isSafeInteger(expectedVersion)
    || (expectedVersion as number) < 0
    || typeof principalId !== "string"
    || typeof projectId !== "string"
  ) return null;
  const proposalBytes = copyFixedBytes(record.proposalBytes);
  if (proposalBytes === null) return null;
  return Object.freeze({
    commandId,
    correlationId,
    decidedAt,
    expectedVersion: expectedVersion as number,
    principalId,
    projectId,
    proposalBytes,
  });
}

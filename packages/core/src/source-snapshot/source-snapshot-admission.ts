import { isProxy } from "node:util/types";

import {
  SOURCE_SNAPSHOT_DRAFT_KEYS, SOURCE_SNAPSHOT_KEYS, SOURCE_SNAPSHOT_LIMITS,
  SOURCE_SNAPSHOT_REF_KEYS, SOURCE_SNAPSHOT_VERSION, sourceSnapshotRefusal,
} from "./source-snapshot-contract.js";
import type {
  SourceSnapshotAdmission, SourceSnapshotDraft, SourceSnapshotDraftAdmission,
  SourceSnapshotRefAdmission, SourceSnapshotRefusal,
} from "./source-snapshot-contract.js";

type Read<T> = Readonly<{ ok: true; value: T }> | SourceSnapshotRefusal;
const HEX_64 = /^[0-9a-f]{64}$/u;
const TREE_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

const malformed = (): SourceSnapshotRefusal =>
  sourceSnapshotRefusal("SOURCE_SNAPSHOT_MALFORMED", "SOURCE_SNAPSHOT_ADMISSION");
const exceeded = (): SourceSnapshotRefusal =>
  sourceSnapshotRefusal("SOURCE_SNAPSHOT_LIMIT_EXCEEDED", "SOURCE_SNAPSHOT_LIMITS");
const ok = <T>(value: T): Readonly<{ ok: true; value: T }> =>
  Object.freeze({ ok: true as const, value });

function exactRecord(value: unknown, keys: readonly string[]): Read<Readonly<Record<string, unknown>>> {
  if (value === null || typeof value !== "object" || isProxy(value) || Array.isArray(value)) {
    return malformed();
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return malformed();
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || !ownKeys.every((key) => typeof key === "string")
      || !keys.every((key) => ownKeys.includes(key))) return malformed();
    const record = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (property === undefined || !property.enumerable || !("value" in property)) {
        return malformed();
      }
      record[key] = property.value;
    }
    return ok(Object.freeze(record));
  } catch {
    return malformed();
  }
}

function readRef(value: unknown): Read<string> {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || !value.isWellFormed() || value.normalize("NFC") !== value) return malformed();
  return value.length > SOURCE_SNAPSHOT_LIMITS.maxRefCodeUnits ? exceeded() : ok(value);
}

function readDraft(record: Readonly<Record<string, unknown>>): Read<SourceSnapshotDraft> {
  const projectId = readRef(record["projectId"]); if (!projectId.ok) return projectId;
  const repositoryRef = readRef(record["repositoryRef"]); if (!repositoryRef.ok) return repositoryRef;
  const scopeRef = readRef(record["scopeRef"]); if (!scopeRef.ok) return scopeRef;
  if (typeof record["baseRevisionHash"] !== "string"
    || !HEX_64.test(record["baseRevisionHash"])) return malformed();
  if (typeof record["repositoryBaseTree"] !== "string"
    || !TREE_HASH.test(record["repositoryBaseTree"])) return malformed();
  return ok(Object.freeze({
    baseRevisionHash: record["baseRevisionHash"], projectId: projectId.value,
    repositoryBaseTree: record["repositoryBaseTree"], repositoryRef: repositoryRef.value,
    scopeRef: scopeRef.value,
  }));
}

export function admitSourceSnapshotDraft(value: unknown): SourceSnapshotDraftAdmission {
  const record = exactRecord(value, SOURCE_SNAPSHOT_DRAFT_KEYS); if (!record.ok) return record;
  const draft = readDraft(record.value);
  return draft.ok ? Object.freeze({ draft: draft.value, ok: true as const }) : draft;
}

export function admitSourceSnapshot(value: unknown): SourceSnapshotAdmission {
  const record = exactRecord(value, SOURCE_SNAPSHOT_KEYS); if (!record.ok) return record;
  if (record.value["version"] !== SOURCE_SNAPSHOT_VERSION) {
    return sourceSnapshotRefusal(
      "SOURCE_SNAPSHOT_VERSION_UNSUPPORTED", "SOURCE_SNAPSHOT_VERSION");
  }
  const draft = readDraft(record.value); if (!draft.ok) return draft;
  const digest = record.value["sourceSnapshotDigest"];
  if (typeof digest !== "string" || !HEX_64.test(digest)) return malformed();
  return Object.freeze({ ok: true as const, snapshot: Object.freeze({
    ...draft.value, sourceSnapshotDigest: digest, version: SOURCE_SNAPSHOT_VERSION,
  }) });
}

export function admitSourceSnapshotRef(value: unknown): SourceSnapshotRefAdmission {
  const record = exactRecord(value, SOURCE_SNAPSHOT_REF_KEYS); if (!record.ok) return record;
  const projectId = readRef(record.value["projectId"]); if (!projectId.ok) return projectId;
  const digest = record.value["sourceSnapshotDigest"];
  if (typeof digest !== "string" || !HEX_64.test(digest)) return malformed();
  return Object.freeze({ ok: true as const, ref: Object.freeze({
    projectId: projectId.value, sourceSnapshotDigest: digest,
  }) });
}

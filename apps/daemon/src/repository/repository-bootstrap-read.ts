import type { SqliteEventStore } from "@moe/store";
import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import { BOOTSTRAP_RECEIPT_VERSION } from "./repository-bootstrap-contracts.js";
import type { BootstrapCode, BootstrapDetail, BootstrapReceiptV1, BootstrapRefusal }
  from "./repository-bootstrap-contracts.js";

export type BootstrapReceiptView = BootstrapReceiptV1;
export type BootstrapReadView = Readonly<{
  outcome: "BOOTSTRAP_READ";
  receipt: BootstrapReceiptView | null;
  unreadable?: true;
}>;

const CODES = Object.freeze([
  "BOOTSTRAP_PROFILE_VERSION_UNKNOWN", "BOOTSTRAP_PRODUCT_NAME_INVALID", "BOOTSTRAP_DIR_NOT_EMPTY",
  "BOOTSTRAP_GIT_UNAVAILABLE", "BOOTSTRAP_GH_UNAVAILABLE", "BOOTSTRAP_DIR_INVALID", "BOOTSTRAP_TREE_PATH_INVALID",
  "BOOTSTRAP_TREE_WRITE_FAILED", "BOOTSTRAP_PAYLOAD_INVALID", "BOOTSTRAP_BIND_FAILED", "BOOTSTRAP_CATALOG_FAILED",
  "MIGRATION_TOOL_MISSING",
] as const);
const DETAILS = Object.freeze([
  "PROFILE_UNKNOWN", "PRODUCT_NAME_INVALID", "DIRECTORY_NOT_EMPTY", "DIRECTORY_INVALID", "TREE_PATH_INVALID",
  "TREE_WRITE_FAILED", "GIT_EXECUTABLE_UNAVAILABLE", "GIT_COMMAND_FAILED", "GIT_SHA_INVALID", "GH_EXECUTABLE_ABSENT",
  "GITHUB_REFUSED", "GH_EXECUTION_FAILED", "REMOTE_URL_REJECTED", "GITHUB_REQUEST_INVALID",
  "BIND_FAILED_LOCAL_REPOSITORY_RETAINED", "CATALOG_FAILED_LOCAL_REPOSITORY_RETAINED",
] as const);
// Both directions are load-bearing: neither future producer members nor invented reader
// diagnostics can be admitted silently. These pins are checked by the repository type gate.
const CODE_FORWARD: Exclude<(typeof CODES)[number], BootstrapCode> extends never ? true : never = true;
const CODE_REVERSE: Exclude<BootstrapCode, (typeof CODES)[number]> extends never ? true : never = true;
const DETAIL_FORWARD: Exclude<(typeof DETAILS)[number], BootstrapDetail> extends never ? true : never = true;
const DETAIL_REVERSE: Exclude<BootstrapDetail, (typeof DETAILS)[number]> extends never ? true : never = true;
void CODE_FORWARD; void CODE_REVERSE; void DETAIL_FORWARD; void DETAIL_REVERSE;
const RECEIPT_KEYS = ["version", "decidedAt", "dir", "outcome", "sha", "remoteUrl", "refusal", "githubRefusal"];
const REFUSAL_KEYS = ["code", "detail", "refusedBy"];
const ABSENT: BootstrapReadView = Object.freeze({ outcome: "BOOTSTRAP_READ", receipt: null });
const UNREADABLE: BootstrapReadView = Object.freeze({ ...ABSENT, unreadable: true });

/** Snapshot data properties, never call a getter/toJSON or re-read a value after checking it. */
function ownFields(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return null;
    result[key] = descriptor.value as unknown;
  }
  return result;
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum && !/[\x00-\x1f\x7f]/u.test(value)
    // Declared fields can also hold credentials: a hard refusal preserves the supplied dir.
    && !/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|:\/\/[^/@\s"]+@)/u.test(value);
}

function timestamp(value: unknown): value is string {
  if (!boundedText(value, 24) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return false;
  const instant = Date.parse(value);
  const canonical = value.length === 20 ? `${value.slice(0, -1)}.000Z` : value;
  return Number.isFinite(instant) && new Date(instant).toISOString() === canonical;
}

function canonicalGithubUrl(value: unknown): value is string {
  return boundedText(value, 159)
    && /^https:\/\/github\.com\/[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u.test(value);
}

function refusalView(value: unknown): BootstrapRefusal | null | undefined {
  if (value === null) return null;
  const fields = ownFields(value, REFUSAL_KEYS);
  if (fields === null) return undefined;
  const code = fields["code"];
  const detail = fields["detail"];
  if (typeof code !== "string" || !(CODES as readonly string[]).includes(code)
    || typeof detail !== "string" || !(DETAILS as readonly string[]).includes(detail)
    || fields["refusedBy"] !== "DAEMON_INGRESS") return undefined;
  return Object.freeze({ code: code as BootstrapCode, detail: detail as BootstrapDetail, refusedBy: "DAEMON_INGRESS" });
}

function receiptView(value: unknown): BootstrapReceiptView | null {
  const fields = ownFields(value, RECEIPT_KEYS);
  if (fields === null) return null;
  const { version, decidedAt, dir, outcome, sha, remoteUrl } = fields;
  if (version !== BOOTSTRAP_RECEIPT_VERSION || !timestamp(decidedAt) || !boundedText(dir, 4096)) return null;
  const refusal = refusalView(fields["refusal"]);
  const githubRefusal = refusalView(fields["githubRefusal"]);
  if (refusal === undefined || githubRefusal === undefined) return null;
  const base = { version, decidedAt, dir, githubRefusal } as const;
  if (outcome === "REFUSED") {
    if (sha !== null || remoteUrl !== null || refusal === null) return null;
    return Object.freeze({ ...base, outcome, sha: null, remoteUrl: null, refusal });
  }
  if (outcome !== "BOOTSTRAPPED" || refusal !== null || typeof sha !== "string"
    || (sha.length !== 40 && sha.length !== 64) || !/^[a-f0-9]+$/u.test(sha)
    || !(remoteUrl === null || canonicalGithubUrl(remoteUrl))) return null;
  return Object.freeze({ ...base, outcome, sha, remoteUrl, refusal: null });
}

/** Current durable receipt only. A present null (including corrupt JSON) is NOT absence. */
export function readBootstrapReceipt(store: SqliteEventStore, projectId: string): BootstrapReadView {
  try {
    const ledger = readDurableLedger(store, projectId);
    const aggregateId = `${projectId}-bootstrap`;
    if (!ledger.aggregates.has(aggregateId)) return ABSENT;
    const receipt = receiptView(stateOf(ledger, aggregateId));
    return receipt === null ? UNREADABLE : Object.freeze({ outcome: "BOOTSTRAP_READ", receipt });
  } catch {
    // No exception message, stored diagnostics or partial receipt crosses this boundary.
    return UNREADABLE;
  }
}

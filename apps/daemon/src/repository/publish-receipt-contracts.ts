import { createHash } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";

/**
 * The durable shapes of PUBLISHING: the human's `repository.publish` decision
 * names a remote; the wrapper's publisher pushes the workspace's current
 * branch there and records ONE receipt per decision — PUSHED with the sha and
 * the link, or REFUSED with git's own words. The decision is the authority
 * (human, operator-principal, never MCP-reachable); the receipt is the effect,
 * recorded under a reserved principal beside the goal, never on it.
 */

export const NODE_PUBLISHER_PRINCIPAL_ID = "daemon:node-publisher" as const;
export const PUBLISH_RECEIPT_VERSION = "moe-publish-receipt/1" as const;
export const PUBLISH_RECEIPT_COMMAND_KIND = "internal.repository.publish_receipt" as const;
export const REPOSITORY_PUBLISH_COMMAND_KIND = "repository.publish" as const;

/**
 * The PROJECT's remote, bound by the first publish that names one and reused by every publish
 * that sends `remoteUrl: null`. It is a second LEG of the publish decision rather than a command
 * of its own: `repository.publish`'s payload roster is frozen at `["goalId", "remoteUrl"]`, and a
 * binding that could outlive its publish (or a publish that could outlive its binding) is exactly
 * the split-brain one fenced decision prevents.
 */
export const REMOTE_BOUND_EVENT_TYPE = "RepositoryRemoteBound" as const;

/** `remoteUrl: null` and no binding to resolve: the operator must name a remote once. */
export const PUBLISH_REMOTE_UNBOUND = "PUBLISH_REMOTE_UNBOUND" as const;

/** A named remote `admitRemoteUrl` refuses. Distinct from the generic payload code so the
 *  browser can say WHICH field is wrong without the daemon echoing the url back. */
export const PUBLISH_REMOTE_URL_INVALID = "PUBLISH_REMOTE_URL_INVALID" as const;

export interface PublishRefusal {
  readonly code: string;
  readonly detail: string;
}

export interface PublishReceiptV1 {
  readonly branch: string | null;
  readonly decidedAt: string;
  readonly decisionId: string;
  readonly goalId: string;
  readonly outcome: "PUSHED" | "REFUSED";
  readonly projectId: string;
  readonly receiptId: string;
  readonly refusal: PublishRefusal | null;
  readonly remoteUrl: string;
  readonly sha: string | null;
  /** A browser link to the pushed branch, when the remote's host is one this daemon knows. */
  readonly url: string | null;
  readonly version: typeof PUBLISH_RECEIPT_VERSION;
}

export type PublishReceiptDecodeResult =
  | Readonly<{ readonly ok: true; readonly receipt: PublishReceiptV1 }>
  | Readonly<{ readonly code: "PUBLISH_RECEIPT_INVALID"; readonly ok: false }>;

const HEX64 = /^[0-9a-f]{64}$/u;
const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const RECEIPT_KEYS = [
  "branch", "decidedAt", "decisionId", "goalId", "outcome", "projectId", "receiptId", "refusal",
  "remoteUrl", "sha", "url", "version",
] as const;
const REFUSAL_KEYS = ["code", "detail"] as const;

/**
 * A remote the publisher will push to: https or ssh, no embedded credentials, no
 * whitespace. The operator types it; the daemon refuses the shapes git would
 * misread or that would carry a secret into a durable decision.
 */
const REMOTE_HTTPS = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[^\s@]+$/u;
const REMOTE_SSH = /^(?:ssh:\/\/)?(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9.-]+(?::\d+)?[:/][^\s@]+$/u;

export function admitRemoteUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  if (/\s/u.test(value)) return null;
  // Only https and ssh travel: a file:, git: or http: remote is refused by the name of its scheme.
  if (value.includes("://") && !value.startsWith("https://") && !value.startsWith("ssh://")) return null;
  if (REMOTE_HTTPS.test(value)) return value;
  if (!value.startsWith("https://") && !value.startsWith("http://") && REMOTE_SSH.test(value)) return value;
  return null;
}

/** The GitHub-style browse link for a pushed branch, or null for a host this daemon cannot name. */
export function publishLinkFor(remoteUrl: string, branch: string): string | null {
  const https = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u.exec(remoteUrl);
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u.exec(remoteUrl);
  const match = https ?? ssh;
  if (match === null) return null;
  return `https://github.com/${match[1] as string}/${match[2] as string}/tree/${encodeURIComponent(branch)}`;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && typeof value === "object"
    && !Array.isArray(value) && Object.getPrototypeOf(value) === null;
}

function exact(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function ref(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function hash(parts: readonly JsonValue[]): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      freezeDeep((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Every publish fact for a goal lands beside the goal, never on it. */
export function publishAggregateId(goalId: string): string {
  return `publish:${goalId}`;
}

/** One remote per PROJECT, on a stream of its own so a binding never bumps a goal's version. */
export function remoteAggregateId(projectId: string): string {
  return `remote:${projectId}`;
}

/** One receipt per publish decision: the id is a pure function of that decision. */
export function publishReceiptId(projectId: string, goalId: string, decisionId: string): string {
  return hash([PUBLISH_RECEIPT_VERSION, "receipt-id", projectId, goalId, decisionId]);
}

export function decodePublishReceiptBytes(input: unknown): PublishReceiptDecodeResult {
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok || !isObject(decoded.value) || !exact(decoded.value, RECEIPT_KEYS)) {
    return { code: "PUBLISH_RECEIPT_INVALID", ok: false };
  }
  const value = decoded.value;
  const outcome = value["outcome"];
  const refusalValue = value["refusal"];
  let refusal: PublishRefusal | null = null;
  if (refusalValue !== null) {
    if (!isObject(refusalValue) || !exact(refusalValue, REFUSAL_KEYS) || !ref(refusalValue["code"])
      || typeof refusalValue["detail"] !== "string") return { code: "PUBLISH_RECEIPT_INVALID", ok: false };
    refusal = { code: refusalValue["code"], detail: refusalValue["detail"] };
  }
  const sha = value["sha"];
  const branch = value["branch"];
  const url = value["url"];
  if (value["version"] !== PUBLISH_RECEIPT_VERSION || !ref(value["projectId"]) || !ref(value["goalId"])
    || !ref(value["decisionId"]) || !ref(value["decidedAt"]) || !ref(value["remoteUrl"])
    || !HEX64.test(String(value["receiptId"]))
    || (outcome !== "PUSHED" && outcome !== "REFUSED")
    || (outcome === "REFUSED") !== (refusal !== null)
    || !(sha === null || (typeof sha === "string" && GIT_OBJECT_ID.test(sha)))
    || !(branch === null || ref(branch)) || !(url === null || ref(url))
    || (outcome === "PUSHED" && (sha === null || branch === null))) {
    return { code: "PUBLISH_RECEIPT_INVALID", ok: false };
  }
  const receiptId = value["receiptId"] as string;
  if (receiptId !== publishReceiptId(value["projectId"], value["goalId"], value["decisionId"])) {
    return { code: "PUBLISH_RECEIPT_INVALID", ok: false };
  }
  const receipt: PublishReceiptV1 = {
    branch: branch as string | null,
    decidedAt: value["decidedAt"],
    decisionId: value["decisionId"],
    goalId: value["goalId"],
    outcome,
    projectId: value["projectId"],
    receiptId,
    refusal,
    remoteUrl: value["remoteUrl"],
    sha: sha as string | null,
    url: url as string | null,
    version: PUBLISH_RECEIPT_VERSION,
  };
  return { ok: true, receipt: freezeDeep(receipt) };
}

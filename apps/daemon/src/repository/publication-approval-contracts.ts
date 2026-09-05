import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { admitRemoteUrl } from "./publish-receipt-contracts.js";
import type { RepositoryExecutionIdentity } from "./repository-execution-contracts.js";

/** Public approval tuple. The opaque repository id binds the daemon's private canonical root. */
export interface PublicationApproval {
  readonly branch: string;
  readonly remoteUrl: string;
  readonly repositoryId: string;
  readonly sha: string;
}
export interface PublicationCandidate {
  readonly approval: PublicationApproval;
  readonly identity: RepositoryExecutionIdentity;
}
export interface PublicationRefusal { readonly ok: false; readonly code: string; readonly detail: string }
export type PublicationCandidateResult = Readonly<{ ok: true; candidate: PublicationCandidate }> | PublicationRefusal;
export type PublicationCandidateReader = (remoteUrl: string) => PublicationCandidateResult;

export const publicationRefused = (code: string): PublicationRefusal => Object.freeze({ ok: false, code, detail: code });
export const validPublicationSha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value);
export function validPublicationBranch(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024
    && !/^[.-]|[\x00-\x20\x7f~^:?*\[\\]|\.\.|@\{|\.$|\/$/u.test(value)
    && value.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    const actual = Reflect.ownKeys(value);
    if ((prototype !== null && prototype !== Object.prototype) || actual.length !== keys.length
      || actual.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch { return null; }
}

export function publicationRepositoryId(identity: RepositoryExecutionIdentity): string {
  return createHash("sha256").update(JSON.stringify([
    "moe-publication-repository/1", identity.root, identity.gitDirectory,
  ])).digest("hex");
}
export function decodePublicationApproval(value: unknown): PublicationApproval | null {
  const record = exact(value, ["branch", "remoteUrl", "repositoryId", "sha"]);
  if (record === null || !validPublicationBranch(record["branch"]) || !validPublicationSha(record["sha"])
    || typeof record["repositoryId"] !== "string" || !/^[a-f0-9]{64}$/u.test(record["repositoryId"])) return null;
  const remoteUrl = admitRemoteUrl(record["remoteUrl"]);
  return remoteUrl === null ? null : Object.freeze({
    branch: record["branch"], remoteUrl, repositoryId: record["repositoryId"], sha: record["sha"],
  });
}
export function decodePublicationCandidate(value: unknown): PublicationCandidate | null {
  const record = exact(value, ["approval", "identity"]);
  if (record === null) return null;
  const approval = decodePublicationApproval(record["approval"]);
  const raw = exact(record["identity"], ["root", "gitDirectory"]);
  const absolute = (path: unknown): path is string => typeof path === "string"
    && !/[\x00-\x1f\x7f]/u.test(path) && (posix.isAbsolute(path) || win32.isAbsolute(path));
  if (approval === null || raw === null || !absolute(raw["root"]) || !absolute(raw["gitDirectory"])) return null;
  const identity = Object.freeze({ root: raw["root"], gitDirectory: raw["gitDirectory"] });
  return publicationRepositoryId(identity) === approval.repositoryId ? Object.freeze({ approval, identity }) : null;
}
export function samePublicationApproval(left: PublicationApproval, right: PublicationApproval): boolean {
  return left.branch === right.branch && left.remoteUrl === right.remoteUrl
    && left.repositoryId === right.repositoryId && left.sha === right.sha;
}

import { posix, win32 } from "node:path";
import type { GitCommitReceipt } from "./git-landing-port.js";

export const VERIFIED_WORKSPACE_VERSION = "moe-verified-workspace/1" as const;
/** Immutable Git tree plus the actual dirty-path provenance observed around the test run. */
export interface VerifiedWorkspaceBinding {
  readonly version: typeof VERIFIED_WORKSPACE_VERSION;
  readonly root: string;
  readonly headSha: string | null;
  readonly branchRef: string;
  readonly treeSha: string;
  readonly dirtySha256: string;
}
export interface VerifiedWorkspaceRefusal { readonly ok: false; readonly code: string; readonly detail: string }
export type VerifiedWorkspaceCapture = { readonly ok: true; readonly binding: VerifiedWorkspaceBinding } | VerifiedWorkspaceRefusal;
export interface VerifiedWorkspacePort {
  capture(workspace: string): Promise<VerifiedWorkspaceCapture>;
  commit(workspace: string, paths: readonly string[], message: string, binding: VerifiedWorkspaceBinding):
    Promise<{ readonly ok: true; readonly receipt: GitCommitReceipt } | VerifiedWorkspaceRefusal>;
}
const KEYS = ["version", "root", "headSha", "branchRef", "treeSha", "dirtySha256"] as const;
const objectId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value);
function branch(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("refs/heads/") && value.length > 11
    && !/[\u0000-\u0020\u007f~^:?*\[\\]/u.test(value) && !value.includes("..") && !value.includes("@{")
    && !value.endsWith(".") && value.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function decodeVerifiedWorkspaceBinding(value: unknown): VerifiedWorkspaceBinding | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== KEYS.length || KEYS.some((key) => !Object.hasOwn(row, key))
    || row["version"] !== VERIFIED_WORKSPACE_VERSION || typeof row["root"] !== "string"
    || (!posix.isAbsolute(row["root"]) && !win32.isAbsolute(row["root"])) || /[\u0000-\u001f]/u.test(row["root"])
    || (row["headSha"] !== null && !objectId(row["headSha"])) || !objectId(row["treeSha"])
    || (row["headSha"] !== null && row["headSha"].length !== row["treeSha"].length) || !branch(row["branchRef"])
    || typeof row["dirtySha256"] !== "string" || !/^[a-f0-9]{64}$/u.test(row["dirtySha256"])) return null;
  return Object.freeze({ version: VERIFIED_WORKSPACE_VERSION, root: row["root"], headSha: row["headSha"],
    branchRef: row["branchRef"], treeSha: row["treeSha"], dirtySha256: row["dirtySha256"] });
}

export function sameVerifiedWorkspace(left: VerifiedWorkspaceBinding, right: VerifiedWorkspaceBinding): boolean {
  return KEYS.every((key) => left[key] === right[key]);
}

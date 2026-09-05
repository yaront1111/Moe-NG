import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRepositoryExecutionIdentity } from "./repository-execution-identity.js";
import type { VerifiedWorkspaceRefusal } from "./verified-workspace-contracts.js";

export interface VerifiedGitContext { readonly root: string; readonly gitDirectory: string; readonly scratch: string; readonly hooks: string; readonly index: string }
export class VerifiedGitFailure extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export function failVerifiedGit(code: string): never { throw new VerifiedGitFailure(code); }
export function verifiedGitRefusal(error: unknown): VerifiedWorkspaceRefusal {
  const code = error instanceof VerifiedGitFailure ? error.code : "VERIFIED_WORKSPACE_UNKNOWN";
  return Object.freeze({ ok: false, code, detail: code });
}
export const objectId = (value: string) => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value);
export const literalPaths = (paths: readonly string[]) => paths.map((path) => `:(literal)${path}`);

export function attemptVerifiedGit(context: VerifiedGitContext, args: readonly string[], index?: string, stdin?: string): Promise<{ code: number | null; output: string }> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  return new Promise((resolve) => {
    const child = execFile("git", ["--no-replace-objects", "-c", `core.hooksPath=${context.hooks}`,
      "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args], {
      cwd: context.root, encoding: "utf8", shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...inherited, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...(index === undefined ? {} : { GIT_INDEX_FILE: index }) },
    }, (error, output) => resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, output }));
    if (child.stdin !== null) { child.stdin.on("error", () => {}); child.stdin.end(stdin); }
  });
}
export async function verifiedGit(context: VerifiedGitContext, args: readonly string[], index?: string, stdin?: string): Promise<string> {
  const result = await attemptVerifiedGit(context, args, index, stdin);
  if (result.code !== 0) failVerifiedGit("VERIFIED_WORKSPACE_GIT_FAILED");
  return result.output;
}
export async function withVerifiedGit<T>(workspace: string, action: (context: VerifiedGitContext) => Promise<T>): Promise<T> {
  const identity = resolveRepositoryExecutionIdentity(workspace);
  if (!identity.ok) failVerifiedGit("VERIFIED_WORKSPACE_IDENTITY_UNKNOWN");
  const scratch = mkdtempSync(join(tmpdir(), "moe-verified-index-"));
  const hooks = join(scratch, "hooks"); mkdirSync(hooks);
  try { return await action({ ...identity.identity, scratch, hooks, index: join(scratch, "candidate-index") }); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}

export async function gitHead(context: VerifiedGitContext): Promise<{ headSha: string | null; branchRef: string }> {
  const branchRef = (await verifiedGit(context, ["symbolic-ref", "--quiet", "HEAD"])).replace(/\r?\n$/u, "");
  if (!branchRef.startsWith("refs/heads/") || /[\u0000-\u0020\u007f]/u.test(branchRef)) failVerifiedGit("VERIFIED_WORKSPACE_IDENTITY_UNKNOWN");
  const head = await attemptVerifiedGit(context, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (head.code === 1) return { branchRef, headSha: null };
  const headSha = head.output.trim();
  if (head.code !== 0 || !objectId(headSha)) failVerifiedGit("VERIFIED_WORKSPACE_IDENTITY_UNKNOWN");
  return { branchRef, headSha };
}

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VerifiedWorkspaceBinding, VerifiedWorkspacePort } from "./verified-workspace-contracts.js";
import * as runtime from "./git-verified-workspace-runtime.js";

import { createVerifiedWorkspacePort } from "./git-verified-workspace-port.js";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, shell: false, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function repository(initial = true): string {
  const root = mkdtempSync(join(tmpdir(), "moe-verified-workspace-")); roots.push(root);
  git(root, "init", "--quiet", "--initial-branch=trunk");
  writeFileSync(join(root, ".git", "config"), "\n[user]\n\tname=Operator\n\temail=operator@example.test\n[commit]\n\tgpgsign=false\n", { flag: "a" });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "b.ts"), "export const b = 1;\n");
  if (initial) { git(root, "add", "--", "src/a.ts", "src/b.ts"); git(root, "commit", "--quiet", "-m", "initial"); }
  return root;
}
async function binding(port: VerifiedWorkspacePort, root: string): Promise<VerifiedWorkspaceBinding> {
  const capture = await port.capture(root); expect(capture.ok, JSON.stringify(capture)).toBe(true);
  if (!capture.ok) throw new Error(capture.code); return capture.binding;
}

describe("verified Git effect refusal boundaries", () => {
  it("excludes a symbolic-ref writer between final HEAD observation and index reconciliation", async () => {
    const root = repository(); const port = createVerifiedWorkspacePort();
    writeFileSync(join(root, "src", "a.ts"), "owned\n"); const captured = await binding(port, root);
    const original = runtime.gitHead; let writerStatus: number | null = null;
    vi.spyOn(runtime, "gitHead").mockImplementation(async (context) => {
      const observed = await original(context);
      if (observed.headSha !== captured.headSha) {
        writerStatus = spawnSync("git", ["symbolic-ref", "HEAD", "refs/heads/other"], { cwd: root, shell: false, windowsHide: true }).status;
      }
      return observed;
    });
    const result = await port.commit(root, ["src/a.ts"], "land\n", captured);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(writerStatus).not.toBeNull(); expect(writerStatus).not.toBe(0);
    expect(git(root, "symbolic-ref", "HEAD")).toBe(captured.branchRef);
    expect(git(root, "rev-parse", "HEAD^{tree}")).toBe(captured.treeSha);
  }, 180_000);

  it("retains an existing Git index lock and rejects invalid pathspecs", async () => {
    const root = repository(); const port = createVerifiedWorkspacePort();
    writeFileSync(join(root, "src", "a.ts"), "owned\n"); const captured = await binding(port, root);
    writeFileSync(join(root, ".git", "index.lock"), "foreign lock");
    expect(await port.commit(root, ["src/a.ts"], "land\n", captured))
      .toMatchObject({ ok: false, code: "VERIFIED_WORKSPACE_INDEX_LOCKED" });
    expect(readFileSync(join(root, ".git", "index.lock"), "utf8")).toBe("foreign lock");
    unlinkSync(join(root, ".git", "index.lock"));
    expect(await port.commit(root, ["../outside"], "land\n", captured))
      .toMatchObject({ ok: false, code: "VERIFIED_WORKSPACE_PATH_INVALID" });
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(false);
  }, 180_000);

  it("refuses configured clean filters before their command can run", async () => {
    const root = repository();
    writeFileSync(join(root, ".gitattributes"), "src/*.ts filter=custom\n");
    git(root, "config", "filter.custom.clean", 'node -e "process.exit(91)"');
    expect(await createVerifiedWorkspacePort().capture(root))
      .toMatchObject({ ok: false, code: "VERIFIED_WORKSPACE_FILTER_UNSUPPORTED" });
  }, 180_000);

  it("proves a refused ref transaction had no effect before allowing retry", async () => {
    const root = repository(); const port = createVerifiedWorkspacePort();
    writeFileSync(join(root, "src", "a.ts"), "owned\n"); const captured = await binding(port, root);
    const branchLock = join(root, ".git", "refs", "heads", "trunk.lock"); writeFileSync(branchLock, "foreign ref owner");
    expect(await port.commit(root, ["src/a.ts"], "land\n", captured))
      .toMatchObject({ ok: false, code: "VERIFIED_WORKSPACE_REF_CONFLICT" });
    expect(git(root, "rev-parse", "HEAD")).toBe(captured.headSha);
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(false);
    expect(readFileSync(branchLock, "utf8")).toBe("foreign ref owner");
  }, 180_000);

  it.each([true, false])("retains an unknown update outcome when the child result is missing (applied=%s)", async (applied) => {
    const root = repository(); const port = createVerifiedWorkspacePort();
    writeFileSync(join(root, "src", "a.ts"), "owned\n"); const captured = await binding(port, root);
    const index = readFileSync(join(root, ".git", "index")); const original = runtime.attemptVerifiedGit;
    vi.spyOn(runtime, "attemptVerifiedGit").mockImplementation(async (context, args, temporaryIndex, stdin) => {
      if (args.includes("update-ref") && !applied) return { code: null, output: "" };
      const result = await original(context, args, temporaryIndex, stdin);
      return args.includes("update-ref") ? { ...result, code: null } : result;
    });
    expect(await port.commit(root, ["src/a.ts"], "land\n", captured))
      .toMatchObject({ ok: false, code: "VERIFIED_WORKSPACE_REF_UPDATE_UNKNOWN" });
    if (applied) {
      expect(git(root, "rev-parse", "HEAD^{tree}")).toBe(captured.treeSha);
      expect(git(root, "rev-parse", "HEAD")).not.toBe(captured.headSha);
    } else expect(git(root, "rev-parse", "HEAD")).toBe(captured.headSha);
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(true);
    expect(readFileSync(join(root, ".git", "index"))).toEqual(index);
  }, 180_000);

  it("refuses submodule contents that are not bound by the root Git tree", async () => {
    const root = repository(); git(root, "clone", "--quiet", "--local", root, "vendor");
    expect(await createVerifiedWorkspacePort().capture(root))
      .toMatchObject({ ok: false, code: "VERIFIED_WORKSPACE_SUBMODULE_UNSUPPORTED" });
  }, 180_000);
});

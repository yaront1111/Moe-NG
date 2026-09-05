import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VerifiedWorkspaceBinding, VerifiedWorkspacePort } from "./verified-workspace-contracts.js";

import { createVerifiedWorkspacePort } from "./git-verified-workspace-port.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
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

describe("exact verified Git artifact", () => {
  it("preserves a Git-valid Unicode whitespace suffix in the bound branch", async () => {
    const root = repository(); const branch = "unicode\u00a0";
    git(root, "checkout", "--quiet", "-b", branch);
    expect((await binding(createVerifiedWorkspacePort(), root)).branchRef).toBe(`refs/heads/${branch}`);
  }, 180_000);

  it("captures the complete candidate tree without modifying HEAD, real index or working files", async () => {
    const root = repository(); const port = createVerifiedWorkspacePort();
    const head = git(root, "rev-parse", "HEAD"); const index = readFileSync(join(root, ".git", "index"));
    writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n");
    writeFileSync(join(root, "new.ts"), "export const fresh = 3;\n");
    const captured = await binding(port, join(root, "src"));
    expect(captured).toMatchObject({ version: "moe-verified-workspace/1", headSha: head, branchRef: "refs/heads/trunk" });
    expect(git(root, "show", `${captured.treeSha}:src/a.ts`)).toBe("export const a = 2;");
    expect(git(root, "show", `${captured.treeSha}:new.ts`)).toBe("export const fresh = 3;");
    expect(captured.dirtySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(git(root, "rev-parse", "HEAD")).toBe(head); expect(readFileSync(join(root, ".git", "index"))).toEqual(index);
  }, 180_000);

  it("commits only the verified tree with bound parent, including additions and deletions", async () => {
    const root = repository(); const port = createVerifiedWorkspacePort();
    writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n");
    unlinkSync(join(root, "src", "b.ts")); writeFileSync(join(root, "new.ts"), "new artifact\n");
    const captured = await binding(port, root);
    const result = await port.commit(root, ["src/a.ts", "src/b.ts", "new.ts"], "land verified artifact\n", captured);
    expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(result.code);
    expect(result.receipt).toMatchObject({ branch: "trunk", parentSha: captured.headSha });
    expect(git(root, "rev-parse", `${result.receipt.sha}^{tree}`)).toBe(captured.treeSha);
    expect(git(root, "rev-parse", `${result.receipt.sha}^`)).toBe(captured.headSha);
    expect(git(root, "status", "--porcelain")).toBe("");
    expect(git(root, "log", "-1", "--format=%an <%ae>")).toBe("Moe <moe@moe.local>");
  }, 180_000);

  it("refuses newer worktree bytes and leaves HEAD/index unchanged", async () => {
    const root = repository(); const port = createVerifiedWorkspacePort();
    writeFileSync(join(root, "src", "a.ts"), "verified\n"); const captured = await binding(port, root);
    const index = readFileSync(join(root, ".git", "index")); writeFileSync(join(root, "src", "a.ts"), "unverified\n");
    expect(await port.commit(root, ["src/a.ts"], "land\n", captured))
      .toMatchObject({ ok: false, code: "VERIFIED_WORKSPACE_DRIFT" });
    expect(git(root, "rev-parse", "HEAD")).toBe(captured.headSha); expect(readFileSync(join(root, ".git", "index"))).toEqual(index);
  }, 180_000);

  it("refuses omitting foreign dirty bytes from the verified complete tree", async () => {
    const root = repository(); const port = createVerifiedWorkspacePort();
    writeFileSync(join(root, "src", "a.ts"), "owned\n"); writeFileSync(join(root, "foreign.md"), "operator work\n");
    const captured = await binding(port, root);
    expect(await port.commit(root, ["src/a.ts"], "land\n", captured))
      .toMatchObject({ ok: false, code: "VERIFIED_WORKSPACE_PATHS_MISMATCH" });
    expect(git(root, "rev-parse", "HEAD")).toBe(captured.headSha); expect(readFileSync(join(root, "foreign.md"), "utf8")).toBe("operator work\n");
  }, 180_000);

  it("preserves staged foreign bytes and refuses staged conflicts on delivered paths", async () => {
    const root = repository(); const port = createVerifiedWorkspacePort();
    writeFileSync(join(root, "src", "b.ts"), "staged foreign bytes\n"); git(root, "add", "--", "src/b.ts");
    writeFileSync(join(root, "src", "b.ts"), "export const b = 1;\n");
    writeFileSync(join(root, "src", "a.ts"), "owned\n"); const captured = await binding(port, root);
    const result = await port.commit(root, ["src/a.ts"], "land\n", captured);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(git(root, "show", ":src/b.ts")).toBe("staged foreign bytes");
    expect(readFileSync(join(root, "src", "b.ts"), "utf8")).toBe("export const b = 1;\n");
    writeFileSync(join(root, "src", "a.ts"), "staged competing bytes\n"); git(root, "add", "--", "src/a.ts");
    writeFileSync(join(root, "src", "a.ts"), "new candidate\n"); const conflicting = await binding(port, root);
    expect(await port.commit(root, ["src/a.ts"], "second\n", conflicting))
      .toMatchObject({ ok: false, code: "VERIFIED_WORKSPACE_INDEX_CONFLICT" });
    expect(git(root, "show", ":src/a.ts")).toBe("staged competing bytes");
  }, 240_000);

  it("refuses parent and same-parent branch drift", async () => {
    const root = repository(); const port = createVerifiedWorkspacePort();
    writeFileSync(join(root, "src", "a.ts"), "owned\n"); const captured = await binding(port, root);
    git(root, "checkout", "--quiet", "-b", "other");
    expect(await port.commit(root, ["src/a.ts"], "land\n", captured))
      .toMatchObject({ ok: false, code: "VERIFIED_WORKSPACE_DRIFT" });
    git(root, "checkout", "--quiet", "trunk"); git(root, "commit", "--quiet", "--allow-empty", "-m", "new parent");
    expect(await port.commit(root, ["src/a.ts"], "land\n", captured))
      .toMatchObject({ ok: false, code: "VERIFIED_WORKSPACE_DRIFT" });
  }, 180_000);

  it("supports the first commit of an unborn branch", async () => {
    const root = repository(false); const port = createVerifiedWorkspacePort(); const captured = await binding(port, root);
    expect(captured.headSha).toBeNull();
    const result = await port.commit(root, ["src/a.ts", "src/b.ts"], "first verified commit\n", captured);
    expect(result).toMatchObject({ ok: true, receipt: { parentSha: null, branch: "trunk" } });
    expect(git(root, "rev-parse", "HEAD^{tree}")).toBe(captured.treeSha);
    expect(git(root, "status", "--porcelain")).toBe("");
  }, 180_000);

});

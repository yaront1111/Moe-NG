import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPublicationCandidateReader } from "./publication-candidate.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
  cwd, encoding: "utf8", windowsHide: true, timeout: 10_000,
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "", GIT_TERMINAL_PROMPT: "0" },
}).trim();

describe("daemon publication candidate", () => {
  it("captures the actual canonical checkout, commit and branch without trusting caller paths", () => {
    const root = mkdtempSync(join(tmpdir(), "moe-publication-candidate-")); roots.push(root);
    git(root, "init", "--quiet", "--initial-branch=delivery");
    writeFileSync(join(root, "product.txt"), "approved product\n");
    git(root, "add", "--", "product.txt");
    git(root, "-c", "user.name=Moe", "-c", "user.email=moe@moe.local", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "product");
    const sha = git(root, "rev-parse", "HEAD");
    const read = createPublicationCandidateReader(root);
    const candidate = read("https://github.com/example/product.git");
    expect(candidate).toMatchObject({ ok: true, candidate: {
      approval: { branch: "delivery", remoteUrl: "https://github.com/example/product.git", sha },
      identity: { root: realpathSync.native(root), gitDirectory: realpathSync.native(join(root, ".git")) },
    } });
    git(root, "branch", "-m", "delivery\u2003");
    expect(read("https://github.com/example/product.git")).toMatchObject({ ok: true,
      candidate: { approval: { branch: "delivery\u2003" } } });
    git(root, "checkout", "--quiet", "--detach", sha);
    expect(read("https://github.com/example/product.git")).toMatchObject({ ok: false, code: "PUBLISH_CANDIDATE_UNREADABLE" });
  }, 60_000);

  it("refuses an unbound workspace and invalid remote before Git observation", () => {
    expect(createPublicationCandidateReader(null)("https://github.com/example/product.git"))
      .toMatchObject({ ok: false, code: "PUBLISH_WORKSPACE_UNCONFIGURED" });
    expect(createPublicationCandidateReader("missing")("-option"))
      .toMatchObject({ ok: false, code: "PUBLISH_REMOTE_URL_INVALID" });
  });
});

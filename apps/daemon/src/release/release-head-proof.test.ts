import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { verifyReleaseHead } from "./release-head-proof.js";

it("proves the live named ref and refuses absent or moved heads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-release-head-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8", shell: false, windowsHide: true,
  }).trim();
  try {
    git("init", "--quiet", "--initial-branch=release");
    git("-c", "user.name=Release test", "-c", "user.email=release@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "release fixture");
    const sha = git("rev-parse", "HEAD");
    const subject = { remoteUrl: directory, head: "release", sha };
    expect(await verifyReleaseHead(directory, subject)).toBe(true);
    expect(await verifyReleaseHead(directory, { ...subject, sha: "0".repeat(40) })).toBe(false);
    expect(await verifyReleaseHead(directory, { ...subject, head: "missing" })).toBe(false);
    expect(await verifyReleaseHead(directory, { ...subject, sha: "HEAD" })).toBe(false);
  } finally { rmSync(directory, { force: true, recursive: true }); }
}, 30_000);

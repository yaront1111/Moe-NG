import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { expect, it } from "vitest";
import { createPublicationCandidateReader } from "./publication-candidate.js";
import { createGitPublicationPort, publicationGitRunner } from "./git-publication-port.js";
import { landingEnvironment, nodeGitRunner } from "./git-landing-port.js";

it("pushes the approved old commit to a real bare remote after HEAD advances, without local URL rewrites", async () => {
  const base = resolve(tmpdir()); const root = mkdtempSync(join(base, "moe-publication-native-"));
  const remote = join(root, "remote.git");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: landingEnvironment(),
    windowsHide: true, shell: false, encoding: "utf8", timeout: 15_000 }).replace(/\r?\n$/u, "");
  try {
    git("init", "--quiet", "--initial-branch=approved\u2003");
    writeFileSync(join(root, "product.txt"), "approved\n"); git("add", "product.txt");
    git("-c", "user.name=Moe", "-c", "user.email=moe@moe.local", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "approved");
    const captured = createPublicationCandidateReader(root)("https://github.com/fixture/approved.git");
    expect(captured.ok).toBe(true); if (!captured.ok) throw new Error(captured.code);
    writeFileSync(join(root, "product.txt"), "newer unapproved\n"); git("add", "product.txt");
    git("-c", "user.name=Moe", "-c", "user.email=moe@moe.local", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "newer");
    const newer = git("rev-parse", "HEAD");
    git("init", "--bare", "--quiet", remote);
    // Deliberate local rewrite must have no influence inside the isolated publication repository.
    git("config", "url.https://invalid.example/.insteadOf", "https://github.com/");
    const port = createGitPublicationPort({ readConfig: nodeGitRunner, run: async (cwd, args) => publicationGitRunner(cwd,
      args.map((arg) => arg === captured.candidate.approval.remoteUrl ? remote : arg)) });
    expect(await port.push(captured.candidate)).toEqual({ ok: true });
    expect(await port.observe(captured.candidate)).toEqual({ ok: true, sha: captured.candidate.approval.sha });
    expect(git(`--git-dir=${remote}`, "rev-parse", "refs/heads/approved\u2003")).toBe(captured.candidate.approval.sha);
    expect(newer).not.toBe(captured.candidate.approval.sha);
    expect(git("rev-parse", "HEAD")).toBe(newer);
  } finally { if (resolve(root).startsWith(`${base}${sep}`)) rmSync(root, { recursive: true, force: true }); }
}, 90_000);

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { expect, it } from "vitest";
import { createPublicationCandidateReader } from "./publication-candidate.js";
import type { PublicationTarget } from "./publication-approval-contracts.js";
import { createGitPublicationPort, publicationGitRunner } from "./git-publication-port.js";
import { landingEnvironment, nodeGitRunner } from "./git-landing-port.js";
import { admitRemoteUrl } from "./publish-receipt-contracts.js";

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

/** A real repository with one commit, plus a real `git init --bare` remote beside it. */
const publishableFixture = (root: string, remoteUrl: string) => {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: landingEnvironment(),
    windowsHide: true, shell: false, encoding: "utf8", timeout: 15_000 }).replace(/\r?\n$/u, "");
  git("init", "--quiet", "--initial-branch=approved");
  writeFileSync(join(root, "product.txt"), "approved\n"); git("add", "product.txt");
  git("-c", "user.name=Moe", "-c", "user.email=moe@moe.local", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "approved");
  const captured = createPublicationCandidateReader(root)(remoteUrl);
  if (!captured.ok) throw new Error(captured.code);
  return { candidate: captured.candidate, git };
};

const GOAL_ID = "goal-2cf9472a-d972-4e97-88cf-1734639d9700";
const RELEASE_BRANCH = `moe/release/${GOAL_ID}`;

/** The PRODUCTION reader's answer for a real one-commit repository checked out on `branch`. */
function readTargeted(branch: string, target?: PublicationTarget) {
  const base = resolve(tmpdir()); const root = mkdtempSync(join(base, "moe-publication-target-"));
  try {
    publishableFixture(root, "https://github.com/fixture/approved.git").git("branch", "-m", branch);
    return createPublicationCandidateReader(root)("https://github.com/fixture/approved.git", target);
  } finally { if (resolve(root).startsWith(`${base}${sep}`)) rmSync(root, { recursive: true, force: true }); }
}

it.each([
  ["the recorded default EQUALS the workspace branch", "master", { goalId: GOAL_ID, remoteDefaultBranch: "master" }, RELEASE_BRANCH],
  ["the recorded default is UNKNOWN", "feature", { goalId: GOAL_ID, remoteDefaultBranch: null }, RELEASE_BRANCH],
  ["the recorded default is a DIFFERENT branch", "feature", { goalId: GOAL_ID, remoteDefaultBranch: "master" }, "feature"],
  ["no target is passed", "master", undefined, "master"],
  // git compares branch names case-sensitively, so `Master` is not the remote's `master`.
  ["the default differs from the workspace branch only in case", "Master", { goalId: GOAL_ID, remoteDefaultBranch: "master" }, "Master"],
] as const)("approves the pushed branch by value when %s", (_case, branch, target, expected) => {
  const captured = readTargeted(branch, target);
  expect(captured.ok).toBe(true); if (!captured.ok) throw new Error(captured.code);
  expect(captured.candidate.approval.branch).toBe(expected);
}, 60_000);

it("refuses by name, and never returns a candidate for, a goal id git rejects as a release branch", () => {
  const base = resolve(tmpdir()); const root = mkdtempSync(join(base, "moe-publication-ref-"));
  try {
    publishableFixture(root, "https://github.com/fixture/approved.git");
    const read = createPublicationCandidateReader(root);
    // git's own answer for the same name, so the reader's rule is measured against git, not against itself.
    const gitAccepts = (name: string) => spawnSync("git", ["check-ref-format", "--branch", name],
      { cwd: root, env: landingEnvironment(), windowsHide: true, shell: false, timeout: 15_000 }).status === 0;
    const accepted = [GOAL_ID, "goal-1", "@"];
    const rejected = ["a..b", "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a@{b", "x.lock", "x.", ".x", "a//b", "a\tb", ""];
    const verdicts = [...accepted, ...rejected].map((goalId) => {
      const answer = read("https://github.com/fixture/approved.git", { goalId, remoteDefaultBranch: null });
      return [goalId, gitAccepts(`moe/release/${goalId}`), answer.ok ? answer.candidate.approval.branch : answer];
    });
    const refused = { ok: false, code: "PUBLISH_RELEASE_BRANCH_INVALID", detail: "PUBLISH_RELEASE_BRANCH_INVALID" };
    expect(verdicts).toEqual([
      ...accepted.map((goalId) => [goalId, true, `moe/release/${goalId}`]),
      ...rejected.map((goalId) => [goalId, false, refused]),
    ]);
  } finally { if (resolve(root).startsWith(`${base}${sep}`)) rmSync(root, { recursive: true, force: true }); }
}, 90_000);

it("refuses a local bare remote before publication on every host", () => {
  const base = resolve(tmpdir()); const root = mkdtempSync(join(base, "moe-publication-bare-"));
  const remote = join(root, "remote.git");
  try {
    // Filesystem remotes are not SSH remotes, even when Windows spells one C:\\path.
    expect(admitRemoteUrl(remote)).toBeNull();
    expect(createPublicationCandidateReader(root)(remote))
      .toMatchObject({ ok: false, code: "PUBLISH_REMOTE_URL_INVALID" });
  } finally { if (resolve(root).startsWith(`${base}${sep}`)) rmSync(root, { recursive: true, force: true }); }
});

it("reaches the push for an scp-style ssh remote instead of refusing at the credential read", async () => {
  const base = resolve(tmpdir()); const root = mkdtempSync(join(base, "moe-publication-scp-"));
  const remote = join(root, "remote.git"); const scpStyle = "git@github.com:owner/repo.git";
  try {
    expect(admitRemoteUrl(scpStyle)).toBe(scpStyle);
    const { candidate, git } = publishableFixture(root, scpStyle);
    expect(candidate.approval.remoteUrl).toBe(scpStyle);
    git("init", "--bare", "--quiet", remote);
    const built: string[][] = []; const spawned: string[][] = [];
    // readConfig stays the production default runner so the UNSWAPPED scp-style string reaches the real credential read;
    // only the push/ls-remote runner rewrites it to the local bare repository, so nothing here touches the network.
    const port = createGitPublicationPort({ readConfig: nodeGitRunner, run: async (cwd, args) => {
      built.push([...args]);
      const rewritten = args.map((arg) => arg === scpStyle ? remote : arg);
      spawned.push([...rewritten]); return publicationGitRunner(cwd, rewritten);
    } });
    expect(await port.push(candidate)).toEqual({ ok: true });
    // The port reached the push carrying the scp-style remote, rather than refusing PUBLISH_PUSH_UNKNOWN at the credential read.
    const pushArgv = built.find((args) => args.includes("push"));
    expect(pushArgv).toBeDefined();
    expect(pushArgv).toContain(scpStyle);
    // ...and real git never received it, so no run of this suite can reach github.com.
    expect(spawned.flat()).not.toContain(scpStyle);
    expect(git(`--git-dir=${remote}`, "rev-parse", "refs/heads/approved")).toBe(candidate.approval.sha);
  } finally { if (resolve(root).startsWith(`${base}${sep}`)) rmSync(root, { recursive: true, force: true }); }
}, 90_000);

it("tells a contained tip, a diverged tip and a never-fetched tip apart in a real repository, with real git exit codes", async () => {
  const base = resolve(tmpdir()); const root = mkdtempSync(join(base, "moe-publication-contains-"));
  try {
    const { candidate: first, git } = publishableFixture(root, "https://github.com/fixture/approved.git");
    writeFileSync(join(root, "product.txt"), "second\n"); git("add", "product.txt");
    git("-c", "user.name=Moe", "-c", "user.email=moe@moe.local", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "second");
    const captured = createPublicationCandidateReader(root)("https://github.com/fixture/approved.git");
    if (!captured.ok) throw new Error(captured.code);
    // An operator's own commit on an unrelated line: present locally, yet nothing the approved sha contains.
    git("checkout", "--quiet", "--orphan", "operator"); writeFileSync(join(root, "product.txt"), "operator\n"); git("add", "product.txt");
    git("-c", "user.name=Op", "-c", "user.email=op@moe.local", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "operator");
    const foreign = git("rev-parse", "HEAD");
    const port = createGitPublicationPort({ readConfig: nodeGitRunner, run: publicationGitRunner });
    expect(await port.contains(captured.candidate, first.approval.sha)).toEqual({ ok: true, contains: true, known: true });
    expect(await port.contains(captured.candidate, captured.candidate.approval.sha)).toEqual({ ok: true, contains: true, known: true });
    expect(await port.contains(captured.candidate, foreign)).toEqual({ ok: true, contains: false, known: true });
    expect(await port.contains(captured.candidate, "e".repeat(40))).toEqual({ ok: true, contains: false, known: false });
    expect(await port.contains(captured.candidate, null)).toEqual({ ok: true, contains: true, known: true });
  } finally { if (resolve(root).startsWith(`${base}${sep}`)) rmSync(root, { recursive: true, force: true }); }
}, 90_000);

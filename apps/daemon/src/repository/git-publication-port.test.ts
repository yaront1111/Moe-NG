import { describe, expect, it } from "vitest";
import { createGitPublicationPort } from "./git-publication-port.js";
import { publicationRepositoryId } from "./publication-approval-contracts.js";
import type { GitRunner } from "./git-landing-port.js";
const identity = { root: "D:/approved", gitDirectory: "D:/approved/.git" };
const candidate = { identity, approval: { branch: "approved", sha: "a".repeat(40), remoteUrl: "https://github.com/o/r.git", repositoryId: publicationRepositoryId(identity) } };
function fixture(output = `${candidate.approval.sha}\trefs/heads/approved\n`) {
  const calls: readonly string[][] = [];
  const run: GitRunner = async (_cwd, args) => {
    (calls as string[][]).push([...args]);
    return { code: 0, stderr: "", stdout: args.includes("config") ? "credential.helper\nfixture-manager\0" : args.includes("ls-remote") ? output
      : args.includes("--git-path") ? "D:/approved/.git/objects\n" : args.includes("cat-file") ? "commit\n" : "" };
  };
  return { calls, port: createGitPublicationPort({ run, resolveIdentity: () => ({ ok: true, identity }) }) };
}
describe("immutable publication Git port", () => {
  it("pushes the approved SHA and full branch ref with isolated repository configuration", async () => {
    const f = fixture(); expect(await f.port.push(candidate)).toEqual({ ok: true });
    const push = f.calls.find((args) => args.includes("push"));
    expect(push).toContain(`${candidate.approval.sha}:refs/heads/approved`);
    expect(push).toContain(candidate.approval.remoteUrl); expect(push).toContain("--no-verify");
    expect(push).toContain("credential.helper=fixture-manager");
    expect(push?.[0]).toMatch(/^--git-dir=/u); expect(push?.[0]).not.toContain(identity.gitDirectory);
    expect(f.calls.some((args) => args.includes("HEAD"))).toBe(false);
  });
  it("observes only one exact approved destination branch", async () => {
    expect(await fixture().port.observe(candidate)).toEqual({ ok: true, sha: candidate.approval.sha });
    expect(await fixture("").port.observe(candidate)).toEqual({ ok: true, sha: null });
    expect(await fixture(`${candidate.approval.sha}\trefs/heads/other\n`).port.observe(candidate)).toMatchObject({ ok: false, code: "PUBLISH_REMOTE_UNREADABLE" });
    expect(await fixture(`${candidate.approval.sha}\trefs/heads/approved\n${candidate.approval.sha}\trefs/heads/approved\n`).port.observe(candidate)).toMatchObject({ ok: false });
  });
  it("carries git's own exit code and last words into a push or observe refusal, with any URL secret redacted", async () => {
    // One code used to stand for a missing ssh key, a rejected non-fast-forward and a dead
    // network alike; the publisher's log then said nothing an operator could act on.
    const failing = (stderr: string, code: number | null = 128): GitRunner => async (_cwd, args) => args.includes("push") || args.includes("ls-remote")
      ? { code, stderr, stdout: "" }
      : { code: 0, stderr: "", stdout: args.includes("config") ? "" : args.includes("--git-path") ? "D:/approved/.git/objects\n" : "commit\n" };
    const denied = createGitPublicationPort({ run: failing("git@github.com: Permission denied (publickey).\r\nfatal: Could not read from remote repository.\n"),
      resolveIdentity: () => ({ ok: true, identity }) });
    expect(await denied.push(candidate)).toEqual({ ok: false, code: "PUBLISH_PUSH_UNKNOWN",
      detail: "git exited 128: git@github.com: Permission denied (publickey). fatal: Could not read from remote repository." });
    expect(await denied.observe(candidate)).toMatchObject({ ok: false, code: "PUBLISH_REMOTE_UNREADABLE", detail: expect.stringContaining("Permission denied") });
    const leaking = createGitPublicationPort({ run: failing("fatal: unable to access 'https://alice:ghp_secret123@github.com/o/r.git/': 403", 128),
      resolveIdentity: () => ({ ok: true, identity }) });
    const refusal = await leaking.push(candidate);
    expect(refusal).toMatchObject({ ok: false, detail: expect.stringContaining("https://***@github.com/o/r.git") });
    expect(JSON.stringify(refusal)).not.toContain("ghp_secret123");
    const silent = createGitPublicationPort({ run: failing("", null), resolveIdentity: () => ({ ok: true, identity }) });
    expect(await silent.push(candidate)).toMatchObject({ ok: false, detail: "git exited without a code" });
    // Bounded: a thousand-line remote tantrum does not become the log line.
    const noisy = createGitPublicationPort({ run: failing("x".repeat(5000)), resolveIdentity: () => ({ ok: true, identity }) });
    const long = await noisy.push(candidate);
    expect(long.ok).toBe(false); if (!long.ok) expect(long.detail.length).toBeLessThan(450);
  });
  it("refuses a substituted canonical repository before spawning Git", async () => {
    let calls = 0;
    const port = createGitPublicationPort({ run: async () => { calls += 1; throw new Error("must not run"); },
      resolveIdentity: () => ({ ok: true, identity: { ...identity, root: "D:/other" } }) });
    expect(await port.push(candidate)).toMatchObject({ ok: false, code: "PUBLISH_REPOSITORY_CHANGED" });
    expect(calls).toBe(0);
  });
});

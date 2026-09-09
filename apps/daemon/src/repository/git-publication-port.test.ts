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
  it("refuses a substituted canonical repository before spawning Git", async () => {
    let calls = 0;
    const port = createGitPublicationPort({ run: async () => { calls += 1; throw new Error("must not run"); },
      resolveIdentity: () => ({ ok: true, identity: { ...identity, root: "D:/other" } }) });
    expect(await port.push(candidate)).toMatchObject({ ok: false, code: "PUBLISH_REPOSITORY_CHANGED" });
    expect(calls).toBe(0);
  });
});

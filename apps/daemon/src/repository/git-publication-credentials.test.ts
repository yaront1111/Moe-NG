import { expect, it } from "vitest";
import { publicationCredentialArguments } from "./git-publication-credentials.js";
import { publicationRepositoryId } from "./publication-approval-contracts.js";
const identity = { root: "D:/repo", gitDirectory: "D:/repo/.git" };
const candidate = { identity, approval: { branch: "main", remoteUrl: "https://github.com/fixture/repo.git", sha: "a".repeat(40), repositoryId: publicationRepositoryId(identity) } };
it("selects exact-remote host credential settings as argv without importing remote rewrites or hooks", async () => {
  let args: readonly string[] = [];
  const selected = await publicationCredentialArguments(async (_cwd, given) => {
    args = given; return { code: 0, stderr: "", stdout: "credential.helper\nfixture-manager\0credential.useHttpPath\ntrue\0credential.username\nfixture-user\0url.https://other/.insteadof\nhttps://github.com/\0core.hookspath\nother\0" };
  }, candidate);
  expect(args).toEqual([`--git-dir=${identity.gitDirectory}`, "config", "--null", "--get-urlmatch", "credential", candidate.approval.remoteUrl]);
  expect(selected).toEqual(["-c", "credential.helper=fixture-manager", "-c", "credential.usehttppath=true", "-c", "credential.username=fixture-user"]);
});

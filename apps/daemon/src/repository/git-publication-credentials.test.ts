import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { expect, it } from "vitest";
import { UNMATCHABLE_REMOTE_FATAL, publicationCredentialArguments } from "./git-publication-credentials.js";
import { landingEnvironment } from "./git-landing-port.js";
import type { GitRunResult, GitRunner } from "./git-landing-port.js";
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

const runnerReturning = (result: GitRunResult): GitRunner => async () => result;
const refusalOf = async (result: GitRunResult): Promise<string> => {
  try { await publicationCredentialArguments(runnerReturning(result), candidate); } catch (error) {
    return error instanceof Error ? error.message : `NON_ERROR_THROWN:${String(error)}`;
  }
  return "RESOLVED_WITHOUT_REFUSAL";
};

it("treats a remote git cannot url-match as having no credential configuration", async () => {
  expect(await publicationCredentialArguments(runnerReturning(
    { code: 128, stderr: `${UNMATCHABLE_REMOTE_FATAL}\n`, stdout: "" }), candidate)).toEqual([]);
});

it("still refuses a genuinely unreadable configuration that exits with the same code", async () => {
  expect(await refusalOf({ code: 128, stderr: "fatal: bad config line 2 in file bad.cfg\n", stdout: "" }))
    .toBe("PUBLISH_CREDENTIAL_CONFIGURATION_UNREADABLE");
});

it("keeps reading an absent credential section as no credential configuration", async () => {
  expect(await publicationCredentialArguments(runnerReturning({ code: 1, stderr: "", stdout: "" }), candidate)).toEqual([]);
});

it("refuses a runner that reports no exit status at all", async () => {
  expect(await refusalOf({ code: null, stderr: "", stdout: "" }))
    .toBe("PUBLISH_CREDENTIAL_CONFIGURATION_UNREADABLE");
});

/** The real `git config --get-urlmatch` answer, captured without throwing so both the status and the stderr are assertable. */
const urlMatchCredential = (gitDirectory: string, globalConfig: string, remoteUrl: string) => {
  const environment = landingEnvironment();
  environment["GIT_CONFIG_NOSYSTEM"] = "1";
  environment["GIT_CONFIG_GLOBAL"] = globalConfig;
  const result = spawnSync("git", [`--git-dir=${gitDirectory}`, "config", "--null", "--get-urlmatch", "credential", remoteUrl],
    { encoding: "utf8", env: environment, shell: false, timeout: 15_000, windowsHide: true });
  const observed: GitRunResult = { code: result.status, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
  return { observed, status: result.status, stderrLines: observed.stderr.split(/\r?\n/u) };
};

it("pins the real git answer that separates an unmatchable remote from an unreadable configuration", async () => {
  const base = resolve(tmpdir()); const root = mkdtempSync(join(base, "moe-credential-urlmatch-"));
  try {
    const initialized = spawnSync("git", ["init", "--quiet", root],
      { encoding: "utf8", env: landingEnvironment(), shell: false, timeout: 15_000, windowsHide: true });
    expect(initialized.status).toBe(0);
    const gitDirectory = join(root, ".git");
    const readable = join(root, "readable.cfg"); writeFileSync(readable, "");
    // A section header with no closing bracket: git refuses this configuration before it ever parses the URL.
    const unreadable = join(root, "unreadable.cfg"); writeFileSync(unreadable, "[credential \"https://github.com\"\n\thelper = fixture\n");
    const scpStyle = "git@github.com:owner/repo.git";

    const unmatchable = urlMatchCredential(gitDirectory, readable, scpStyle);
    expect(unmatchable.status).toBe(128);
    expect(unmatchable.stderrLines).toContain(UNMATCHABLE_REMOTE_FATAL);

    const brokenConfiguration = urlMatchCredential(gitDirectory, unreadable, scpStyle);
    expect(brokenConfiguration.status).toBe(128);
    expect(brokenConfiguration.stderrLines).not.toContain(UNMATCHABLE_REMOTE_FATAL);
    expect(brokenConfiguration.stderrLines.some((line) => line.startsWith("fatal: bad config line 2 in file "))).toBe(true);

    // The readable-configuration control the production module's first arm reads as "no credential configuration".
    const absentSection = urlMatchCredential(gitDirectory, readable, "https://github.com/owner/repo.git");
    expect(absentSection.status).toBe(1);

    // Real git bytes, replayed through the production predicate: the pin is asserted against the surface, not a restatement of it.
    expect(await publicationCredentialArguments(runnerReturning(unmatchable.observed), candidate)).toEqual([]);
    expect(await refusalOf(brokenConfiguration.observed)).toBe("PUBLISH_CREDENTIAL_CONFIGURATION_UNREADABLE");
    expect(await publicationCredentialArguments(runnerReturning(absentSection.observed), candidate)).toEqual([]);
  } finally { if (resolve(root).startsWith(`${base}${sep}`)) rmSync(root, { recursive: true, force: true }); }
}, 90_000);

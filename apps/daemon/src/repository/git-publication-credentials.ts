import type { GitRunner } from "./git-landing-port.js";
import type { PublicationCandidate } from "./publication-approval-contracts.js";

/**
 * Git refuses to url-match a remote with no `://` scheme (scp-style SSH, a local bare repository).
 * `LC_ALL=C` is pinned by `landingEnvironment()`, so this line is stable; an unrecognised stderr still fails closed.
 */
export const UNMATCHABLE_REMOTE_FATAL = "fatal: invalid URL scheme name or missing '://' suffix";

/** Host authentication configuration is trusted; remote rewrites and arbitrary Git settings are excluded. */
export async function publicationCredentialArguments(run: GitRunner, candidate: PublicationCandidate): Promise<readonly string[]> {
  const result = await run(candidate.identity.root, [`--git-dir=${candidate.identity.gitDirectory}`, "config", "--null", "--get-urlmatch", "credential", candidate.approval.remoteUrl]);
  if (result.code === 1 && result.stdout === "") return [];
  if (result.code === 128 && result.stdout === "" && result.stderr.split(/\r?\n/u).some((line) => line === UNMATCHABLE_REMOTE_FATAL)) return [];
  if (result.code !== 0) throw new Error("PUBLISH_CREDENTIAL_CONFIGURATION_UNREADABLE");
  const arguments_: string[] = [];
  for (const row of result.stdout.split("\0")) {
    if (row === "") continue;
    const separator = row.indexOf("\n");
    if (separator < 0) throw new Error("PUBLISH_CREDENTIAL_CONFIGURATION_UNREADABLE");
    const key = row.slice(0, separator).toLowerCase(); const value = row.slice(separator + 1);
    if (!["credential.helper", "credential.usehttppath", "credential.username"].includes(key)) continue;
    if (/[\r\n\0]/u.test(value)) throw new Error("PUBLISH_CREDENTIAL_CONFIGURATION_UNREADABLE");
    arguments_.push("-c", `${key}=${value}`);
  }
  return arguments_;
}

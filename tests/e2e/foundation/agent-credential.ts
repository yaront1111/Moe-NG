/**
 * THE AGENT CREDENTIAL, resolved for the SPAWNED stack instead of inherited by it.
 *
 * A session on this host is spawned by a launcher that has been running since the day
 * before; a process's environment block is fixed at creation, so a credential an operator
 * exports today is invisible to it no matter how many times a task is retried. The USER and
 * MACHINE scopes are not served from that block — .NET reads them from the registry at call
 * time — so resolving them here is what a fresh shell would have inherited, done explicitly.
 *
 * THE VALUE IS NEVER LOGGED. `credentialProvenance` names the variable, its scope and the
 * name it is delivered under; nothing in this module writes the value anywhere but the env
 * object a caller hands to a child.
 *
 * Split out of `j1-loop-harness.ts` when composing the canary lane pushed that module past
 * the 400-line threshold. Moved verbatim: this file resolves a credential and knows nothing
 * about processes; the harness spawns processes and knows nothing about registries.
 *
 * NO WALL CLOCK AND NO RANDOM SOURCE — `e2e-harness.test.ts` scans every non-test module in
 * this directory for four needles by plain substring match, and spelling one out here, even
 * inside a comment, reddens it.
 */
import { execFileSync } from "node:child_process";

const IS_WINDOWS = process.platform === "win32";

export type CredentialScope = "Machine" | "Process" | "User";
/** The two environment names a `claude -p` seat actually reads. */
export type DeliveredCredentialName = "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN";

export interface AgentCredential {
  readonly deliveredAs: DeliveredCredentialName;
  readonly scope: CredentialScope;
  readonly sourceName: string;
  readonly value: string;
}

/**
 * `CLAUDE_CODE_OAUTH_TOKEN` is READ FOR ITS VALUE AND DELIVERED UNDER ANOTHER NAME: measured
 * on this host with a scrubbed-env discriminating pair, `claude -p` ignores that name
 * and authenticates on the same bytes presented as ANTHROPIC_AUTH_TOKEN. Resolving it without
 * renaming it would find a credential and still spawn an unauthenticated child.
 */
const CREDENTIAL_SOURCES: ReadonlyMap<string, DeliveredCredentialName> = new Map([
  ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"],
  ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"],
  ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
]);

/** One persistent-scope read. Anything but a value — absent, unreadable, no PowerShell — is null. */
function persistentValue(name: string, scope: "Machine" | "User"): string | null {
  if (!IS_WINDOWS) return null;
  try {
    const output = execFileSync("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      `$v=[Environment]::GetEnvironmentVariable('${name}','${scope}');`
      + " if ($null -ne $v) { [Console]::Out.Write($v) }",
    ], { encoding: "utf8", windowsHide: true });
    return output === "" ? null : output.trim();
  } catch {
    return null;
  }
}

const credentialOf = (
  sourceName: string, scope: CredentialScope, value: string,
): AgentCredential => Object.freeze({
  deliveredAs: CREDENTIAL_SOURCES.get(sourceName) as DeliveredCredentialName,
  scope,
  sourceName,
  value,
});

/** Process env first — an operator-keyed shell must win — then the registry scopes. */
export function resolveAgentCredential(
  source: NodeJS.ProcessEnv = process.env,
): AgentCredential | null {
  for (const name of CREDENTIAL_SOURCES.keys()) {
    const value = source[name];
    if (value !== undefined && value !== "") return credentialOf(name, "Process", value);
  }
  for (const scope of ["User", "Machine"] as const) {
    for (const name of CREDENTIAL_SOURCES.keys()) {
      const value = persistentValue(name, scope);
      if (value !== null && value !== "") return credentialOf(name, scope, value);
    }
  }
  return null;
}

/** Everything about a resolved credential that may be printed: the value is not in it. */
export function credentialProvenance(credential: AgentCredential): Record<string, string> {
  return {
    deliveredAs: credential.deliveredAs,
    scope: credential.scope,
    sourceName: credential.sourceName,
  };
}

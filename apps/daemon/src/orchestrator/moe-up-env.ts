import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_AGENT_COMMAND, loginCredentialPath, present, providerCredentials, providerFor,
  refuseCredential,
} from "./moe-up-credentials.js";
import type {
  FileExists, LaunchRefusal, LaunchValueSource, LaunchVariable,
} from "./moe-up-credentials.js";

/**
 * The dev launcher's environment layer, kept PURE over its inputs so every
 * refusal is unit-testable without a process, a store, or a filesystem.
 *
 * This is a DEVELOPMENT composer: the three store variables the daemon and the
 * wrapper both require are defaulted or minted here rather than refused, so a
 * clean checkout plus any one accepted credential is a running stack. The one
 * thing nothing downstream can invent — the provider credential the agent
 * children authenticate with — is refused BY NAME instead, from the per-provider
 * rosters in `moe-up-credentials.ts`.
 */

// Re-exported so this module's published surface is unchanged by the split.
export { MOE_UP_ENV_MISSING } from "./moe-up-credentials.js";
export type {
  FileExists, LaunchRefusal, LaunchValueSource, LaunchVariable,
} from "./moe-up-credentials.js";

export interface LaunchConfig {
  readonly agentCommand: string;
  readonly credential: string;
  /** The overlay handed to both children: only the variables this module owns. */
  readonly env: Readonly<Record<string, string>>;
  readonly ok: true;
  readonly projectId: string;
  readonly storePath: string;
  readonly variables: readonly LaunchVariable[];
}

export interface LaunchRefused {
  readonly ok: false;
  readonly refusals: readonly LaunchRefusal[];
}

export type LaunchEnvResolution = LaunchConfig | LaunchRefused;

export interface LaunchEnvInputs {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** INJECTED so the sign-in lookup never reads the test host's home directory. */
  readonly fileExists?: FileExists;
  /** INJECTED so two runs over identical inputs produce an identical config. */
  readonly randomHex?: (bytes: number) => string;
  readonly repoRoot: string;
}

/** The dev store lives beside the checkout, never in the user's profile. */
const DEV_STORE_SEGMENTS = [".moe-dev", "store.sqlite"] as const;
const DEV_PROJECT_ID = "moe-next-dev";
const CREDENTIAL_BYTES = 32;

function variable(
  name: string, preset: string | null, fallback: () => string,
  fallbackSource: LaunchValueSource, secret = false,
): LaunchVariable {
  const source: LaunchValueSource = preset === null ? fallbackSource : "PRESET";
  return Object.freeze({ name, secret, source, value: preset ?? fallback() });
}

function passthrough(
  env: Readonly<Record<string, string | undefined>>, name: string,
): readonly LaunchVariable[] {
  const preset = present(env, name);
  return preset === null ? [] : [variable(name, preset, () => preset, "PRESET")];
}

export function resolveLaunchEnv(inputs: LaunchEnvInputs): LaunchEnvResolution {
  const { env, repoRoot } = inputs;
  const randomHex = inputs.randomHex
    ?? ((bytes: number): string => randomBytes(bytes).toString("hex"));

  const agentCommand = variable(
    "MOE_AGENT_COMMAND", present(env, "MOE_AGENT_COMMAND"),
    () => DEFAULT_AGENT_COMMAND, "DEFAULTED",
  );

  // The one thing this launcher cannot invent: a seat with no credential spawns,
  // fails, and looks like an orchestration bug. A credential is EITHER a named
  // environment variable OR the sign-in the operator already holds on disk (the
  // seats run without `--bare`, so the CLI reads its own login); the gate
  // refuses only when neither exists. A codex child is gated the same way.
  const provider = providerFor(agentCommand.value);
  let credentials: readonly LaunchVariable[] = [];
  if (provider !== undefined) {
    const accepted = providerCredentials(provider, env, inputs.fileExists ?? existsSync);
    if (accepted === null) {
      return Object.freeze({
        ok: false,
        refusals: Object.freeze([
          refuseCredential(provider, loginCredentialPath(provider, env)),
        ]),
      });
    }
    credentials = accepted;
  }

  const variables: readonly LaunchVariable[] = Object.freeze([
    variable("MOE_STORE_PATH", present(env, "MOE_STORE_PATH"),
      () => join(repoRoot, ...DEV_STORE_SEGMENTS), "DEFAULTED"),
    variable("MOE_PROJECT_ID", present(env, "MOE_PROJECT_ID"),
      () => DEV_PROJECT_ID, "DEFAULTED"),
    variable("MOE_DAEMON_CREDENTIAL", present(env, "MOE_DAEMON_CREDENTIAL"),
      () => randomHex(CREDENTIAL_BYTES), "MINTED", true),
    ...passthrough(env, "MOE_FOUNDATION_WORKSPACE_CATALOG"),
    // The compiled-node host facts: where compiled code is built and how it is
    // verified. Host-scoped on purpose — an agent-submitted plan structure can
    // never name a workspace path or a shell command.
    ...passthrough(env, "MOE_NODE_TEST_COMMAND"),
    ...passthrough(env, "MOE_NODE_WORKSPACE"),
    ...passthrough(env, "MOE_PROJECT_CONFIGURATION_DIGEST"),
    ...passthrough(env, "MOE_VERIFICATION_CATALOG"),
    agentCommand,
    ...credentials,
  ]);

  const overlay: Record<string, string> = {};
  for (const entry of variables) overlay[entry.name] = entry.value;

  const read = (name: string): string => {
    const found = variables.find((entry) => entry.name === name);
    if (found === undefined) throw new Error(`unreachable: ${name} is always resolved`);
    return found.value;
  };

  return Object.freeze({
    agentCommand: agentCommand.value,
    credential: read("MOE_DAEMON_CREDENTIAL"),
    env: Object.freeze(overlay),
    ok: true,
    projectId: read("MOE_PROJECT_ID"),
    storePath: read("MOE_STORE_PATH"),
    variables,
  });
}

const SOURCE_WORD: Readonly<Record<LaunchValueSource, string>> = Object.freeze({
  DEFAULTED: "defaulted",
  MINTED: "minted",
  PRESET: "preset",
});

/**
 * Operator-facing disclosure. A secret is named and its provenance stated, but
 * the value never reaches the console: a dev credential printed into a scrollback
 * is a credential in every screen recording of the demo it was minted for.
 */
export function describeLaunchVariables(
  variables: readonly LaunchVariable[],
): readonly string[] {
  return variables.map((entry) => {
    const shown = entry.secret ? `<${SOURCE_WORD[entry.source]}, hidden>` : entry.value;
    return `  ${entry.name}=${shown} (${SOURCE_WORD[entry.source]})`;
  });
}

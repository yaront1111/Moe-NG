/**
 * The user-facing text the artifact carries. Kept in one module so every claim
 * in it is reviewable in one place — and every claim here is MEASURED: the Node
 * range is the root manifest's own `engines`, the credential story is what
 * `moe init` actually does, and the exclusions are what v0.1 genuinely omits.
 */

export interface InstallDocInputs {
  readonly closureCount: number;
  readonly nodeRange: string;
  readonly version: string;
}

export function installDoc(inputs: InstallDocInputs): string {
  return `# moe ${inputs.version} — Windows supervised MVP

## Prerequisite

Node \`${inputs.nodeRange}\`. No runtime is bundled: install Node yourself from
https://nodejs.org/en/download and check it with \`node --version\`. \`moe init\`
and \`moe start\` refuse by name (\`MOE_CLI_NODE_UNSUPPORTED\`) on anything else,
because this artifact ships TypeScript sources that Node 24 strips at load.

## Install

1. Unzip anywhere you can write. A path with spaces is fine.
2. \`.\\moe.cmd init demo\` — creates \`demo\\\`, mints an operator credential, and
   writes \`demo\\moe.config.json\`. The credential is minted ON YOUR MACHINE and
   is not in this zip. It is written to that config; treat the file as a secret.
3. \`.\\moe.cmd start demo\` — starts the daemon and the agent wrapper and prints
   \`moe up: daemon listening on http://127.0.0.1:<port>\`. Ctrl-C stops both.

\`moe --help\` lists every wired command. \`moe init\` refuses rather than
overwriting an existing config, so re-running it is safe.

## Running real agents

The spawned \`claude --bare\` children read no keychain, so \`moe start\` refuses
before it spawns anything unless ONE agent credential is set. On a Claude
subscription this is the default path:

    claude setup-token
    $env:CLAUDE_CODE_OAUTH_TOKEN = "<token printed by setup-token>"

An API key is the alternative:

    $env:ANTHROPIC_API_KEY = "<your key>"

With none set the refusal names all three accepted variables:
\`MOE_UP_ENV_MISSING: CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN,
ANTHROPIC_API_KEY\`. Measured on Claude Code 2.1.235, \`claude --bare\` does not
read \`CLAUDE_CODE_OAUTH_TOKEN\` itself, so the launcher delivers that value to
its children as \`ANTHROPIC_AUTH_TOKEN\`; exporting \`ANTHROPIC_AUTH_TOKEN\`
yourself is equivalent.

## Control room

The built control-room bundle is in \`control-room\\\`. Serve that directory with
any static file server and point it at the origin \`moe start\` printed. v0.1
does not host it from the daemon.

## What this build is NOT

Supervised MVP, Windows + Claude only. No code signing, no auto-update, no
bundled Node, no npm publication. The workspace verifier runs in your trusted
workspace and is not sandboxed. Read \`MANIFEST-CLOSURE.txt\` for the
${String(inputs.closureCount)} third-party packages this artifact carries.

## First run

\`moe start\` creates \`node_modules\\@moe\\*\` junctions to the \`packages\\\`
directories on first use. A zip cannot carry links, and Node refuses to strip
types from sources whose real path is under \`node_modules\`, so the links are
made at start time. Moving the extracted folder is fine: the next \`moe start\`
repairs them.
`;
}

/**
 * `%~dp0` already ends in a backslash, and the quotes survive a path with
 * spaces. `exit /b` forwards the CLI's own code — without it the batch file
 * reports success for a refusal.
 */
export const MOE_CMD = `@echo off
setlocal
node "%~dp0apps\\daemon\\src\\cli\\moe-cli-main.ts" %*
exit /b %errorlevel%
`;

/** `@args` splats without re-parsing, so a quoted target survives intact. */
export const MOE_PS1 = `#!/usr/bin/env pwsh
$entry = Join-Path $PSScriptRoot 'apps/daemon/src/cli/moe-cli-main.ts'
& node $entry @args
exit $LASTEXITCODE
`;

export interface ClosureDocInputs {
  readonly dirtyPaths: readonly string[];
  readonly entries: readonly { readonly name: string; readonly version: string }[];
  readonly version: string;
}

export function closureDoc(inputs: ClosureDocInputs): string {
  const header = [
    `moe ${inputs.version} — third-party dependency closure`,
    "",
    "Every non-@moe package under node_modules in this artifact, name and version.",
    `Count: ${String(inputs.entries.length)}`,
  ];
  if (inputs.dirtyPaths.length > 0) {
    // Disclosed, never hidden: a --allow-dirty pack ships bytes that are in no
    // commit, and the reviewer must be able to see that from the zip alone.
    header.push(
      "",
      "WARNING: packed from a DIRTY worktree with --allow-dirty. These shipped",
      "paths carried uncommitted changes and are in no commit:",
      ...inputs.dirtyPaths.map((path) => `  ${path}`),
    );
  }
  return `${[...header, "", ...inputs.entries.map(
    (entry) => `${entry.name}@${entry.version}`,
  )].join("\n")}\n`;
}

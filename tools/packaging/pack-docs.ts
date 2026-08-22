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

The built control-room bundle is in \`control-room\\\`. \`moe start\` finds it
there and the daemon hosts it on its own origin, so the line it prints -
\`moe up: control room -> open http://127.0.0.1:<port>/\` - is the ONE URL to
open; nothing else needs serving. If that directory is absent the daemon hosts
nothing and \`moe start\` prints the two-process recipe instead.

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

/**
 * `@args` splats without re-parsing, so a quoted target survives intact.
 *
 * node is RESOLVED before it is called, because otherwise a missing runtime reads
 * as SUCCESS: `& node` raises CommandNotFoundException, which never assigns
 * `$LASTEXITCODE`, and `exit $null` exits 0. The absence is refused by name with
 * the code cmd already gives `moe.cmd` for it - 9009 - so one condition has one
 * code whichever launcher a wrapper drove. `Select-Object -First 1` because a
 * PATH carrying more than one `node` yields more than one command object, and
 * `$node.Source` would then be an array rather than a path.
 */
export const MOE_PS1 = `#!/usr/bin/env pwsh
$entry = Join-Path $PSScriptRoot 'apps/daemon/src/cli/moe-cli-main.ts'
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($null -eq $node) {
  [Console]::Error.WriteLine(
    'MOE_CLI_NODE_MISSING: no node on PATH; INSTALL.md names the version this build needs')
  exit 9009
}
& $node.Source $entry @args
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

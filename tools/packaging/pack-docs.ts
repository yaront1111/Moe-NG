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
3. \`.\\moe.cmd start demo\` — starts one project runtime (the daemon and the
   agent wrapper, inside a Windows Job) and prints
   \`moe start: http://127.0.0.1:<port>\` followed by
   \`moe start: Ctrl-C stops this project runtime\`. Ctrl-C stops both.

\`moe --help\` lists every wired command. \`moe init\` refuses rather than
overwriting an existing config, so re-running it is safe.

## Recover a blocked review

Keep the original single-project runtime running, then use this repaired artifact:

    .\\moe.ps1 recover-review 'D:\\path\\to\\project'

This verifies and drains the original Windows Job, preserves the existing work and
repository reservation, and starts the repaired runtime in the same terminal.
It does not accept the product or grant another review attempt. If Windows returns
\`RUNTIME_REVIEW_DRAIN_ACCESS_DENIED\`, run the command from PowerShell with the same
privileges as the original runtime (usually **Run as administrator**). Keep the
original runtime alive until recovery attaches. A refusal prints its reason code
and does not start another runtime. Multi-project manager sessions are unsupported.

## Running real agents

Moe can use your existing Claude sign-in. If you have not signed in, run
\`claude\` and use \`/login\` once. \`moe start\` looks for \`.credentials.json\`
in \`CLAUDE_CONFIG_DIR\`, or in \`%USERPROFILE%\\.claude\` by default.

Alternatively, set an environment credential before starting Moe. For a
Claude subscription:

    claude setup-token
    $env:CLAUDE_CODE_OAUTH_TOKEN = "<token printed by setup-token>"

An API key is the alternative:

    $env:ANTHROPIC_API_KEY = "<your key>"

You can also set \`ANTHROPIC_AUTH_TOKEN\` directly. Environment credentials take
precedence over the saved sign-in. The launcher supplies
\`CLAUDE_CODE_OAUTH_TOKEN\` to its children as \`ANTHROPIC_AUTH_TOKEN\` unless
\`ANTHROPIC_AUTH_TOKEN\` is already set.

If no accepted environment credential or saved sign-in is present,
\`moe start\` refuses before spawning children with
\`MOE_UP_ENV_MISSING PROJECT_MANAGER_LAUNCH\`; the next line names the three
accepted variables and the sign-in path it checked.

## Control room

The built control-room bundle is in \`control-room\\\`. \`moe start\` finds it
there and the daemon hosts it on its own origin, so the origin it prints -
\`moe start: http://127.0.0.1:<port>\` - is the ONE URL to open; nothing else
needs serving. If that directory is absent, \`moe start\` refuses before
spawning anything with \`PROJECT_SINGLE_ASSET_ROOT_MISSING PROJECT_SINGLE_MAIN\`
(exit 1): re-extract the zip or restore the directory.

## Headless access (no browser)

\`moe mcp demo\` serves that project to an MCP client over stdio. There is no
pairing step and no CSRF token: the browser control route is walled by Host,
Origin and a token minted when you pair, which a script or an agent session has
no way to obtain. The MCP transport authenticates by credential instead, and
\`moe mcp\` reads \`moe.config.json\` itself — so NO credential belongs in the
client config below. Point a client at it with:

    {"mcpServers":{"moe-next":{"command":"node","args":["C:\\\\moe\\\\apps\\\\daemon\\\\src\\\\cli\\\\moe-cli-main.ts","mcp","C:\\\\work\\\\demo"]}}}

\`C:\\moe\` stands for the folder you unzipped and \`C:\\work\\demo\` for the
project; both paths must be absolute, because the client starts \`node\` from a
working directory of its own. That entry is the file \`moe.cmd\` runs, so this
is still \`moe mcp\`. It is named directly because a client starts its command
literally, and \`moe.cmd\` is on no PATH.

That session can create goals — \`goal.create\`, and \`goal.create_with_source\`
to bind a PRD — and read state through \`work.get_context\`, \`graph.get\`,
\`graph.preview\`, \`product_contract.read\`, \`events.read\`,
\`documents.source_read\` and \`design.read\`.

It cannot approve a plan, close or cancel a goal, choose a provider, or roll
back a deployment. Those are refused at the transport with
\`CAPABILITY_DENIED\` before anything is dispatched, because they are human
acts: this wire authenticates with your operator credential, so an MCP caller
that reached them would be indistinguishable from you in the browser.

\`moe mcp demo --as-operator\` is how YOU hand one such session your own seat
(in the client config, add \`"--as-operator"\` as a fourth argument). That
session can then decide approvals, answer an exhausted review or a
clarification and close or cancel a goal, AS YOU: nothing checks it a second
time, because the credential is yours. It can also change settings:
\`project.set_agent_provider\` (which vendor receives your source),
\`deployment.set_target\`, \`environment.unset_variable\`,
\`monitoring.set_probe_interval\`, \`monitoring.retire_environment\`,
\`graph.supersede\`, \`integration.accept_output\` and
\`resource.confirm_released\`. Each such act is written to the project's
\`.moe\\logs\` as \`MCP_OPERATOR_ACT_DELEGATED\` when it is ATTEMPTED, before
the daemon answers, so a refused attempt has a line too; \`--as-operator\`
refuses to start while that log is off. Deploys, rollbacks, release and
preview decisions, secret values and criterion evidence stay refused on this
wire with or without the flag. Moe never SERVES any of it to the agents
\`moe start\` runs. That is a rule Moe keeps, not a wall around them: a coding
agent has a shell in the project directory, where \`moe.config.json\` holds
your credential.

One warning: stdout on this wire carries JSON-RPC. Everything \`moe mcp\`
itself has to say — the project it opened, and any refusal — goes to stderr.

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

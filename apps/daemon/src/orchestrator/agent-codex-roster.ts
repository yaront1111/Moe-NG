/**
 * The claude tool roster, mapped onto the one lever codex exposes for the same fact.
 *
 * WHY THIS IS A CONFIG OVERRIDE AND NOT A FLAG. Measured 2026-09-07 on host Yaron-PC against
 * codex-cli 0.153.4: `codex exec --help` carries NO `--tools` and NO `--allowedTools` — no tool
 * flag of any kind. The per-server roster is a `-c` key under `mcp_servers.<name>`. Probed with
 * `codex exec --strict-config`, which rejects a field the build does not recognize (negative
 * control `mcp_servers.moe-next.totally_not_a_key=1` -> `unknown configuration field`, so the
 * probe discriminates rather than always passing): `enabled_tools` and `disabled_tools` are
 * ACCEPTED, `allowed_tools` is REJECTED.
 *
 * DERIVED, NEVER A SECOND LIST. The value is computed from the SAME `--allowedTools` string the
 * claude seat is launched with (`agentRoleForWorkspace`), so a tool added or removed there moves
 * both providers at once. A hand-kept codex list would drift, and the parity test would be the
 * only thing holding the two together — which makes the test a copy check rather than a property.
 *
 * WHY THE WHOLE-SERVER GRANT IS `disabled_tools=[]` AND NOT `enabled_tools=['*']`.
 * `--strict-config` validates SHAPE ONLY: `enabled_tools=['*']` and `enabled_tools=['srv*']` are
 * both accepted, so whether an entry is globbed or matched literally CANNOT be settled offline,
 * and `codex mcp list --json` prints configured servers without ever connecting to one. If `'*'`
 * were matched literally a codex seat would be left with ZERO moe tools — strictly worse than
 * today's no-roster state and invisible until a seat failed mid-run. `disabled_tools=[]` says
 * "withhold nothing from this server", reaching the same set with no glob dependency. A NARROWED
 * roster still emits an explicit `enabled_tools` list, where no glob is needed either way.
 *
 * QUOTING. `enabled_tools` is sequence-typed, so a quote-free value is refused
 * (`invalid type: string "[moe_get_context]", expected a sequence`) — codex parses each `-c`
 * value as TOML and falls back to the raw literal, and `[bare_word]` is not TOML. Double quotes
 * would parse but are refused by this repo's own win32 fence (`UNQUOTABLE` in
 * agent-spawn-invocation.ts). TOML LITERAL STRINGS (single quotes) satisfy both, so that is the
 * spelling emitted here and `assertRosterSafe` keeps a name from ever closing one early.
 *
 * THE BUILTIN HALF IS NOT A ROSTER PROBLEM, so nothing here emits a `-c` for it. Claude's
 * `--tools Edit,Write,Read,Glob,Grep,Bash` has no codex counterpart: codex's file and shell
 * authority is governed by `--sandbox read-only|workspace-write`, which the spawner already sets
 * from the same `workspace` flag that chooses the claude roster. Do not add a phantom override.
 */

/** The one MCP server an agent seat may talk to; named identically on both providers. */
export const CODEX_MCP_SERVER = "moe-next";

/** Claude's own namespace for an MCP tool: `mcp__<server>` or `mcp__<server>__<tool>`. */
const CLAUDE_MCP_PREFIX = "mcp__";

/**
 * A tool name safe inside a TOML literal string AND on a cmd.exe command line. A name carrying a
 * single quote would close the literal early and change which tools the seat is granted, which is
 * a silent authority change rather than a parse error — so it fails closed here instead.
 */
const SAFE_TOOL_NAME = /^[A-Za-z0-9_.:-]+$/u;

function assertRosterSafe(tool: string): string {
  if (!SAFE_TOOL_NAME.test(tool)) throw new Error("CODEX_ROSTER_TOOL_UNSAFE");
  return tool;
}

/**
 * The `-c` pair a codex seat carries so its MCP roster equals the claude seat's, flattened for
 * splicing straight into argv. Builtins in `allowedTools` are skipped: they are not tools of this
 * server and reach parity through `--sandbox`.
 */
export function codexMcpRosterArgs(
  allowedTools: string, server: string = CODEX_MCP_SERVER,
): readonly string[] {
  const toolPrefix = `${CLAUDE_MCP_PREFIX}${server}__`;
  const tools: string[] = [];
  let wholeServer = false;
  for (const entry of allowedTools.split(",")) {
    const name = entry.trim();
    // The bare server grant. Codex expresses it by having the server CONFIGURED at all — the
    // `.url` override the spawner already passes — so it contributes no roster entry here.
    if (name === `${CLAUDE_MCP_PREFIX}${server}`) continue;
    if (!name.startsWith(toolPrefix)) continue;
    const tool = name.slice(toolPrefix.length);
    if (tool === "*") wholeServer = true;
    else tools.push(assertRosterSafe(tool));
  }
  if (wholeServer) return Object.freeze(["-c", `mcp_servers.${server}.disabled_tools=[]`]);
  const listed = tools.map((tool) => `'${tool}'`).join(",");
  return Object.freeze(["-c", `mcp_servers.${server}.enabled_tools=[${listed}]`]);
}

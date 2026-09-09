import { describe, expect, it } from "vitest";

import { CODEX_MCP_SERVER, codexMcpRosterArgs } from "./agent-codex-roster.js";
import { agentSpawnInvocation } from "./agent-spawn-invocation.js";
import { CHAIN_TOOLS, CODING_TOOLS } from "./agent-role-contract.js";

/**
 * The mapping's edge cases. The PARITY property itself is asserted in agent-spawner.test.ts
 * against the argv the spawner actually composes — asserting it here, against the mapper alone,
 * would prove only that the mapper agrees with itself.
 */
describe("maps a claude roster onto codex's per-server override", () => {
  it("names the one server both providers share", () => {
    expect(CODEX_MCP_SERVER).toBe("moe-next");
  });

  it("emits the whole-server grant for both shipped rosters", () => {
    // Both rosters carry `mcp__moe-next__*`; they differ only in builtins, which are not
    // tools of this server and reach parity through `--sandbox`.
    const expected = ["-c", "mcp_servers.moe-next.disabled_tools=[]"];
    expect(codexMcpRosterArgs(CHAIN_TOOLS)).toEqual(expected);
    expect(codexMcpRosterArgs(CODING_TOOLS)).toEqual(expected);
  });

  it("enumerates a narrowed roster as single-quoted TOML literals", () => {
    // No glob is involved once the roster names tools, so `enabled_tools` is used directly.
    expect(codexMcpRosterArgs("mcp__moe-next,mcp__moe-next__moe_get_context,Edit"))
      .toEqual(["-c", "mcp_servers.moe-next.enabled_tools=['moe_get_context']"]);
    expect(codexMcpRosterArgs("mcp__moe-next__a,mcp__moe-next__b"))
      .toEqual(["-c", "mcp_servers.moe-next.enabled_tools=['a','b']"]);
  });

  it("grants no tool when the roster names none of this server's", () => {
    // An empty list is the honest reading of "no moe tools": it must NOT collapse into the
    // whole-server grant, which is how a narrowing would silently become a widening.
    expect(codexMcpRosterArgs("Edit,Write,Bash"))
      .toEqual(["-c", "mcp_servers.moe-next.enabled_tools=[]"]);
    expect(codexMcpRosterArgs("mcp__other__*"))
      .toEqual(["-c", "mcp_servers.moe-next.enabled_tools=[]"]);
  });

  it("reads the server it was given, not only the default", () => {
    expect(codexMcpRosterArgs("mcp__other__*", "other"))
      .toEqual(["-c", "mcp_servers.other.disabled_tools=[]"]);
  });

  it("refuses a tool name that would close the TOML literal early", () => {
    // A single quote inside the name would end the literal string and change WHICH tools the
    // seat is granted — an authority change that parses cleanly, so it fails closed instead.
    expect(() => codexMcpRosterArgs("mcp__moe-next__a','b")).toThrow("CODEX_ROSTER_TOOL_UNSAFE");
    expect(() => codexMcpRosterArgs("mcp__moe-next__a b")).toThrow("CODEX_ROSTER_TOOL_UNSAFE");
  });

  /**
   * THE win32 QUOTING FENCE, driven through the PRODUCTION composer rather than re-derived.
   * `agentSpawnInvocation` collapses argv into ONE cmd line and refuses anything cmd.exe would
   * reinterpret; an emitted roster value that acquired a `"` or a space would show up here as a
   * refusal or as a re-quoted argument, not as a passing test elsewhere. Every roster this
   * daemon can emit — including the degenerate ones — is checked.
   */
  it("survives the win32 cmd fence for every roster it can emit", () => {
    const rosters = ["", CHAIN_TOOLS, CODING_TOOLS, "mcp__moe-next", "Edit,Write",
      "mcp__moe-next__a,mcp__moe-next__b"];
    for (const roster of rosters) {
      const args = codexMcpRosterArgs(roster);
      const line = agentSpawnInvocation("codex", ["exec", ...args, "-"], "win32").file;
      // Not re-quoted (no `"` anywhere) and the value survives verbatim into the one line.
      expect(line).not.toContain('"');
      expect(line).toContain(args[1] as string);
    }
  });

  it("emits a loadable empty list rather than nothing when no moe tool is granted", () => {
    // The degenerate roster. The value must still be a TOML SEQUENCE — `enabled_tools=` with an
    // empty right-hand side would be parsed as a string and rejected by codex — and it must not
    // acquire whitespace, which is what the cmd fence would otherwise have to quote.
    const args = codexMcpRosterArgs("");
    expect(args).toEqual(["-c", "mcp_servers.moe-next.enabled_tools=[]"]);
    expect(args[1]).not.toMatch(/\s/u);
  });

  it("emits no result-size override, because codex recognizes none", () => {
    // Measured on codex-cli 0.153.4: `tool_max_output_tokens`, `max_output_tokens`,
    // `output_token_limit`, `tools.max_output_tokens` and `model_max_output_tokens` are all
    // rejected as unknown fields. A future diff that invents one has to argue with that.
    for (const argument of codexMcpRosterArgs(CODING_TOOLS)) {
      expect(argument).not.toMatch(/token|output_limit|max_output/u);
    }
  });
});

import { describe, expect, it } from "vitest";

import { agentSpawnInvocation } from "./agent-spawn-invocation.js";

const ARGS = ["-p", "--mcp-config", "C:/tmp/moe-wrapper-1/sess.json", "--allowedTools", "mcp__moe-next"];

describe("agentSpawnInvocation", () => {
  it("spawns the command directly with argv on non-Windows platforms", () => {
    const invocation = agentSpawnInvocation("claude", ARGS, "linux");
    expect(invocation).toEqual({ args: ARGS, file: "claude", shell: false });
  });

  it("collapses to ONE shell command line on Windows, so no argv reaches a shell spawn", () => {
    // DEP0190: argv + shell:true is deprecated because the pieces are concatenated
    // unescaped. Building the line ourselves is the supported shape and keeps the
    // .cmd shim resolvable.
    const invocation = agentSpawnInvocation("claude", ARGS, "win32");
    expect(invocation).toEqual({
      args: [],
      file: "claude -p --mcp-config C:/tmp/moe-wrapper-1/sess.json --allowedTools mcp__moe-next",
      shell: true,
    });
  });

  it("quotes a Windows argument that carries whitespace instead of shredding it", () => {
    const invocation = agentSpawnInvocation(
      "claude",
      ["--mcp-config", "C:/Users/Some One/AppData/Local/Temp/moe-wrapper-1/sess.json"],
      "win32",
    );
    expect(invocation.file).toBe(
      'claude --mcp-config "C:/Users/Some One/AppData/Local/Temp/moe-wrapper-1/sess.json"',
    );
  });

  it("refuses an argument that would break out of the shell line", () => {
    // A double quote inside an argument cannot be quoted safely under cmd.exe; the
    // wrapper never produces one, so a hostile or corrupt path fails closed here
    // rather than executing something else.
    expect(() => agentSpawnInvocation("claude", ['a"b'], "win32")).toThrow(
      /SPAWN_ARGUMENT_UNQUOTABLE/u,
    );
    expect(() => agentSpawnInvocation("claude", ["a&b"], "win32")).toThrow(
      /SPAWN_ARGUMENT_UNQUOTABLE/u,
    );
  });
});

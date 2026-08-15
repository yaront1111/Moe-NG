import { describe, expect, it } from "vitest";

import { SpawnInvocationRefusal, agentSpawnInvocation } from "./agent-spawn-invocation.js";

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

  it("preserves an intentionally empty Windows argument", () => {
    const invocation = agentSpawnInvocation(
      "claude",
      ["--tools", "", "--strict-mcp-config"],
      "win32",
    );
    expect(invocation.file).toBe('claude --tools "" --strict-mcp-config');
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

  it("refuses with a stable code and names the layer that refused, as properties", () => {
    // A regex over an Error message proves nothing about WHICH layer answered
    // and passes silently if the message is reworded; the code and the layer
    // are read off the thrown value instead.
    let thrown: unknown;
    try {
      agentSpawnInvocation("claude", ['a"b'], "win32");
    } catch (error) {
      thrown = error;
    }
    // Without this the guard could have not fired at all and every property
    // assertion below would be checking `undefined?.code` against nothing.
    expect(thrown).toBeInstanceOf(SpawnInvocationRefusal);
    const refusal = thrown as SpawnInvocationRefusal;
    expect(refusal.code).toBe("SPAWN_ARGUMENT_UNQUOTABLE");
    expect(refusal.layer).toBe("agent-spawn-invocation");
    // The refusal does not echo its input: the argument it guards is the
    // per-agent MCP config path.
    expect(refusal.message).toBe("SPAWN_ARGUMENT_UNQUOTABLE");
    expect(refusal.message).not.toContain('a"b');
  });
});

import { describe, expect, it } from "vitest";

import {
  KNOWN_COMMANDS,
  MOE_CLI_TOO_MANY_ARGUMENTS,
  MOE_CLI_UNKNOWN_COMMAND,
  MOE_CLI_UNKNOWN_OPTION,
  parseCliArgv,
} from "./moe-cli-argv.js";
import type { CliInvocation } from "./moe-cli-argv.js";

function accepted(argv: readonly string[]): Extract<CliInvocation, { ok: true }> {
  const parsed = parseCliArgv(argv);
  if (!parsed.ok) throw new Error(`expected an invocation, got ${parsed.code}`);
  return parsed;
}

function refused(argv: readonly string[]): Extract<CliInvocation, { ok: false }> {
  const parsed = parseCliArgv(argv);
  if (parsed.ok) throw new Error(`expected a refusal, got ${parsed.command}`);
  return parsed;
}

describe("parseCliArgv accepts the shipped roster", () => {
  it("defaults an argument-free init to the current directory", () => {
    const parsed = accepted(["init"]);
    expect(parsed).toEqual({ command: "init", force: false, ok: true, targetDir: "." });
  });

  it("takes the init target from the first positional argument", () => {
    expect(accepted(["init", "demo"])).toEqual({
      command: "init", force: false, ok: true, targetDir: "demo",
    });
  });

  it("keeps a target that contains spaces as one argument", () => {
    expect(accepted(["init", "C:/Program Files/Moe Demo"])).toEqual({
      command: "init", force: false, ok: true, targetDir: "C:/Program Files/Moe Demo",
    });
  });

  it("reads --force wherever it appears among the init arguments", () => {
    expect(accepted(["init", "--force", "demo"])).toEqual({
      command: "init", force: true, ok: true, targetDir: "demo",
    });
  });

  it("defaults an argument-free start to the current directory", () => {
    expect(accepted(["start"])).toEqual({ command: "start", ok: true, targetDir: "." });
  });

  it("takes the start target from the first positional argument", () => {
    expect(accepted(["start", "demo"])).toEqual({
      command: "start", ok: true, targetDir: "demo",
    });
  });

  it("admits an explicit non-secret operator stdin pipe for start", () => {
    expect(accepted(["start", "demo", "--operator-stdin"])).toEqual({
      command: "start", ok: true, operatorStdin: true, targetDir: "demo",
    });
  });

  it("defaults an argument-free mcp to the current directory", () => {
    expect(accepted(["mcp"])).toEqual({ command: "mcp", ok: true, targetDir: "." });
  });

  it("takes the mcp target from the first positional argument", () => {
    expect(accepted(["mcp", "D:/projexts/UnAI"])).toEqual({
      command: "mcp", ok: true, targetDir: "D:/projexts/UnAI",
    });
  });

  it("accepts the project manager as an argument-free command", () => {
    expect(accepted(["projects"])).toEqual({ command: "projects", ok: true });
  });

  it("admits an explicit non-secret operator stdin pipe for the manager", () => {
    expect(accepted(["projects", "--operator-stdin"])).toEqual({
      command: "projects", ok: true, operatorStdin: true,
    });
  });

  it("answers --version and the bare version word alike", () => {
    expect(accepted(["--version"]).command).toBe("version");
    expect(accepted(["-v"]).command).toBe("version");
    expect(accepted(["version"]).command).toBe("version");
  });

  it("answers --help, the bare help word, and an empty argv alike", () => {
    expect(accepted(["--help"]).command).toBe("help");
    expect(accepted(["help"]).command).toBe("help");
    expect(accepted([]).command).toBe("help");
  });
});

describe("parseCliArgv refuses by name", () => {
  it("refuses an unknown subcommand and names it", () => {
    const parsed = refused(["frobnicate"]);
    expect(parsed.code).toBe(MOE_CLI_UNKNOWN_COMMAND);
    expect(parsed.detail).toBe("frobnicate");
  });

  it("lists every known command in the unknown-subcommand message", () => {
    const parsed = refused(["frobnicate"]);
    for (const command of KNOWN_COMMANDS) expect(parsed.message).toContain(command);
  });

  /**
   * The arm above walks the roster to check the MESSAGE, so adding a name to
   * KNOWN_COMMANDS grows that arm's own iteration and it stays green even when
   * nothing parses the new verb. This is the opposite direction: every command
   * the binary ADVERTISES must actually be SERVED by a parse branch.
   */
  it("parses every command it advertises, not merely names it", () => {
    for (const command of KNOWN_COMMANDS) {
      expect(parseCliArgv([command]).ok, command).toBe(true);
    }
  });

  it("refuses an unknown option and names the option, not the command", () => {
    const parsed = refused(["init", "--forse"]);
    expect(parsed.code).toBe(MOE_CLI_UNKNOWN_OPTION);
    expect(parsed.detail).toBe("--forse");
  });

  it("refuses --force on start, where it means nothing", () => {
    const parsed = refused(["start", "--force"]);
    expect(parsed.code).toBe(MOE_CLI_UNKNOWN_OPTION);
    expect(parsed.detail).toBe("--force");
  });

  it("refuses arguments and options on the project manager command", () => {
    expect(refused(["projects", "demo"]).code).toBe(MOE_CLI_TOO_MANY_ARGUMENTS);
    expect(refused(["projects", "--port=7"]).code).toBe(MOE_CLI_UNKNOWN_OPTION);
  });

  it("refuses a second positional argument on mcp and names the extra token", () => {
    const parsed = refused(["mcp", "a", "b"]);
    expect(parsed.code).toBe(MOE_CLI_TOO_MANY_ARGUMENTS);
    expect(parsed.detail).toBe("b");
  });

  /** Pairing is a browser concept; it means nothing on a JSON-RPC stdio wire. */
  it("refuses --operator-stdin on mcp, which accepts no options at all", () => {
    const parsed = refused(["mcp", "--operator-stdin"]);
    expect(parsed.code).toBe(MOE_CLI_UNKNOWN_OPTION);
    expect(parsed.detail).toBe("--operator-stdin");
    expect(parsed.message).toContain("options for this command: none");
  });

  it("refuses a second positional argument rather than silently ignoring it", () => {
    const parsed = refused(["init", "demo", "extra"]);
    expect(parsed.code).toBe(MOE_CLI_TOO_MANY_ARGUMENTS);
    expect(parsed.detail).toBe("extra");
  });
});

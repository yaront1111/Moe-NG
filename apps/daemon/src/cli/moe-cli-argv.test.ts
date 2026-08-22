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

  it("refuses a second positional argument rather than silently ignoring it", () => {
    const parsed = refused(["init", "demo", "extra"]);
    expect(parsed.code).toBe(MOE_CLI_TOO_MANY_ARGUMENTS);
    expect(parsed.detail).toBe("extra");
  });
});

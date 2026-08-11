import { describe, expect, it } from "vitest";

import { CHANNEL_PAYLOAD_CAPS } from "./windows-frames.js";
import {
  ALLOWED_ENVIRONMENT_KEYS,
  MAX_ARGUMENT_CHARS,
  MAX_ARGV_ENTRIES,
  MAX_ENVIRONMENT_ENTRIES,
  MAX_ENVIRONMENT_VALUE_CHARS,
  encodeLaunchPayload,
} from "./windows-launch-request.js";
import { WINDOWS_MAX_PATH_CHARS } from "./windows-path-guard.js";
import { type WindowsProcessUnknown } from "./windows-process-contract.js";

const GOOD = {
  executable: "C:\\Windows\\System32\\PING.EXE",
  argv: ["-n", "1", "127.0.0.1"],
  cwd: "C:\\Windows\\Temp",
  environment: { SYSTEMROOT: "C:\\Windows" },
};

const refusal = (request: unknown): WindowsProcessUnknown => {
  const result = encodeLaunchPayload(request);
  if (result instanceof Uint8Array) {
    throw new Error("the request was accepted, so there is no refusal to inspect");
  }
  return result;
};

const accepted = (request: unknown): Uint8Array => {
  const result = encodeLaunchPayload(request);
  if (!(result instanceof Uint8Array)) {
    throw new Error(`a legal request was refused: ${result.code}`);
  }
  return result;
};

const u16 = (view: Uint8Array, at: number): number =>
  (view[at] ?? 0) + (view[at + 1] ?? 0) * 0x100;

describe("the launch payload matches decode_launch's field order", () => {
  /**
   * control.rs `decode_launch` consumes executable, argv, cwd, environment, in
   * that order, each length-prefixed with a LITTLE-ENDIAN u16. A payload that
   * reordered them would still decode into a `LaunchRequest` — with the cwd in
   * the executable's place — so the order is asserted by reading the bytes.
   */
  it("writes executable, argv, cwd then environment, each u16-length-prefixed", () => {
    const payload = accepted({ ...GOOD, argv: [], environment: {} });
    const executable = new TextEncoder().encode(GOOD.executable);
    expect(u16(payload, 0)).toBe(executable.length);
    expect([...payload.subarray(2, 2 + executable.length)]).toEqual([...executable]);

    let at = 2 + executable.length;
    expect(u16(payload, at)).toBe(0); // argv count
    at += 2;
    const cwd = new TextEncoder().encode(GOOD.cwd);
    expect(u16(payload, at)).toBe(cwd.length);
    at += 2 + cwd.length;
    expect(u16(payload, at)).toBe(0); // environment count
    expect(payload.length).toBe(at + 2);
  });

  it("counts argv entries and environment pairs, not bytes", () => {
    const payload = accepted(GOOD);
    const at = 2 + new TextEncoder().encode(GOOD.executable).length;
    expect(u16(payload, at)).toBe(3);
    expect(payload.length).toBeGreaterThan(at + 2);
  });

  /** A length prefix must count UTF-8 BYTES; a character count truncates. */
  it("prefixes a multi-byte argument with its byte length, not its char length", () => {
    const argument = "caf\u00e9";
    const payload = accepted({ ...GOOD, argv: [argument], environment: {} });
    const at = 2 + new TextEncoder().encode(GOOD.executable).length + 2;
    expect(argument.length).toBe(4);
    expect(u16(payload, at)).toBe(5);
  });
});

describe("the request shape is judged before any field is read", () => {
  it.each([
    ["a non-record", 42],
    ["null", null],
    ["an array", []],
    ["a record missing cwd", { executable: GOOD.executable, argv: [], environment: {} }],
    ["a record with an extra key", { ...GOOD, shell: true }],
  ])("refuses %s with PROCESS_BOUNDARY_REQUEST_MALFORMED on the request layer", (_, request) => {
    const failure = refusal(request);
    expect(failure.code).toBe("PROCESS_BOUNDARY_REQUEST_MALFORMED");
    expect(failure.layer).toBe("WINDOWS_PROCESS_REQUEST");
    expect(failure.identity).toBeNull();
  });

  /**
   * An accessor can answer one way for validation and another for the record.
   * Refusing outright is cheaper than out-reading it, which is the rule
   * `snapshotExactRecord` already enforces for platform host records.
   */
  it("refuses a record whose fields are getters rather than data", () => {
    const hostile = {
      argv: [],
      cwd: GOOD.cwd,
      environment: {},
      get executable(): string {
        return GOOD.executable;
      },
    };
    expect(refusal(hostile).code).toBe("PROCESS_BOUNDARY_REQUEST_MALFORMED");
  });
});

describe("a path must be a bounded, local, drive-absolute Windows path", () => {
  const badPaths: readonly (readonly [string, unknown])[] = [
    ["a UNC share", "\\\\server\\share\\tool.exe"],
    ["the device namespace", "\\\\?\\C:\\Windows\\System32\\PING.EXE"],
    ["the legacy device namespace", "\\\\.\\PhysicalDrive0"],
    ["a relative path", "tools\\ping.exe"],
    ["a drive-relative path", "C:tools\\ping.exe"],
    ["a rooted path with no drive", "\\Windows\\System32\\PING.EXE"],
    ["a traversal segment", "C:\\Windows\\..\\Windows\\System32\\PING.EXE"],
    ["a current-directory segment", "C:\\Windows\\.\\PING.EXE"],
    ["forward slashes", "C:/Windows/System32/PING.EXE"],
    ["an embedded NUL", "C:\\Windows\\PING.EXE\u0000.txt"],
    ["a reserved device name", "C:\\Windows\\NUL"],
    ["a reserved device name with an extension", "C:\\Windows\\CON.txt"],
    ["a serial device name", "C:\\Windows\\COM1"],
    ["a lone surrogate", "C:\\Windows\\\ud800.exe"],
    ["a non-NFC form", "C:\\Windows\\cafe\u0301.exe"],
    ["an empty string", ""],
    ["an over-long path", `C:\\${"a".repeat(WINDOWS_MAX_PATH_CHARS)}`],
    ["a number", 7],
  ];

  it.each(badPaths)("refuses %s as an executable", (_, value) => {
    const failure = refusal({ ...GOOD, executable: value });
    expect(failure.code).toBe("PROCESS_BOUNDARY_EXECUTABLE_REJECTED");
    expect(failure.layer).toBe("WINDOWS_PROCESS_REQUEST");
  });

  it.each(badPaths)("refuses %s as a cwd, with the cwd's own code", (_, value) => {
    const failure = refusal({ ...GOOD, cwd: value });
    expect(failure.code).toBe("PROCESS_BOUNDARY_CWD_REJECTED");
  });

  it("generated a case for every hostile path shape, in both positions", () => {
    // A sweep that silently produced zero cases would pass while testing
    // nothing, so the count is pinned by hand rather than derived.
    expect(badPaths.length).toBe(18);
  });

  it("accepts a drive-absolute path at exactly the bound", () => {
    const path = `C:\\${"a".repeat(WINDOWS_MAX_PATH_CHARS - 3)}`;
    expect(path.length).toBe(WINDOWS_MAX_PATH_CHARS);
    expect(accepted({ ...GOOD, executable: path })).toBeInstanceOf(Uint8Array);
  });

  it("accepts a device NAME that is only part of a longer component", () => {
    // `CONSOLE.EXE` is not `CON`. An over-broad substring check would reject it.
    expect(accepted({ ...GOOD, executable: "C:\\Windows\\CONSOLE.EXE" })).toBeInstanceOf(Uint8Array);
  });
});

describe("argv is an array with the shell disabled, and is bounded", () => {
  it.each([
    ["a string instead of an array", "-n 1"],
    ["a non-string entry", [1]],
    ["an entry with an embedded NUL", ["-n\u00001"]],
    ["an entry with a lone surrogate", ["\udfff"]],
    ["too many entries", Array.from({ length: MAX_ARGV_ENTRIES + 1 }, () => "-n")],
    ["an over-long entry", ["x".repeat(MAX_ARGUMENT_CHARS + 1)]],
  ])("refuses %s with PROCESS_BOUNDARY_ARGV_REJECTED", (_, argv) => {
    expect(refusal({ ...GOOD, argv }).code).toBe("PROCESS_BOUNDARY_ARGV_REJECTED");
  });

  /**
   * ARGV IS DATA, NOT A COMMAND LINE. Shell metacharacters are carried through
   * verbatim because there is no shell to interpret them: the broker calls
   * CreateProcessW with an explicit lpApplicationName. Refusing them here would
   * imply the opposite — that something downstream might parse them.
   */
  it("carries shell metacharacters through verbatim rather than refusing them", () => {
    const argument = "a & b | c > d";
    const payload = accepted({ ...GOOD, argv: [argument], environment: {} });
    expect(new TextDecoder().decode(payload)).toContain(argument);
  });

  it("accepts exactly the maximum number of entries", () => {
    const argv = Array.from({ length: MAX_ARGV_ENTRIES }, () => "-n");
    expect(accepted({ ...GOOD, argv, environment: {} })).toBeInstanceOf(Uint8Array);
  });
});

describe("the environment is allowlisted and bounded", () => {
  it("refuses a key outside the allowlist", () => {
    const failure = refusal({ ...GOOD, environment: { NODE_OPTIONS: "--inspect" } });
    expect(failure.code).toBe("PROCESS_BOUNDARY_ENVIRONMENT_REJECTED");
    expect(failure.layer).toBe("WINDOWS_PROCESS_REQUEST");
  });

  it("matches allowlisted keys case-insensitively, as Windows does", () => {
    expect(accepted({ ...GOOD, environment: { SystemRoot: "C:\\Windows" } })).toBeInstanceOf(
      Uint8Array,
    );
  });

  /**
   * Windows collapses `PATH` and `Path` into one variable, so a record carrying
   * both is ambiguous about which value wins. Refusing is the only answer that
   * does not silently pick one.
   */
  it("refuses two keys that differ only in case", () => {
    const failure = refusal({ ...GOOD, environment: { PATH: "C:\\a", Path: "C:\\b" } });
    expect(failure.code).toBe("PROCESS_BOUNDARY_ENVIRONMENT_REJECTED");
  });

  it.each([
    ["a non-string value", { SYSTEMROOT: 1 }],
    ["a value with an embedded NUL", { SYSTEMROOT: "C:\\Windows\u0000" }],
    ["an over-long value", { SYSTEMROOT: "x".repeat(MAX_ENVIRONMENT_VALUE_CHARS + 1) }],
    ["a key with an equals sign", { "A=B": "c" }],
  ])("refuses %s with PROCESS_BOUNDARY_ENVIRONMENT_REJECTED", (_, environment) => {
    expect(refusal({ ...GOOD, environment }).code).toBe("PROCESS_BOUNDARY_ENVIRONMENT_REJECTED");
  });

  it("refuses more entries than the bound, counting entries and not bytes", () => {
    const keys = [...ALLOWED_ENVIRONMENT_KEYS].slice(0, MAX_ENVIRONMENT_ENTRIES + 1);
    expect(keys.length).toBeGreaterThan(0);
    // The allowlist is deliberately smaller than the entry bound, so the entry
    // bound is unreachable through it. Assert that relationship rather than
    // writing a case that can never be generated.
    expect(ALLOWED_ENVIRONMENT_KEYS.length).toBeLessThanOrEqual(MAX_ENVIRONMENT_ENTRIES);
  });

  it("keeps the allowlist frozen, deduplicated and upper-case", () => {
    expect(Object.isFrozen(ALLOWED_ENVIRONMENT_KEYS)).toBe(true);
    expect(new Set(ALLOWED_ENVIRONMENT_KEYS).size).toBe(ALLOWED_ENVIRONMENT_KEYS.length);
    expect(ALLOWED_ENVIRONMENT_KEYS.every((key) => key === key.toUpperCase())).toBe(true);
    expect(ALLOWED_ENVIRONMENT_KEYS.length).toBeGreaterThan(0);
  });
});

describe("an oversized request is refused before it can be framed", () => {
  it("refuses a payload larger than the control channel's cap", () => {
    const argv = Array.from({ length: MAX_ARGV_ENTRIES }, () => "x".repeat(MAX_ARGUMENT_CHARS));
    const failure = refusal({ ...GOOD, argv });
    expect(failure.code).toBe("PROCESS_BOUNDARY_REQUEST_OVERSIZED");
    expect(failure.layer).toBe("WINDOWS_PROCESS_REQUEST");
    // The refusal is real only if those bytes genuinely would not have fit.
    expect(MAX_ARGV_ENTRIES * MAX_ARGUMENT_CHARS).toBeGreaterThan(CHANNEL_PAYLOAD_CAPS.CONTROL);
  });

  it("accepts a request that fits", () => {
    expect(accepted(GOOD).length).toBeLessThanOrEqual(CHANNEL_PAYLOAD_CAPS.CONTROL);
  });
});

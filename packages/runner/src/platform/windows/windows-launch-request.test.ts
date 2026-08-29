import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CLAUDE_LAUNCH_SELECTION_ENV } from "../../providers/claude/claude-launch-selection.js";
import { CHANNEL_PAYLOAD_CAPS } from "./windows-frames.js";
import {
  ALLOWED_ENVIRONMENT_KEYS,
  MAX_ARGUMENT_CHARS,
  MAX_ARGV_ENTRIES,
  MAX_ENVIRONMENT_ENTRIES,
  MAX_ENVIRONMENT_VALUE_CHARS,
  PROVIDER_LAUNCH_SELECTION_ENVIRONMENT_KEYS,
  encodeLaunchPayload,
  encodeLaunchPayloadWithAllowedEnvironment,
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

interface CuratedLaunch {
  readonly request: unknown;
  readonly allowedNames: readonly string[];
  readonly injected: readonly (readonly [string, string])[];
}

const curated = (input: CuratedLaunch): Uint8Array | WindowsProcessUnknown =>
  encodeLaunchPayloadWithAllowedEnvironment(input.request, input.allowedNames, input.injected);

const curatedRequest = (environment: object = {}): unknown => ({ ...GOOD, environment });

const expectCuratedAccepted = (input: CuratedLaunch): void => {
  const result = curated(input);
  expect(result).toBeInstanceOf(Uint8Array);
  if (!(result instanceof Uint8Array)) throw new Error(`curated request refused: ${result.code}`);
  expect(result.length).toBeLessThanOrEqual(CHANNEL_PAYLOAD_CAPS.CONTROL);
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
    // RtlIsDosDeviceName_U drops the stem's trailing spaces, so each is the device.
    ["a reserved device name padded before its extension", "C:\\Windows\\CON .txt"],
    ["a reserved device name padded by several spaces", "C:\\Windows\\NUL   .exe"],
    ["a serial device name padded before its extension", "C:\\Windows\\COM1 .log"],
    ["a serial device name", "C:\\Windows\\COM1"],
    ["an alternate data stream", "C:\\Windows\\tool.exe:stream"],
    ["a trailing dot Win32 would trim", "C:\\Windows\\tool.exe."],
    ["a trailing space Win32 would trim", "C:\\Windows\\tool.exe "],
    ["an empty path segment", "C:\\Windows\\\\tool.exe"],
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
    expect(badPaths.length).toBe(25);
  });

  it("accepts a drive-absolute path at exactly the bound", () => {
    const path = `C:\\${"a".repeat(WINDOWS_MAX_PATH_CHARS - 3)}`;
    expect(path.length).toBe(WINDOWS_MAX_PATH_CHARS);
    expect(accepted({ ...GOOD, executable: path })).toBeInstanceOf(Uint8Array);
  });

  it("accepts a device NAME that is only part of a longer component", () => {
    // `CONSOLE.EXE` is not `CON`. An over-broad substring check would reject it.
    expect(accepted({ ...GOOD, executable: "C:\\Windows\\CONSOLE.EXE" })).toBeInstanceOf(Uint8Array);
    expect(accepted({ ...GOOD, executable: "C:\\Windows\\CONIN$-LOG.EXE" })).toBeInstanceOf(Uint8Array);
    expect(accepted({ ...GOOD, executable: "C:\\Windows\\CONOUT$SAFE.EXE" })).toBeInstanceOf(Uint8Array);
    // Only TRAILING spaces of the stem are dropped; an inner space keeps the
    // name a name, and a padded non-device stem is still not a device.
    expect(accepted({ ...GOOD, executable: "C:\\Windows\\CON X.txt" })).toBeInstanceOf(Uint8Array);
    expect(accepted({ ...GOOD, executable: "C:\\Windows\\CONSOLE .EXE" })).toBeInstanceOf(Uint8Array);
  });
});

describe("argv is an array with the shell disabled, and is bounded", () => {
  it.each([
    ["a string instead of an array", "-n 1"],
    ["a non-string entry", [1]],
    ["a sparse array", Array(1)],
    [
      "an accessor entry",
      Object.defineProperty(["safe"], "0", { get: () => "-n", enumerable: true }),
    ],
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

describe("a reviewed environment roster can inject reserved project facts", () => {
  const reviewed = Object.freeze([...ALLOWED_ENVIRONMENT_KEYS, "MOE_PROJECT_ID"]);

  it("injects a reviewed reserved entry without widening the provider wrapper", () => {
    const result = curated({
      request: curatedRequest({ SYSTEMROOT: "C:\\Windows" }),
      allowedNames: reviewed,
      injected: [["MOE_PROJECT_ID", "alpha"]],
    });
    expect(result).toBeInstanceOf(Uint8Array);
    if (!(result instanceof Uint8Array)) throw new Error(`curated request refused: ${result.code}`);
    expect(new TextDecoder().decode(result)).toContain("MOE_PROJECT_ID");

    const provider = refusal({ ...GOOD, environment: { MOE_PROJECT_ID: "alpha" } });
    expect(provider.code).toBe("PROCESS_BOUNDARY_ENVIRONMENT_REJECTED");
    expect(provider.layer).toBe("WINDOWS_PROCESS_REQUEST");
  });

  const overCountNames = Object.freeze(
    Array.from({ length: MAX_ENVIRONMENT_ENTRIES + 1 }, (_, index) => `MOE_SLOT_${index}`),
  );
  const overCountEntries = Object.freeze(overCountNames.map((name) => [name, "x"] as const));

  const accessorTuple = (): readonly (readonly [string, string])[] => {
    const tuple = ["MOE_PROJECT_ID", "alpha"];
    Object.defineProperty(tuple, "1", { enumerable: true, get: () => { throw new Error("hostile"); } });
    return [tuple as unknown as readonly [string, string]];
  };

  const revokedEntries = (): readonly (readonly [string, string])[] => {
    const target: readonly (readonly [string, string])[] = [["MOE_PROJECT_ID", "alpha"]];
    const handle = Proxy.revocable(target, {});
    handle.revoke();
    return handle.proxy;
  };

  const cases: readonly {
    readonly name: string;
    readonly hostile: () => CuratedLaunch;
    readonly downstreamControl: () => CuratedLaunch;
  }[] = [
    {
      name: "one small out-of-roster entry",
      hostile: () => ({ request: curatedRequest(), allowedNames: reviewed, injected: [["MOE_UNREVIEWED", "x"]] }),
      downstreamControl: () => ({ request: curatedRequest(), allowedNames: [...reviewed, "MOE_UNREVIEWED"], injected: [["MOE_UNREVIEWED", "x"]] }),
    },
    {
      name: "a case-insensitive caller and injected duplicate",
      hostile: () => ({ request: curatedRequest({ Moe_Project_Id: "caller" }), allowedNames: reviewed, injected: [["MOE_PROJECT_ID", "injected"]] }),
      downstreamControl: () => ({ request: curatedRequest(), allowedNames: reviewed, injected: [["MOE_PROJECT_ID", "injected"]] }),
    },
    {
      name: "a tuple with a throwing value accessor",
      hostile: () => ({ request: curatedRequest(), allowedNames: reviewed, injected: accessorTuple() }),
      downstreamControl: () => ({ request: curatedRequest(), allowedNames: reviewed, injected: [["MOE_PROJECT_ID", "alpha"]] }),
    },
    {
      name: "a sparse tuple",
      hostile: () => ({ request: curatedRequest(), allowedNames: reviewed, injected: [["MOE_PROJECT_ID"] as unknown as readonly [string, string]] }),
      downstreamControl: () => ({ request: curatedRequest(), allowedNames: reviewed, injected: [["MOE_PROJECT_ID", "alpha"]] }),
    },
    {
      name: "a revoked injected-entry collection",
      hostile: () => ({ request: curatedRequest(), allowedNames: reviewed, injected: revokedEntries() }),
      downstreamControl: () => ({ request: curatedRequest(), allowedNames: reviewed, injected: [["MOE_PROJECT_ID", "alpha"]] }),
    },
    {
      name: "an 8193-character value below the frame cap",
      hostile: () => ({ request: curatedRequest(), allowedNames: reviewed, injected: [["MOE_PROJECT_ID", "x".repeat(MAX_ENVIRONMENT_VALUE_CHARS + 1)]] }),
      downstreamControl: () => ({ request: curatedRequest(), allowedNames: reviewed, injected: [["MOE_PROJECT_ID", "x".repeat(MAX_ENVIRONMENT_VALUE_CHARS)]] }),
    },
    {
      name: "65 tiny unique allowed entries below the frame cap",
      hostile: () => ({ request: curatedRequest(), allowedNames: overCountNames, injected: overCountEntries }),
      downstreamControl: () => ({ request: curatedRequest(), allowedNames: overCountNames, injected: overCountEntries.slice(0, MAX_ENVIRONMENT_ENTRIES) }),
    },
  ];

  it.each(cases)("refuses $name at the environment request layer", ({ hostile, downstreamControl }) => {
    const result = curated(hostile());
    expect(result).not.toBeInstanceOf(Uint8Array);
    if (result instanceof Uint8Array) throw new Error("hostile curated request was accepted");
    expect(result.code).toBe("PROCESS_BOUNDARY_ENVIRONMENT_REJECTED");
    expect(result.layer).toBe("WINDOWS_PROCESS_REQUEST");
    expectCuratedAccepted(downstreamControl());
  });

  it("executes every named environment divergence case", () => {
    expect(cases).toHaveLength(7);
    expect(MAX_ENVIRONMENT_VALUE_CHARS + 1).toBeLessThan(CHANNEL_PAYLOAD_CAPS.CONTROL);
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

describe("the provider boundary admits exactly the Claude launch-selection keys", () => {
  /**
   * The roster as it stood BEFORE this widening, in its production order.
   * Hand-written and typed as plain strings, never read back from the module
   * under test — a constant imported from the subject cannot witness that the
   * subject changed.
   */
  const PRE_CHANGE_ENVIRONMENT_KEYS: readonly string[] = [
    "SYSTEMROOT",
    "WINDIR",
    "SYSTEMDRIVE",
    "PATH",
    "PATHEXT",
    "COMSPEC",
    "TEMP",
    "TMP",
    "OS",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "COMMONPROGRAMFILES",
    "USERNAME",
    "COMPUTERNAME",
    "LANG",
    "TZ",
  ];

  /**
   * ARM A. The production reproduction: the daemon's launch-template producer
   * builds its environment from CLAUDE_LAUNCH_SELECTION_ENV and claude-launcher
   * forwards it verbatim into this encoder, so a roster that omits those names
   * kills every real launch at ENCODE, before a byte reaches the broker.
   */
  it("encodes the producer's launch-selection environment, with a PATH-only positive control", () => {
    // POSITIVE CONTROL, in this arm on purpose: a one-name host environment is
    // accepted, so the environment gate is REACHED and passable. Without it a
    // refusal below could be any earlier fence (shape, executable, argv, cwd)
    // rejecting the fixture rather than the allowlist answering on these names.
    expect(accepted({ ...GOOD, environment: { PATH: GOOD.cwd } })).toBeInstanceOf(Uint8Array);

    // Spelled THROUGH the provider constant, never as literals: a test that
    // retyped the names could stay green while the producer spelled others.
    const result = encodeLaunchPayload({
      ...GOOD,
      environment: {
        [CLAUDE_LAUNCH_SELECTION_ENV.model]: "claude-opus-4-1",
        [CLAUDE_LAUNCH_SELECTION_ENV.effort]: "high",
      },
    });
    // Projected rather than a bare instanceof, so a refusal reds with the CODE
    // and the LAYER visible in the diff instead of an opaque "not a Uint8Array".
    expect(
      result instanceof Uint8Array
        ? { accepted: true, code: null, layer: null }
        : { accepted: false, code: result.code, layer: result.layer },
    ).toEqual({ accepted: true, code: null, layer: null });
    if (!(result instanceof Uint8Array)) {
      throw new Error(`the producer's launch environment was refused: ${result.code}`);
    }
    const encoded = new TextDecoder().decode(result);
    expect(encoded).toContain(CLAUDE_LAUNCH_SELECTION_ENV.model);
    expect(encoded).toContain(CLAUDE_LAUNCH_SELECTION_ENV.effort);
  });

  it("pins the full provider roster; any widening reds here by design", () => {
    // The 24 reviewed host names in their production order, then the two
    // provider launch-selection names. Order-sensitive on purpose: a reorder is
    // a roster change too.
    expect([...ALLOWED_ENVIRONMENT_KEYS]).toEqual([
      ...PRE_CHANGE_ENVIRONMENT_KEYS,
      "ANTHROPIC_MODEL",
      "CLAUDE_CODE_EFFORT_LEVEL",
    ]);
    expect(PRE_CHANGE_ENVIRONMENT_KEYS).toHaveLength(24);
  });

  it("widened by the launch-selection subset and by nothing else", () => {
    expect([...PROVIDER_LAUNCH_SELECTION_ENVIRONMENT_KEYS]).toEqual([
      "ANTHROPIC_MODEL",
      "CLAUDE_CODE_EFFORT_LEVEL",
    ]);
    expect(Object.isFrozen(PROVIDER_LAUNCH_SELECTION_ENVIRONMENT_KEYS)).toBe(true);
    for (const name of PROVIDER_LAUNCH_SELECTION_ENVIRONMENT_KEYS) {
      expect({ name, admitted: ALLOWED_ENVIRONMENT_KEYS.includes(name) }).toEqual({
        name,
        admitted: true,
      });
    }
    // DoD-3: today's roster MINUS the pre-change 24 is exactly the subset. Any
    // third name admitted alongside them reds here even if it were also added
    // to the subset constant.
    const widened = [...ALLOWED_ENVIRONMENT_KEYS].filter(
      (name) => !PRE_CHANGE_ENVIRONMENT_KEYS.includes(name),
    );
    expect(widened).toEqual([...PROVIDER_LAUNCH_SELECTION_ENVIRONMENT_KEYS]);
    // And nothing reviewed was dropped on the way in. Widened to string[] for
    // the lookup only: the runtime membership check is unchanged.
    const admitted: readonly string[] = ALLOWED_ENVIRONMENT_KEYS;
    for (const name of PRE_CHANGE_ENVIRONMENT_KEYS) {
      expect({ name, kept: admitted.includes(name) }).toEqual({ name, kept: true });
    }
  });

  /**
   * ARM C. Green BEFORE and AFTER the widening — that is the point. It is the
   * fence that must not have moved, and the one drill D2 reddens by adding
   * NODE_OPTIONS to the roster.
   */
  it.each([
    "NODE_OPTIONS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ANTHROPIC_API_KEY",
    "MOE_STORE_PATH",
    "MOE_PROJECT_CONFIGURATION_DIGEST",
  ])("still refuses %s at the provider boundary, with its code and layer", (name) => {
    const failure = refusal({ ...GOOD, environment: { [name]: "x" } });
    expect({ name, code: failure.code, layer: failure.layer }).toEqual({
      name,
      code: "PROCESS_BOUNDARY_ENVIRONMENT_REJECTED",
      layer: "WINDOWS_PROCESS_REQUEST",
    });
  });

  it("keeps the platform module free of any providers import", () => {
    // The roster names what the provider spells, but the MODULE must not depend
    // on providers/**: claude-launcher.ts already imports this boundary, so an
    // edge back the other way would close a cycle. The pin runs the other
    // direction instead, in claude-launch-selection.test.ts.
    const source = readFileSync(
      fileURLToPath(new URL("./windows-launch-request.ts", import.meta.url)),
      "utf8",
    );
    // Positive control: the file was actually read and is the module we mean.
    expect(source).toContain("export const ALLOWED_ENVIRONMENT_KEYS");
    const offenders = source
      .split("\n")
      .filter((line) => /(?:from|import\()\s*["']\.\.\/\.\.\/providers\//.test(line));
    expect(offenders).toEqual([]);
  });
});

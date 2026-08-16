import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as nativeJoin, win32 } from "node:path";

import { afterAll, expect, it } from "vitest";

import {
  MAX_RUNTIME_CLOSURE_ENTRIES,
  type RuntimeClosureEntry,
  type RuntimeClosureKind,
} from "./claude-observation.js";
import * as runtimePinClosure from "./claude-runtime-pin-closure.js";
import {
  resolveSources,
  type ClaudeRuntimePinErrorCode,
  type ClaudeRuntimePinFailure,
  type SourceEntry,
} from "./claude-runtime-pin-closure.js";
import {
  RUNTIME_PIN_CHUNK_BYTES,
  type ClaudeRuntimeFsPort,
  type RuntimeEntryKind,
} from "./claude-runtime-pin-fs.js";
import {
  EMULATED_WIN32_RUNTIME_ROOT,
  createEmulatedWin32RuntimeFs,
  nativeRuntimePath,
} from "./claude-runtime-pin-test-fixtures.js";

/**
 * Shared source discovery for the Claude runtime pin: the primitive that turns
 * caller-named candidates into validated, streamed, content-addressed entries.
 *
 * The consuming task is task-32eddfd3c9644558b7218778e1f07e92. Nothing here
 * spawns, observes a version, classifies an installed closure, or grants launch
 * authority; this suite exists to prove the ORDER of validation against reads.
 */
type SourceOutcome = readonly SourceEntry[] | ClaudeRuntimePinFailure;

type DiscoverSources = (
  fs: ClaudeRuntimeFsPort,
  candidates: unknown,
  realRoot: string,
) => Promise<SourceOutcome>;

/**
 * Resolved through the module NAMESPACE rather than a named import on purpose.
 * A missing named import makes the whole file fail to load, which reports zero
 * executed tests — indistinguishable from a suite that tested nothing. Going
 * through the namespace makes every case below execute and fail on its own
 * assertion while the production export is absent, and keeps reddening every
 * case (instead of vanishing) if the export is ever deleted.
 */
function discoverSources(): DiscoverSources {
  const exported = (runtimePinClosure as unknown as Record<string, unknown>)["discoverSources"];
  expect(typeof exported, "production discoverSources export is absent").toBe("function");
  return exported as DiscoverSources;
}

const BIG_EXECUTABLE_SHA256 = "b80935d45c7fcb544ad1b841005e50e452239aef65d3e0b6c07976a50f356c69";
const LAUNCHER_SHA256 = "6ad39cb8f3822616a45fd6753e8f061ec67e1c0fca73b310da4067199c5839a4";
const PACKAGE_SHA256 = "73be916e1f9b343086008b85deaf2934f4c4f76a5cb4ad212b965ac03bd37ab5";

/** Larger than one chunk, so a materialising read is visibly different. */
const BIG_EXECUTABLE_BYTES = 70000;

const EXECUTABLE_PATH = win32.join(EMULATED_WIN32_RUNTIME_ROOT, "claude.exe");
const LAUNCHER_PATH = win32.join(EMULATED_WIN32_RUNTIME_ROOT, "launcher.cmd");
const RUNTIME_LIB_PATH = win32.join(EMULATED_WIN32_RUNTIME_ROOT, "lib");
const PACKAGE_PATH = win32.join(RUNTIME_LIB_PATH, "runtime.pack");

const TEMP_ROOTS: string[] = [];

afterAll(() => {
  for (const root of TEMP_ROOTS) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Fixture {
  readonly nativeRoot: string;
  readonly native: (runtimePath: string) => string;
}

function makeFixture(): Fixture {
  const nativeRoot = realpathSync(mkdtempSync(nativeJoin(tmpdir(), "moe-source-")));
  TEMP_ROOTS.push(nativeRoot);
  mkdirSync(nativeJoin(nativeRoot, "lib"));
  writeFileSync(nativeJoin(nativeRoot, "claude.exe"), Buffer.alloc(BIG_EXECUTABLE_BYTES, 0x41));
  writeFileSync(nativeJoin(nativeRoot, "launcher.cmd"), "moe-runtime-launcher\n");
  writeFileSync(nativeJoin(nativeRoot, "lib", "runtime.pack"), "moe-runtime-package\n");
  return {
    nativeRoot,
    native: (runtimePath: string): string => nativeRuntimePath(nativeRoot, runtimePath),
  };
}

interface ProbeOptions {
  readonly entryKind?: (
    path: string,
    inner: () => Promise<RuntimeEntryKind>,
  ) => Promise<RuntimeEntryKind>;
  readonly realpath?: (
    path: string,
    callIndex: number,
    inner: () => Promise<string>,
  ) => Promise<string>;
  readonly readChunks?: (path: string, inner: AsyncIterable<Uint8Array>) => AsyncIterable<Uint8Array>;
}

interface Probe {
  readonly port: ClaudeRuntimeFsPort;
  /** Ordered operation trace; the parity case compares two of these. */
  readonly trace: string[];
  readonly chunkSizes: number[];
  readChunkCalls: () => number;
}

function instrument(fixture: Fixture, options: ProbeOptions = {}): Probe {
  const base = createEmulatedWin32RuntimeFs(fixture.nativeRoot);
  const trace: string[] = [];
  const chunkSizes: number[] = [];
  const realpathCalls = new Map<string, number>();
  const probe: Probe = {
    trace,
    chunkSizes,
    readChunkCalls: (): number => trace.filter((entry) => entry.startsWith("readChunks:")).length,
    port: Object.freeze({
      ...base,
      entryKind: async (path: string): Promise<RuntimeEntryKind> => {
        trace.push(`entryKind:${path}`);
        const inner = async (): Promise<RuntimeEntryKind> => await base.entryKind(path);
        return options.entryKind === undefined
          ? await inner()
          : await options.entryKind(path, inner);
      },
      realpath: async (path: string): Promise<string> => {
        const callIndex = (realpathCalls.get(path) ?? 0) + 1;
        realpathCalls.set(path, callIndex);
        trace.push(`realpath:${path}`);
        const inner = async (): Promise<string> => await base.realpath(path);
        return options.realpath === undefined
          ? await inner()
          : await options.realpath(path, callIndex, inner);
      },
      readChunks: (path: string): AsyncIterable<Uint8Array> => {
        trace.push(`readChunks:${path}`);
        const counted = async function* (
          source: AsyncIterable<Uint8Array>,
        ): AsyncIterable<Uint8Array> {
          for await (const chunk of source) {
            chunkSizes.push(chunk.byteLength);
            yield chunk;
          }
        };
        const inner = base.readChunks(path);
        return counted(options.readChunks === undefined ? inner : options.readChunks(path, inner));
      },
    }) as ClaudeRuntimeFsPort,
  };
  return probe;
}

function candidate(kind: RuntimeClosureKind, path: string): { kind: RuntimeClosureKind; path: string } {
  return { kind, path };
}

/** Feeds the three members SCRAMBLED, so a passing sort assertion is a real one. */
const SCRAMBLED_CANDIDATES = Object.freeze([
  candidate("PACKAGE", PACKAGE_PATH),
  candidate("EXECUTABLE", EXECUTABLE_PATH),
  candidate("LAUNCHER", LAUNCHER_PATH),
]);

function quoted(entries: readonly { kind: RuntimeClosureKind; path: string }[]): RuntimeClosureEntry[] {
  const digests: Record<string, string> = {
    [EXECUTABLE_PATH]: BIG_EXECUTABLE_SHA256,
    [LAUNCHER_PATH]: LAUNCHER_SHA256,
    [PACKAGE_PATH]: PACKAGE_SHA256,
  };
  return entries.map((entry) => ({
    kind: entry.kind,
    path: entry.path,
    sha256: digests[entry.path] ?? BIG_EXECUTABLE_SHA256,
  }));
}

function expectRefusal(outcome: SourceOutcome, code: ClaudeRuntimePinErrorCode): void {
  expect(Array.isArray(outcome), `expected a refusal, received ${JSON.stringify(outcome)}`).toBe(
    false,
  );
  const failure = outcome as ClaudeRuntimePinFailure;
  expect(failure.ok).toBe(false);
  expect(failure.code).toBe(code);
  expect(failure.layer).toBe("RUNTIME");
  expect(failure.truthClass).toBe("UNKNOWN");
}

function expectEntries(outcome: SourceOutcome): readonly SourceEntry[] {
  expect(Array.isArray(outcome), `expected entries, received ${JSON.stringify(outcome)}`).toBe(true);
  return outcome as readonly SourceEntry[];
}

it("streams caller-named candidates into sorted frozen entries with pinned digests", async () => {
  const fixture = makeFixture();
  const probe = instrument(fixture);
  const entries = expectEntries(
    await discoverSources()(probe.port, SCRAMBLED_CANDIDATES, EMULATED_WIN32_RUNTIME_ROOT),
  );

  expect(entries.map((entry) => entry.relativePath)).toEqual([
    "claude.exe",
    "launcher.cmd",
    win32.join("lib", "runtime.pack"),
  ]);
  expect(entries.map((entry) => entry.kind)).toEqual(["EXECUTABLE", "LAUNCHER", "PACKAGE"]);
  expect(entries.map((entry) => entry.sha256)).toEqual([
    BIG_EXECUTABLE_SHA256,
    LAUNCHER_SHA256,
    PACKAGE_SHA256,
  ]);
  expect(entries.map((entry) => entry.canonicalPath)).toEqual([
    EXECUTABLE_PATH,
    LAUNCHER_PATH,
    PACKAGE_PATH,
  ]);
  expect(Object.isFrozen(entries)).toBe(true);
  for (const entry of entries) {
    expect(Object.isFrozen(entry)).toBe(true);
  }
});

it("reads every candidate through bounded chunks and never materialises a file", async () => {
  const fixture = makeFixture();
  const probe = instrument(fixture);
  expectEntries(
    await discoverSources()(probe.port, SCRAMBLED_CANDIDATES, EMULATED_WIN32_RUNTIME_ROOT),
  );

  expect(probe.readChunkCalls()).toBe(3);
  expect(probe.chunkSizes.length).toBeGreaterThan(3);
  expect(Math.max(...probe.chunkSizes)).toBeLessThanOrEqual(RUNTIME_PIN_CHUNK_BYTES);
  // 70000 bytes cannot arrive in one bounded chunk; a materialising read would.
  expect(probe.chunkSizes.filter((size) => size > 0).length).toBeGreaterThanOrEqual(4);
  expect(probe.chunkSizes.reduce((total, size) => total + size, 0)).toBe(
    BIG_EXECUTABLE_BYTES + "moe-runtime-launcher\n".length + "moe-runtime-package\n".length,
  );
});

interface ShapeCase {
  readonly name: string;
  readonly candidates: unknown;
}

const OVER_LIMIT = Object.freeze(
  Array.from({ length: MAX_RUNTIME_CLOSURE_ENTRIES + 1 }, (_unused, index) =>
    candidate("PACKAGE", win32.join(EMULATED_WIN32_RUNTIME_ROOT, "lib", `pack-${index}.bin`)),
  ),
);

const SHAPE_CASES: readonly ShapeCase[] = Object.freeze([
  { name: "a non-array candidate list", candidates: { kind: "EXECUTABLE", path: EXECUTABLE_PATH } },
  { name: "a string candidate list", candidates: EXECUTABLE_PATH },
  { name: "a null candidate list", candidates: null },
  { name: "an empty candidate list", candidates: [] },
  { name: "more candidates than the closure limit", candidates: OVER_LIMIT },
  { name: "a non-record candidate", candidates: [EXECUTABLE_PATH] },
  {
    name: "a candidate carrying an extra key",
    candidates: [{ kind: "EXECUTABLE", path: EXECUTABLE_PATH, sha256: BIG_EXECUTABLE_SHA256 }],
  },
  {
    name: "a candidate whose path is an accessor",
    candidates: [
      Object.defineProperty({ kind: "EXECUTABLE" }, "path", {
        configurable: true,
        enumerable: true,
        get: () => EXECUTABLE_PATH,
      }),
    ],
  },
  {
    name: "a get-trapping proxy candidate",
    candidates: [
      new Proxy(
        { kind: "EXECUTABLE", path: EXECUTABLE_PATH },
        { get: (target, key) => (key === "path" ? LAUNCHER_PATH : Reflect.get(target, key)) },
      ),
    ],
  },
  { name: "an unknown candidate kind", candidates: [{ kind: "PLUGIN", path: EXECUTABLE_PATH }] },
  { name: "a non-string candidate path", candidates: [{ kind: "EXECUTABLE", path: 7 }] },
  { name: "a candidate missing its kind", candidates: [{ path: EXECUTABLE_PATH }] },
]);

it("generated a nonzero candidate-shape matrix", () => {
  expect(SHAPE_CASES.length).toBe(12);
  expect(SHAPE_CASES.length).toBeGreaterThan(0);
  expect(OVER_LIMIT.length).toBe(MAX_RUNTIME_CLOSURE_ENTRIES + 1);
});

it.each(SHAPE_CASES)(
  "refuses $name as CLAUDE_RUNTIME_OBSERVATION_INVALID at RUNTIME before reading",
  async ({ candidates }) => {
    const fixture = makeFixture();
    const probe = instrument(fixture);
    expectRefusal(
      await discoverSources()(probe.port, candidates, EMULATED_WIN32_RUNTIME_ROOT),
      "CLAUDE_RUNTIME_OBSERVATION_INVALID",
    );
    expect(probe.readChunkCalls()).toBe(0);
  },
);

interface PathCase {
  readonly name: string;
  readonly code: ClaudeRuntimePinErrorCode;
  readonly candidates: (fixture: Fixture) => unknown;
  /**
   * Reads that must have happened when the refusal lands. The invariant is
   * PER CANDIDATE — no candidate's bytes are read before THAT candidate is
   * validated — not "no bytes at all". The duplicate row is the one case where
   * they differ: its first path is fully validated and legitimately streamed
   * before the second occurrence is found to repeat it, so demanding 0 there
   * would be demanding the wrong property.
   */
  readonly reads?: number;
}

const PATH_CASES: readonly PathCase[] = Object.freeze([
  {
    name: "a traversal segment",
    code: "CLAUDE_RUNTIME_PATH_INVALID",
    // Built by concatenation: win32.join would normalise the `..` away and the
    // row would silently stop testing traversal at all.
    candidates: () => [candidate("EXECUTABLE", `${EMULATED_WIN32_RUNTIME_ROOT}\\lib\\..\\claude.exe`)],
  },
  {
    name: "a UNC path",
    code: "CLAUDE_RUNTIME_PATH_INVALID",
    candidates: () => [candidate("EXECUTABLE", "\\\\server\\share\\claude.exe")],
  },
  {
    name: "a device path",
    code: "CLAUDE_RUNTIME_PATH_INVALID",
    candidates: () => [candidate("EXECUTABLE", "\\\\?\\C:\\moe-runtime\\claude.exe")],
  },
  {
    name: "a forward-slash path",
    code: "CLAUDE_RUNTIME_PATH_INVALID",
    candidates: () => [candidate("EXECUTABLE", "C:/moe-runtime/claude.exe")],
  },
  {
    name: "a reserved-character segment",
    code: "CLAUDE_RUNTIME_PATH_INVALID",
    candidates: () => [candidate("EXECUTABLE", `${EMULATED_WIN32_RUNTIME_ROOT}\\cla<ude.exe`)],
  },
  {
    name: "a relative path",
    code: "CLAUDE_RUNTIME_PATH_INVALID",
    candidates: () => [candidate("EXECUTABLE", "claude.exe")],
  },
  {
    name: "an empty path",
    code: "CLAUDE_RUNTIME_PATH_INVALID",
    candidates: () => [candidate("EXECUTABLE", "")],
  },
  {
    name: "the same path declared twice in a different case",
    code: "CLAUDE_RUNTIME_PATH_DUPLICATE",
    reads: 1,
    candidates: () => [
      candidate("EXECUTABLE", EXECUTABLE_PATH),
      candidate("LAUNCHER", EXECUTABLE_PATH.toUpperCase()),
    ],
  },
  {
    name: "a path outside the installed root",
    code: "CLAUDE_RUNTIME_PATH_ESCAPE",
    candidates: () => [candidate("EXECUTABLE", "C:\\elsewhere\\claude.exe")],
  },
  {
    name: "an absent path",
    code: "CLAUDE_RUNTIME_PATH_MISSING",
    candidates: () => [
      candidate("EXECUTABLE", win32.join(EMULATED_WIN32_RUNTIME_ROOT, "absent.exe")),
    ],
  },
  {
    name: "a directory in a file position",
    code: "CLAUDE_RUNTIME_PATH_NOT_FILE",
    candidates: () => [candidate("PACKAGE", win32.join(EMULATED_WIN32_RUNTIME_ROOT, "lib"))],
  },
  {
    name: "an entry reached through a junction above the leaf",
    code: "CLAUDE_RUNTIME_PATH_REPARSE",
    candidates: (fixture) => {
      const link = win32.join(EMULATED_WIN32_RUNTIME_ROOT, "link");
      symlinkSync(fixture.native(win32.join(EMULATED_WIN32_RUNTIME_ROOT, "lib")), fixture.native(link), "junction");
      return [candidate("PACKAGE", win32.join(link, "runtime.pack"))];
    },
  },
]);

it("generated a nonzero path matrix covering every path refusal code", () => {
  expect(PATH_CASES.length).toBe(12);
  expect(PATH_CASES.length).toBeGreaterThan(0);
  expect(new Set(PATH_CASES.map((row) => row.code))).toEqual(
    new Set([
      "CLAUDE_RUNTIME_PATH_INVALID",
      "CLAUDE_RUNTIME_PATH_DUPLICATE",
      "CLAUDE_RUNTIME_PATH_ESCAPE",
      "CLAUDE_RUNTIME_PATH_MISSING",
      "CLAUDE_RUNTIME_PATH_NOT_FILE",
      "CLAUDE_RUNTIME_PATH_REPARSE",
    ]),
  );
});

it.each(PATH_CASES)(
  "refuses $name at RUNTIME with $code having read only validated candidates",
  async ({ code, candidates, reads }) => {
    const fixture = makeFixture();
    const probe = instrument(fixture);
    expectRefusal(
      await discoverSources()(probe.port, candidates(fixture), EMULATED_WIN32_RUNTIME_ROOT),
      code,
    );
    expect(probe.readChunkCalls()).toBe(reads ?? 0);
  },
);

it("never reads the offending path itself, even when an earlier candidate was read", async () => {
  const fixture = makeFixture();
  const probe = instrument(fixture);
  expectRefusal(
    await discoverSources()(
      probe.port,
      [
        candidate("EXECUTABLE", EXECUTABLE_PATH),
        candidate("LAUNCHER", EXECUTABLE_PATH.toUpperCase()),
      ],
      EMULATED_WIN32_RUNTIME_ROOT,
    ),
    "CLAUDE_RUNTIME_PATH_DUPLICATE",
  );
  // The one read is the FIRST, already-fully-validated candidate. The duplicate
  // itself is never opened, in either case spelling.
  expect(probe.trace.filter((entry) => entry.startsWith("readChunks:"))).toEqual([
    `readChunks:${EXECUTABLE_PATH}`,
  ]);
  expect(probe.trace).not.toContain(`readChunks:${EXECUTABLE_PATH.toUpperCase()}`);
});

it("maps a pre-read filesystem failure to CLAUDE_RUNTIME_PATH_MISSING without reading", async () => {
  const fixture = makeFixture();
  const probe = instrument(fixture, {
    entryKind: async (path) => {
      if (path === EXECUTABLE_PATH) throw new Error("host refused to stat");
      throw new Error("unexpected stat");
    },
  });
  expectRefusal(
    await discoverSources()(
      probe.port,
      [candidate("EXECUTABLE", EXECUTABLE_PATH)],
      EMULATED_WIN32_RUNTIME_ROOT,
    ),
    "CLAUDE_RUNTIME_PATH_MISSING",
  );
  expect(probe.readChunkCalls()).toBe(0);
});

it("maps a thrown digest stream to CLAUDE_RUNTIME_SOURCE_DIGEST_MISMATCH", async () => {
  const fixture = makeFixture();
  const probe = instrument(fixture, {
    readChunks: async function* (): AsyncIterable<Uint8Array> {
      yield Uint8Array.from([0x41]);
      throw new Error("host dropped the read mid-stream");
    },
  });
  expectRefusal(
    await discoverSources()(
      probe.port,
      [candidate("EXECUTABLE", EXECUTABLE_PATH)],
      EMULATED_WIN32_RUNTIME_ROOT,
    ),
    "CLAUDE_RUNTIME_SOURCE_DIGEST_MISMATCH",
  );
});

it("refuses a leaf replaced by a junction after the read with CLAUDE_RUNTIME_PIN_SOURCE_DRIFT", async () => {
  const fixture = makeFixture();
  const probe = instrument(fixture, {
    readChunks: async function* (path, inner): AsyncIterable<Uint8Array> {
      for await (const chunk of inner) yield chunk;
      if (path === EXECUTABLE_PATH) {
        const native = fixture.native(EXECUTABLE_PATH);
        rmSync(native);
        // A junction, not a file symlink: Windows refuses file symlinks with
        // EPERM unless the host grants SeCreateSymbolicLinkPrivilege, and that
        // EPERM would surface as a read failure rather than the drift this
        // case exists to pin.
        symlinkSync(fixture.native(RUNTIME_LIB_PATH), native, "junction");
      }
    },
  });
  expectRefusal(
    await discoverSources()(
      probe.port,
      [candidate("EXECUTABLE", EXECUTABLE_PATH)],
      EMULATED_WIN32_RUNTIME_ROOT,
    ),
    "CLAUDE_RUNTIME_PIN_SOURCE_DRIFT",
  );
  expect(probe.readChunkCalls()).toBe(1);
});

it("refuses a leaf deleted after the read with CLAUDE_RUNTIME_PIN_SOURCE_DRIFT", async () => {
  const fixture = makeFixture();
  const probe = instrument(fixture, {
    readChunks: async function* (path, inner): AsyncIterable<Uint8Array> {
      for await (const chunk of inner) yield chunk;
      if (path === EXECUTABLE_PATH) rmSync(fixture.native(EXECUTABLE_PATH));
    },
  });
  expectRefusal(
    await discoverSources()(
      probe.port,
      [candidate("EXECUTABLE", EXECUTABLE_PATH)],
      EMULATED_WIN32_RUNTIME_ROOT,
    ),
    "CLAUDE_RUNTIME_PIN_SOURCE_DRIFT",
  );
});

it("refuses a canonical identity that changes after the read with CLAUDE_RUNTIME_PIN_SOURCE_DRIFT", async () => {
  const fixture = makeFixture();
  const probe = instrument(fixture, {
    // Identity holds while validating, then answers a different real file.
    realpath: async (path, callIndex, inner) =>
      path === EXECUTABLE_PATH && callIndex > 1 ? LAUNCHER_PATH : await inner(),
  });
  expectRefusal(
    await discoverSources()(
      probe.port,
      [candidate("EXECUTABLE", EXECUTABLE_PATH)],
      EMULATED_WIN32_RUNTIME_ROOT,
    ),
    "CLAUDE_RUNTIME_PIN_SOURCE_DRIFT",
  );
  expect(probe.readChunkCalls()).toBe(1);
});

it("refuses a quoted digest that does not match the streamed bytes", async () => {
  const fixture = makeFixture();
  const probe = instrument(fixture);
  const closure = quoted([candidate("EXECUTABLE", EXECUTABLE_PATH)]);
  expectRefusal(
    await resolveSources(
      probe.port,
      [{ ...closure[0], sha256: LAUNCHER_SHA256 } as RuntimeClosureEntry],
      EMULATED_WIN32_RUNTIME_ROOT,
    ),
    "CLAUDE_RUNTIME_SOURCE_DIGEST_MISMATCH",
  );
  // The comparison is the LAST act: the bytes were streamed before it decided.
  expect(probe.readChunkCalls()).toBe(1);
});

it("resolveSources and discoverSources traverse one identical validate/read/revalidate order", async () => {
  const quoteFixture = makeFixture();
  const quoteProbe = instrument(quoteFixture);
  const quoteEntries = expectEntries(
    await resolveSources(quoteProbe.port, quoted(SCRAMBLED_CANDIDATES), EMULATED_WIN32_RUNTIME_ROOT),
  );

  const discoverFixture = makeFixture();
  const discoverProbe = instrument(discoverFixture);
  const discoverEntries = expectEntries(
    await discoverSources()(discoverProbe.port, SCRAMBLED_CANDIDATES, EMULATED_WIN32_RUNTIME_ROOT),
  );

  expect(discoverProbe.trace).toEqual(quoteProbe.trace);
  expect(discoverEntries).toEqual(quoteEntries);
  // A read that is not fenced on BOTH sides is the defect this pins.
  expect(quoteProbe.trace.filter((entry) => entry.startsWith("readChunks:")).length).toBe(3);
  expect(quoteProbe.trace.indexOf(`readChunks:${EXECUTABLE_PATH}`)).toBeGreaterThan(
    quoteProbe.trace.indexOf(`realpath:${EXECUTABLE_PATH}`),
  );
  expect(quoteProbe.trace.lastIndexOf(`realpath:${EXECUTABLE_PATH}`)).toBeGreaterThan(
    quoteProbe.trace.indexOf(`readChunks:${EXECUTABLE_PATH}`),
  );
});

it("pairs each validated path with its OWN declared digest against a shifting array", async () => {
  const fixture = makeFixture();
  const probe = instrument(fixture);
  const honest: RuntimeClosureEntry = {
    kind: "EXECUTABLE",
    path: EXECUTABLE_PATH,
    sha256: BIG_EXECUTABLE_SHA256,
  };
  const swapped: RuntimeClosureEntry = { ...honest, sha256: LAUNCHER_SHA256 };
  // Answers position 0 with a different entry on the SECOND read. Reading the
  // closure twice would validate `honest`'s path and then compare `swapped`'s
  // digest, so this succeeds only if every field was captured in one pass.
  let reads = 0;
  const shifting = new Proxy([honest], {
    get: (target, key, receiver) =>
      key === "0" ? (reads++ === 0 ? honest : swapped) : Reflect.get(target, key, receiver),
  }) as readonly RuntimeClosureEntry[];

  const entries = expectEntries(
    await resolveSources(probe.port, shifting, EMULATED_WIN32_RUNTIME_ROOT),
  );
  expect(entries.map((entry) => entry.sha256)).toEqual([BIG_EXECUTABLE_SHA256]);
  expect(reads).toBeGreaterThan(0);
});

it("refuses the same shape from resolveSources as from discoverSources", async () => {
  const fixture = makeFixture();
  const probe = instrument(fixture);
  expectRefusal(
    await resolveSources(
      probe.port,
      [{ kind: "EXECUTABLE", path: "C:\\elsewhere\\claude.exe", sha256: BIG_EXECUTABLE_SHA256 }],
      EMULATED_WIN32_RUNTIME_ROOT,
    ),
    "CLAUDE_RUNTIME_PATH_ESCAPE",
  );
  expect(probe.readChunkCalls()).toBe(0);
});

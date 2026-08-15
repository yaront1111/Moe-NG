import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  join as nativeJoin,
  relative as nativeRelative,
  sep as nativeSeparator,
  win32,
} from "node:path";

import { afterAll, expect, it } from "vitest";

import { canonicalDigest } from "../../canonical.js";
import {
  buildProviderRuntimeObservation,
  type ObservationClock,
  type PlatformIdentity,
  type ProviderRuntimeObservation,
  type RuntimeClosureEntry,
  type RuntimePinningMethod,
} from "./claude-observation.js";
import {
  CLAUDE_RUNTIME_PIN_ERROR_CODES,
  RUNTIME_PIN_CHUNK_BYTES,
  prepareClaudeRuntimePin,
  type ClaudeRuntimeFacts,
  type ClaudeRuntimeFactsPort,
  type ClaudeRuntimeFsPort,
  type ClaudeRuntimePinErrorCode,
  type ClaudeRuntimePinFailure,
  type ClaudeRuntimePinResult,
  type PreparedClaudeRuntime,
} from "./claude-runtime-pin.js";
import {
  EMULATED_WIN32_RUNTIME_ROOT,
  createEmulatedWin32RuntimeFs,
  nativeRuntimePath,
} from "./claude-runtime-pin-test-fixtures.js";

/**
 * Every refusal code this suite has actually observed. The final assertion
 * compares it to the frozen vocabulary, so adding a code without a test — or
 * deleting the test that reaches one — fails rather than silently shrinking
 * coverage.
 */
const EXERCISED = new Set<ClaudeRuntimePinErrorCode>();

const TEMP_ROOTS: string[] = [];

afterAll(() => {
  for (const root of TEMP_ROOTS) {
    rmSync(root, { recursive: true, force: true });
  }
});

function newTempRoot(): string {
  const root = realpathSync(mkdtempSync(nativeJoin(tmpdir(), "moe-pin-")));
  TEMP_ROOTS.push(root);
  return root;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const PLATFORM: PlatformIdentity = Object.freeze({
  os: "win32",
  arch: "x64",
  osVersion: "10.0.26200",
});

const CAPABILITY_DIGEST = canonicalDigest({ capabilitySchema: "moe-claude-capability-profile/1" });

const BASE_FACTS: ClaudeRuntimeFacts = Object.freeze({
  platformIdentity: PLATFORM,
  reportedVersion: "claude-cli/1.2.3",
  adapterCapabilitySchemaDigest: CAPABILITY_DIGEST,
});

/** Distinct instants prove the comparison ignores freshness and nothing else. */
function steppingClock(): ObservationClock {
  let tick = 0;
  return {
    observedAt: () => {
      tick += 1;
      return `2026-08-09T12:00:${String(tick).padStart(2, "0")}.000Z`;
    },
  };
}

// 4 full chunks plus a partial tail: a whole-file read would be one chunk.
const LARGE_BYTES = RUNTIME_PIN_CHUNK_BYTES * 4 + 17;

interface Fixture {
  readonly nativeRoot: string;
  readonly root: string;
  readonly installedRoot: string;
  readonly pinRoot: string;
  readonly executable: string;
  readonly launcher: string;
  readonly large: string;
  readonly outside: string;
}

function makeFixture(): Fixture {
  const nativeRoot = newTempRoot();
  const root = EMULATED_WIN32_RUNTIME_ROOT;
  const installedRoot = win32.join(root, "Claude");
  const executable = win32.join(installedRoot, "claude.exe");
  const launcher = win32.join(installedRoot, "claude.cmd");
  const large = win32.join(installedRoot, "lib", "runtime.pack");
  const outside = win32.join(root, "outside", "claude.exe");
  mkdirSync(nativeRuntimePath(nativeRoot, win32.join(installedRoot, "lib")), {
    recursive: true,
  });
  mkdirSync(nativeRuntimePath(nativeRoot, win32.join(root, "outside")), { recursive: true });
  writeFileSync(nativeRuntimePath(nativeRoot, executable), "MZ-claude-executable");
  writeFileSync(nativeRuntimePath(nativeRoot, launcher), "@echo off\r\nclaude %*\r\n");
  writeFileSync(nativeRuntimePath(nativeRoot, large), Buffer.alloc(LARGE_BYTES, 7));
  writeFileSync(nativeRuntimePath(nativeRoot, outside), "MZ-not-the-installed-one");
  return {
    nativeRoot,
    root,
    installedRoot,
    pinRoot: win32.join(root, "pins"),
    executable,
    launcher,
    large,
    outside,
  };
}

function fixtureDigest(fixture: Fixture, path: string): string {
  return sha256File(nativeRuntimePath(fixture.nativeRoot, path));
}

function closureOf(fixture: Fixture): readonly RuntimeClosureEntry[] {
  return [
    { kind: "EXECUTABLE", path: fixture.executable, sha256: fixtureDigest(fixture, fixture.executable) },
    { kind: "LAUNCHER", path: fixture.launcher, sha256: fixtureDigest(fixture, fixture.launcher) },
    { kind: "PACKAGE", path: fixture.large, sha256: fixtureDigest(fixture, fixture.large) },
  ];
}

interface QuoteOverrides {
  readonly reportedVersion?: string | null;
  readonly adapterCapabilitySchemaDigest?: string;
  readonly pinningMethod?: RuntimePinningMethod;
  readonly platformIdentity?: PlatformIdentity;
}

function makeQuote(
  closure: readonly RuntimeClosureEntry[],
  overrides: QuoteOverrides = {},
): ProviderRuntimeObservation {
  const built = buildProviderRuntimeObservation({
    resolvedRuntimeClosure: closure,
    // `in`, not `??`: an explicit null reportedVersion is the UNKNOWN case.
    reportedVersion:
      "reportedVersion" in overrides
        ? (overrides.reportedVersion ?? null)
        : BASE_FACTS.reportedVersion,
    adapterCapabilitySchemaDigest:
      overrides.adapterCapabilitySchemaDigest ?? BASE_FACTS.adapterCapabilitySchemaDigest,
    pinningMethod: overrides.pinningMethod ?? "CONTENT_ADDRESSED_COPY",
    platformIdentity: overrides.platformIdentity ?? PLATFORM,
    clock: { observedAt: () => "2026-08-09T11:00:00.000Z" },
  });
  if (!built.ok) {
    throw new Error(`fixture quote refused with ${built.code}`);
  }
  return built.observation;
}

interface ReadRecord {
  readonly path: string;
  readonly sizes: number[];
}

interface FsHooks {
  readonly hostPlatform?: () => string;
  readonly onReadChunk?: (path: string, readOrdinal: number, chunkIndex: number) => void;
  readonly onOpenWrite?: (path: string, ordinal: number) => void;
  readonly removeTree?: (path: string) => Promise<void>;
}

interface Instrumented {
  readonly port: ClaudeRuntimeFsPort;
  readonly ioCalls: string[];
  readonly reads: ReadRecord[];
}

/**
 * Wraps the PRODUCTION adapter rather than reimplementing it: every byte the
 * suite proves was moved by the real filesystem code, and the wrapper exists
 * only to count calls and inject faults at exact ordinals.
 */
function instrument(fixture: Fixture, hooks: FsHooks = {}): Instrumented {
  const base = createEmulatedWin32RuntimeFs(fixture.nativeRoot);
  const ioCalls: string[] = [];
  const reads: ReadRecord[] = [];
  const readOrdinals = new Map<string, number>();
  let writeOrdinal = 0;
  const port: ClaudeRuntimeFsPort = {
    hostPlatform: hooks.hostPlatform ?? ((): string => base.hostPlatform()),
    realpath: async (path) => {
      ioCalls.push(`realpath:${path}`);
      return await base.realpath(path);
    },
    entryKind: async (path) => {
      ioCalls.push(`entryKind:${path}`);
      return await base.entryKind(path);
    },
    readChunks: (path) => {
      ioCalls.push(`readChunks:${path}`);
      const ordinal = (readOrdinals.get(path) ?? 0) + 1;
      readOrdinals.set(path, ordinal);
      const record: ReadRecord = { path, sizes: [] };
      reads.push(record);
      const inner = base.readChunks(path);
      return {
        async *[Symbol.asyncIterator]() {
          let chunkIndex = 0;
          for await (const chunk of inner) {
            record.sizes.push(chunk.byteLength);
            hooks.onReadChunk?.(path, ordinal, chunkIndex);
            chunkIndex += 1;
            yield chunk;
          }
        },
      };
    },
    listFiles: async (path) => {
      ioCalls.push(`listFiles:${path}`);
      return await base.listFiles(path);
    },
    ensureDirectory: async (path) => {
      ioCalls.push(`ensureDirectory:${path}`);
      await base.ensureDirectory(path);
    },
    createDirectoryExclusive: async (path) => {
      ioCalls.push(`createDirectoryExclusive:${path}`);
      await base.createDirectoryExclusive(path);
    },
    openExclusiveWrite: async (path) => {
      writeOrdinal += 1;
      ioCalls.push(`openExclusiveWrite:${path}`);
      hooks.onOpenWrite?.(path, writeOrdinal);
      return await base.openExclusiveWrite(path);
    },
    rename: async (from, to) => {
      ioCalls.push(`rename:${from}`);
      await base.rename(from, to);
    },
    removeTree: async (path) => {
      ioCalls.push(`removeTree:${path}`);
      await (hooks.removeTree ?? base.removeTree)(path);
    },
  };
  return { port, ioCalls, reads };
}

interface FactsProbe {
  readonly port: ClaudeRuntimeFactsPort;
  readonly observations: () => number;
}

function factsPort(sequence: readonly (ClaudeRuntimeFacts | Error)[] = [BASE_FACTS]): FactsProbe {
  let calls = 0;
  return {
    port: {
      observe: async () => {
        const next = sequence[Math.min(calls, sequence.length - 1)] ?? BASE_FACTS;
        calls += 1;
        if (next instanceof Error) {
          throw next;
        }
        return await Promise.resolve(next);
      },
    },
    observations: () => calls,
  };
}

interface RunOverrides {
  readonly quote?: ProviderRuntimeObservation;
  readonly installedRoot?: string;
  readonly pinRoot?: string;
  readonly fs?: ClaudeRuntimeFsPort;
  readonly facts?: ClaudeRuntimeFactsPort;
}

async function run(
  fixture: Fixture,
  overrides: RunOverrides = {},
): Promise<ClaudeRuntimePinResult> {
  return await prepareClaudeRuntimePin({
    // `in`, not `??`: a non-record quote is one of the cases under test.
    quotedObservation: "quote" in overrides ? overrides.quote : makeQuote(closureOf(fixture)),
    installedRoot: overrides.installedRoot ?? fixture.installedRoot,
    pinRoot: overrides.pinRoot ?? fixture.pinRoot,
    fs: overrides.fs ?? instrument(fixture).port,
    facts: overrides.facts ?? factsPort().port,
    clock: steppingClock(),
  });
}

function expectRefusal(result: ClaudeRuntimePinResult, code: ClaudeRuntimePinErrorCode): void {
  const failure = result as ClaudeRuntimePinFailure;
  expect({
    ok: failure.ok,
    code: failure.code,
    layer: failure.layer,
    truthClass: failure.truthClass,
    messageIsText: typeof failure.message === "string" && failure.message.length > 0,
  }).toEqual({ ok: false, code, layer: "RUNTIME", truthClass: "UNKNOWN", messageIsText: true });
  EXERCISED.add(code);
}

function expectPrepared(result: ClaudeRuntimePinResult): PreparedClaudeRuntime {
  if (!result.ok) {
    throw new Error(`expected a prepared runtime, got ${result.code}: ${result.message}`);
  }
  return result;
}

/** The pin root is only created once a closure is proven, so absent means empty. */
function publishedRoots(fixture: Fixture, pinRoot: string): readonly string[] {
  const nativePinRoot = nativeRuntimePath(fixture.nativeRoot, pinRoot);
  return existsSync(nativePinRoot) ? readdirSync(nativePinRoot) : [];
}

function listTree(fixture: Fixture, root: string): readonly (readonly [string, string])[] {
  const nativeRoot = nativeRuntimePath(fixture.nativeRoot, root);
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = nativeJoin(dir, entry);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  return walk(nativeRoot)
    .map((path) => [
      nativeRelative(nativeRoot, path).split(nativeSeparator).join(win32.sep),
      sha256File(path),
    ] as const)
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
}

it("pins the declared closure into one digest-addressed root and binds the result", async () => {
  const fixture = makeFixture();
  const closure = closureOf(fixture);
  const quote = makeQuote(closure);
  const facts = factsPort();
  const prepared = expectPrepared(await run(fixture, { quote, facts: facts.port }));

  expect(prepared.pinnedRoot).toBe(win32.join(fixture.pinRoot, prepared.pinnedClosureDigest));
  expect(prepared.quotedObservationDigest).toBe(quote.observationDigest);
  expect(prepared.executablePath).toBe(win32.join(prepared.pinnedRoot, "claude.exe"));
  expect(listTree(fixture, prepared.pinnedRoot)).toEqual([
    ["claude.cmd", fixtureDigest(fixture, fixture.launcher)],
    ["claude.exe", fixtureDigest(fixture, fixture.executable)],
    [win32.join("lib", "runtime.pack"), fixtureDigest(fixture, fixture.large)],
  ]);

  // The fresh observation is a NEW observation of the pinned bytes, not the quote.
  expect(prepared.observation.observationDigest).toBe(prepared.freshObservationDigest);
  expect(prepared.freshObservationDigest).not.toBe(quote.observationDigest);
  expect(prepared.observation.pinningMethod).toBe("CONTENT_ADDRESSED_COPY");
  expect(prepared.observation.truthClass).toBe("PROVEN");
  expect(prepared.observation.platformIdentity).toEqual(PLATFORM);
  expect(prepared.observation.reportedVersion).toBe(BASE_FACTS.reportedVersion);
  expect(prepared.observation.adapterCapabilitySchemaDigest).toBe(CAPABILITY_DIGEST);
  expect(prepared.observation.resolvedRuntimeClosure.map((entry) => entry.path)).toEqual([
    win32.join(prepared.pinnedRoot, "claude.cmd"),
    win32.join(prepared.pinnedRoot, "claude.exe"),
    win32.join(prepared.pinnedRoot, "lib", "runtime.pack"),
  ]);
  expect(prepared.pinRootIdentity).toBe(
    canonicalDigest({ pinRoot: fixture.pinRoot, root: prepared.pinnedRoot }),
  );
  expect(facts.observations()).toBe(2);

  // Deeply immutable: the launcher must not be able to swap bytes or location.
  expect(Object.isFrozen(prepared)).toBe(true);
  expect(Object.isFrozen(prepared.observation)).toBe(true);
  expect(Object.isFrozen(prepared.observation.resolvedRuntimeClosure)).toBe(true);
  expect(Object.isFrozen(prepared.observation.resolvedRuntimeClosure[0])).toBe(true);
});

it("streams every source and destination in bounded chunks instead of one whole-file read", async () => {
  const fixture = makeFixture();
  const probe = instrument(fixture);
  const prepared = expectPrepared(await run(fixture, { fs: probe.port }));

  const largeReads = probe.reads.filter((read) => read.path === fixture.large);
  // The destination is verified while still staged, so it is read under the pin
  // root but not yet at its published path.
  const destinationReads = probe.reads.filter(
    (read) =>
      read.path !== fixture.large && read.path.endsWith(win32.join("lib", "runtime.pack")),
  );

  // Hash source, copy source, re-hash source after copy: three bounded passes.
  expect(largeReads.length).toBe(3);
  expect(destinationReads.length).toBe(1);
  expect(destinationReads[0]?.path.startsWith(`${fixture.pinRoot}\\`)).toBe(true);
  expect(prepared.pinnedRoot.startsWith(`${fixture.pinRoot}\\`)).toBe(true);
  for (const read of [...largeReads, ...destinationReads]) {
    expect(read.sizes.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...read.sizes)).toBeLessThanOrEqual(RUNTIME_PIN_CHUNK_BYTES);
    expect(read.sizes.reduce((total, size) => total + size, 0)).toBe(LARGE_BYTES);
  }
});

it("rebuilds byte-identically from a shuffled declaration into a separate pin root", async () => {
  const fixture = makeFixture();
  const closure = closureOf(fixture);
  const shuffled = [closure[2], closure[0], closure[1]] as RuntimeClosureEntry[];
  const first = expectPrepared(await run(fixture, { quote: makeQuote(closure) }));
  const second = expectPrepared(
    await run(fixture, {
      quote: makeQuote(shuffled),
      pinRoot: win32.join(fixture.root, "pins-2"),
    }),
  );

  expect(second.pinnedClosureDigest).toBe(first.pinnedClosureDigest);
  expect(listTree(fixture, second.pinnedRoot)).toEqual(listTree(fixture, first.pinnedRoot));
  expect(win32.relative(fixture.pinRoot, first.pinnedRoot)).toBe(
    win32.relative(win32.join(fixture.root, "pins-2"), second.pinnedRoot),
  );
});

it("adopts an already-published root whose bytes match instead of republishing", async () => {
  const fixture = makeFixture();
  const first = expectPrepared(await run(fixture));
  const probe = instrument(fixture);
  const second = expectPrepared(await run(fixture, { fs: probe.port }));

  expect(second.pinnedRoot).toBe(first.pinnedRoot);
  expect(second.pinnedClosureDigest).toBe(first.pinnedClosureDigest);
  expect(probe.ioCalls.some((call) => call.startsWith("openExclusiveWrite:"))).toBe(false);
  expect(listTree(fixture, second.pinnedRoot)).toEqual(listTree(fixture, first.pinnedRoot));
});

it("refuses a published root whose bytes drifted and preserves it untouched", async () => {
  const fixture = makeFixture();
  const first = expectPrepared(await run(fixture));
  const victim = win32.join(first.pinnedRoot, "claude.exe");
  const nativeVictim = nativeRuntimePath(fixture.nativeRoot, victim);
  writeFileSync(nativeVictim, "MZ-substituted-executable");
  const tampered = sha256File(nativeVictim);

  expectRefusal(await run(fixture), "CLAUDE_RUNTIME_PIN_COLLISION");
  expect(sha256File(nativeVictim)).toBe(tampered);
  expect(publishedRoots(fixture, fixture.pinRoot)).toEqual([first.pinnedClosureDigest]);
});

it("refuses a published root carrying a member the closure never declared", async () => {
  const fixture = makeFixture();
  const first = expectPrepared(await run(fixture));
  const smuggled = win32.join(first.pinnedRoot, "lib", "inject.dll");
  const nativeSmuggled = nativeRuntimePath(fixture.nativeRoot, smuggled);
  writeFileSync(nativeSmuggled, "smuggled-side-by-side-load");
  const smuggledDigest = sha256File(nativeSmuggled);

  expectRefusal(await run(fixture), "CLAUDE_RUNTIME_PIN_COLLISION");
  // Refused, not repaired: the tampered root is evidence and stays intact.
  expect(sha256File(nativeSmuggled)).toBe(smuggledDigest);
  expect(publishedRoots(fixture, fixture.pinRoot)).toEqual([first.pinnedClosureDigest]);
});

it("refuses a non-Windows host before touching the filesystem or the observation port", async () => {
  const fixture = makeFixture();
  const probe = instrument(fixture, { hostPlatform: () => "linux" });
  const facts = factsPort();

  expectRefusal(
    await run(fixture, { fs: probe.port, facts: facts.port }),
    "CLAUDE_RUNTIME_PLATFORM_UNSUPPORTED",
  );
  expect(probe.ioCalls).toEqual([]);
  expect(facts.observations()).toBe(0);
});

interface QuoteCase {
  readonly name: string;
  readonly code: ClaudeRuntimePinErrorCode;
  readonly quote: (fixture: Fixture) => ProviderRuntimeObservation;
}

const QUOTE_CASES: readonly QuoteCase[] = [
  {
    name: "an UNKNOWN truth class",
    code: "CLAUDE_RUNTIME_QUOTE_INVALID",
    quote: (fixture) => makeQuote(closureOf(fixture), { reportedVersion: null }),
  },
  {
    name: "an empty closure",
    code: "CLAUDE_RUNTIME_QUOTE_INVALID",
    quote: () => makeQuote([]),
  },
  {
    name: "UNSUPPORTED pinning",
    code: "CLAUDE_RUNTIME_QUOTE_INVALID",
    quote: (fixture) => makeQuote(closureOf(fixture), { pinningMethod: "UNSUPPORTED" }),
  },
  {
    name: "a platform-immutable-handle pinning method",
    code: "CLAUDE_RUNTIME_QUOTE_INVALID",
    quote: (fixture) =>
      makeQuote(closureOf(fixture), { pinningMethod: "PLATFORM_IMMUTABLE_HANDLE" }),
  },
  {
    name: "a substituted observation digest",
    code: "CLAUDE_RUNTIME_QUOTE_INVALID",
    quote: (fixture) => ({ ...makeQuote(closureOf(fixture)), observationDigest: "f".repeat(64) }),
  },
  {
    name: "a closure entry edited after the digest was taken",
    code: "CLAUDE_RUNTIME_QUOTE_INVALID",
    quote: (fixture) => {
      const quote = makeQuote(closureOf(fixture));
      return {
        ...quote,
        resolvedRuntimeClosure: quote.resolvedRuntimeClosure.map((entry, index) =>
          index === 0 ? { ...entry, sha256: "1".repeat(64) } : entry,
        ),
      };
    },
  },
  {
    name: "a foreign observation version",
    code: "CLAUDE_RUNTIME_QUOTE_INVALID",
    quote: (fixture) =>
      ({
        ...makeQuote(closureOf(fixture)),
        observationVersion: "moe-claude-runtime-observation/2",
      }) as unknown as ProviderRuntimeObservation,
  },
  {
    name: "two executables",
    code: "CLAUDE_RUNTIME_QUOTE_INVALID",
    quote: (fixture) =>
      makeQuote(
        closureOf(fixture).map((entry) =>
          entry.kind === "LAUNCHER" ? { ...entry, kind: "EXECUTABLE" } : entry,
        ),
      ),
  },
  {
    name: "no executable at all",
    code: "CLAUDE_RUNTIME_QUOTE_INVALID",
    quote: (fixture) =>
      makeQuote(
        closureOf(fixture).map((entry) =>
          entry.kind === "EXECUTABLE" ? { ...entry, kind: "PACKAGE" } : entry,
        ),
      ),
  },
  {
    name: "a quote that is not a record",
    code: "CLAUDE_RUNTIME_QUOTE_INVALID",
    quote: () => null as unknown as ProviderRuntimeObservation,
  },
];

it("generates a positive number of quote refusal cases", () => {
  expect(QUOTE_CASES.length).toBeGreaterThanOrEqual(10);
  expect(new Set(QUOTE_CASES.map((entry) => entry.name)).size).toBe(QUOTE_CASES.length);
});

it.each(QUOTE_CASES)("refuses $name at RUNTIME with $code", async ({ code, quote }) => {
  const fixture = makeFixture();
  const probe = instrument(fixture);
  expectRefusal(await run(fixture, { quote: quote(fixture), fs: probe.port }), code);
  // A rejected quote never reaches the pin root.
  expect(probe.ioCalls.some((call) => call.startsWith("openExclusiveWrite:"))).toBe(false);
});

interface PathCase {
  readonly name: string;
  readonly code: ClaudeRuntimePinErrorCode;
  readonly closure: (fixture: Fixture) => readonly RuntimeClosureEntry[];
}

const ABSENT_DIGEST = "0".repeat(64);

function withExecutablePath(
  fixture: Fixture,
  path: string,
  sha256: string = ABSENT_DIGEST,
): readonly RuntimeClosureEntry[] {
  return closureOf(fixture).map((entry) =>
    entry.kind === "EXECUTABLE" ? { kind: "EXECUTABLE", path, sha256 } : entry,
  );
}

const PATH_CASES: readonly PathCase[] = [
  {
    name: "a UNC share path",
    code: "CLAUDE_RUNTIME_PATH_INVALID",
    closure: (fixture) => withExecutablePath(fixture, "\\\\server\\share\\claude.exe"),
  },
  {
    name: "an extended-length device prefix",
    code: "CLAUDE_RUNTIME_PATH_INVALID",
    closure: (fixture) => withExecutablePath(fixture, `\\\\?\\${fixture.executable}`),
  },
  {
    name: "a raw device path",
    code: "CLAUDE_RUNTIME_PATH_INVALID",
    closure: (fixture) => withExecutablePath(fixture, "\\\\.\\PhysicalDrive0"),
  },
  {
    name: "a traversal segment",
    code: "CLAUDE_RUNTIME_PATH_INVALID",
    // Built by concatenation: `join` would normalise the segment away and turn
    // this into a different case entirely.
    closure: (fixture) =>
      withExecutablePath(fixture, `${fixture.installedRoot}\\lib\\..\\claude.exe`),
  },
  {
    name: "a relative path",
    code: "CLAUDE_RUNTIME_PATH_INVALID",
    closure: (fixture) => withExecutablePath(fixture, "claude.exe"),
  },
  {
    name: "a forward-slash path",
    code: "CLAUDE_RUNTIME_PATH_INVALID",
    closure: (fixture) => withExecutablePath(fixture, fixture.executable.replace(/\\/gu, "/")),
  },
  {
    name: "a trailing separator",
    code: "CLAUDE_RUNTIME_PATH_INVALID",
    closure: (fixture) => withExecutablePath(fixture, `${fixture.executable}\\`),
  },
  {
    name: "a path outside the installed root",
    code: "CLAUDE_RUNTIME_PATH_ESCAPE",
    closure: (fixture) =>
      withExecutablePath(fixture, fixture.outside, fixtureDigest(fixture, fixture.outside)),
  },
  {
    name: "a declared entry that is not on disk",
    code: "CLAUDE_RUNTIME_PATH_MISSING",
    closure: (fixture) =>
      withExecutablePath(fixture, win32.join(fixture.installedRoot, "absent.exe")),
  },
  {
    name: "a directory declared as a closure member",
    code: "CLAUDE_RUNTIME_PATH_NOT_FILE",
    closure: (fixture) =>
      withExecutablePath(fixture, win32.join(fixture.installedRoot, "lib")),
  },
  {
    name: "the same file declared twice under different casing",
    code: "CLAUDE_RUNTIME_PATH_DUPLICATE",
    closure: (fixture) => [
      ...closureOf(fixture),
      {
        kind: "PACKAGE",
        path: fixture.executable.toUpperCase(),
        sha256: fixtureDigest(fixture, fixture.executable),
      },
    ],
  },
  {
    name: "an entry reached through a junction",
    code: "CLAUDE_RUNTIME_PATH_REPARSE",
    closure: (fixture) => {
      const link = win32.join(fixture.installedRoot, "link");
      symlinkSync(
        nativeRuntimePath(fixture.nativeRoot, win32.join(fixture.installedRoot, "lib")),
        nativeRuntimePath(fixture.nativeRoot, link),
        "junction",
      );
      return withExecutablePath(
        fixture,
        win32.join(link, "runtime.pack"),
        fixtureDigest(fixture, fixture.large),
      );
    },
  },
];

it("generates a positive number of path refusal cases covering every path code", () => {
  expect(PATH_CASES.length).toBeGreaterThanOrEqual(12);
  expect(new Set(PATH_CASES.map((entry) => entry.code))).toEqual(
    new Set([
      "CLAUDE_RUNTIME_PATH_INVALID",
      "CLAUDE_RUNTIME_PATH_ESCAPE",
      "CLAUDE_RUNTIME_PATH_MISSING",
      "CLAUDE_RUNTIME_PATH_NOT_FILE",
      "CLAUDE_RUNTIME_PATH_DUPLICATE",
      "CLAUDE_RUNTIME_PATH_REPARSE",
    ]),
  );
});

it.each(PATH_CASES)("refuses $name at RUNTIME with $code", async ({ code, closure }) => {
  const fixture = makeFixture();
  const probe = instrument(fixture);
  expectRefusal(await run(fixture, { quote: makeQuote(closure(fixture)), fs: probe.port }), code);
  expect(probe.ioCalls.some((call) => call.startsWith("openExclusiveWrite:"))).toBe(false);
});

it("refuses a source whose bytes changed between the quote and the launch", async () => {
  const fixture = makeFixture();
  const quote = makeQuote(closureOf(fixture));
  writeFileSync(
    nativeRuntimePath(fixture.nativeRoot, fixture.executable),
    "MZ-claude-executable-upgraded",
  );

  expectRefusal(await run(fixture, { quote }), "CLAUDE_RUNTIME_SOURCE_DIGEST_MISMATCH");
});

it("refuses when a source is rewritten while its own bytes are being copied", async () => {
  const fixture = makeFixture();
  const probe = instrument(fixture, {
    onReadChunk: (path, readOrdinal, chunkIndex) => {
      // Read 1 hashes the source; read 2 is the copy. Corrupt the tail mid-copy.
      if (path === fixture.large && readOrdinal === 2 && chunkIndex === 0) {
        writeFileSync(
          nativeRuntimePath(fixture.nativeRoot, fixture.large),
          Buffer.alloc(LARGE_BYTES, 9),
        );
      }
    },
  });

  expectRefusal(
    await run(fixture, { fs: probe.port }),
    "CLAUDE_RUNTIME_PIN_DESTINATION_MISMATCH",
  );
  expect(publishedRoots(fixture, fixture.pinRoot)).toEqual([]);
});

it("refuses when an already-copied source drifts before the closure is published", async () => {
  const fixture = makeFixture();
  const probe = instrument(fixture, {
    onOpenWrite: (_path, ordinal) => {
      // claude.cmd sorts first, so by the second destination it is copied AND
      // destination-verified: only the post-copy source re-hash can see this.
      if (ordinal === 2) {
        writeFileSync(
          nativeRuntimePath(fixture.nativeRoot, fixture.launcher),
          "@echo off\r\nsubstituted %*\r\n",
        );
      }
    },
  });

  expectRefusal(await run(fixture, { fs: probe.port }), "CLAUDE_RUNTIME_PIN_SOURCE_DRIFT");
  expect(publishedRoots(fixture, fixture.pinRoot)).toEqual([]);
});

it("refuses and removes the staging tree when a destination cannot be opened", async () => {
  const fixture = makeFixture();
  const probe = instrument(fixture, {
    onOpenWrite: (_path, ordinal) => {
      if (ordinal === 3) {
        throw new Error("injected openExclusiveWrite fault");
      }
    },
  });

  expectRefusal(await run(fixture, { fs: probe.port }), "CLAUDE_RUNTIME_PIN_COPY_FAILED");
  expect(publishedRoots(fixture, fixture.pinRoot)).toEqual([]);
});

it("reports cleanup failure rather than the copy failure it could not undo", async () => {
  const fixture = makeFixture();
  const probe = instrument(fixture, {
    onOpenWrite: (_path, ordinal) => {
      if (ordinal === 3) {
        throw new Error("injected openExclusiveWrite fault");
      }
    },
    removeTree: async () => {
      await Promise.resolve();
      throw new Error("injected removeTree fault");
    },
  });

  expectRefusal(await run(fixture, { fs: probe.port }), "CLAUDE_RUNTIME_PIN_CLEANUP_FAILED");
});

interface ObservationCase {
  readonly name: string;
  readonly code: ClaudeRuntimePinErrorCode;
  readonly facts: readonly (ClaudeRuntimeFacts | Error)[];
}

const OBSERVATION_CASES: readonly ObservationCase[] = [
  {
    name: "a version that no longer matches the quote",
    code: "CLAUDE_RUNTIME_OBSERVATION_CHANGED",
    facts: [{ ...BASE_FACTS, reportedVersion: "claude-cli/9.9.9" }],
  },
  {
    name: "a capability schema that no longer matches the quote",
    code: "CLAUDE_RUNTIME_OBSERVATION_CHANGED",
    facts: [{ ...BASE_FACTS, adapterCapabilitySchemaDigest: "b".repeat(64) }],
  },
  {
    name: "a platform that no longer matches the quote",
    code: "CLAUDE_RUNTIME_OBSERVATION_CHANGED",
    facts: [{ ...BASE_FACTS, platformIdentity: { ...PLATFORM, arch: "arm64" } }],
  },
  {
    name: "a version that changes between the two observations",
    code: "CLAUDE_RUNTIME_OBSERVATION_CHANGED",
    facts: [BASE_FACTS, { ...BASE_FACTS, reportedVersion: "claude-cli/1.2.4" }],
  },
  {
    name: "an observation port that throws",
    code: "CLAUDE_RUNTIME_OBSERVATION_INVALID",
    facts: [new Error("injected observation fault")],
  },
  {
    name: "an unusable capability schema digest",
    code: "CLAUDE_RUNTIME_OBSERVATION_INVALID",
    facts: [{ ...BASE_FACTS, adapterCapabilitySchemaDigest: "not-a-digest" }],
  },
  {
    name: "an unusable platform identity",
    code: "CLAUDE_RUNTIME_OBSERVATION_INVALID",
    facts: [{ ...BASE_FACTS, platformIdentity: { ...PLATFORM, os: "" } }],
  },
];

it("generates a positive number of observation refusal cases covering both codes", () => {
  expect(OBSERVATION_CASES.length).toBeGreaterThanOrEqual(7);
  expect(new Set(OBSERVATION_CASES.map((entry) => entry.code))).toEqual(
    new Set(["CLAUDE_RUNTIME_OBSERVATION_CHANGED", "CLAUDE_RUNTIME_OBSERVATION_INVALID"]),
  );
});

it.each(OBSERVATION_CASES)("refuses $name at RUNTIME with $code", async ({ code, facts }) => {
  const fixture = makeFixture();
  expectRefusal(await run(fixture, { facts: factsPort(facts).port }), code);
  expect(publishedRoots(fixture, fixture.pinRoot)).toEqual([]);
});

it("exercised every code in the frozen runtime-pin vocabulary", () => {
  expect([...EXERCISED].sort()).toEqual([...CLAUDE_RUNTIME_PIN_ERROR_CODES].sort());
});

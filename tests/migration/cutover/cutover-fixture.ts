/**
 * Isolated sandbox for the legacy quiesce drill.
 *
 * SCOPE FENCE. Everything here is synthetic and lives under the OS temp
 * directory. Nothing in this file — or in any module that consumes it — stops,
 * signals, kills or even observes a real daemon, IDE, launcher, watcher,
 * scheduled start, process, socket or handle. The moe daemon serving this board
 * is itself one of the paths DoD 1 names, so a drill that reached for a real
 * path would take the board down mid-flight. The live quiesce remains gated on
 * an explicit human GO_QUIESCE that has not been given.
 *
 * This module deliberately knows nothing about how a manifest is computed or how
 * an inventory is judged. It imports no module under test and restates no
 * cutover rule: a fixture that re-derived the manifest would only let the suite
 * agree with itself.
 */

import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The path kinds DoD 1 enumerates. The drill asserts every one is represented. */
export type AccessPathKind =
  | "daemon"
  | "ide"
  | "launcher"
  | "watcher"
  | "scheduled-start"
  | "process"
  | "handle"
  | "access-path";

export type AccessPathState = "OPEN" | "DENIED";

export interface AccessPathDeclaration {
  readonly id: string;
  readonly kind: AccessPathKind;
  /** false models a path the drill cannot deny; the inventory must refuse by name. */
  readonly deniable: boolean;
  readonly initialState: AccessPathState;
}

/** Mutable simulation of the access surface. No real process is behind any entry. */
export interface CutoverAccessTable {
  readonly declarations: readonly AccessPathDeclaration[];
  stateOf(id: string): AccessPathState | undefined;
  setState(id: string, state: AccessPathState): void;
}

/**
 * `legacy-archive-mount` starts DENIED on purpose. Restoring to "everything
 * open" would be wrong for exactly this entry, which is what makes the abort
 * assertion in the drill non-vacuous.
 */
const DECLARED_PATHS: readonly AccessPathDeclaration[] = Object.freeze([
  { id: "legacy-daemon", kind: "daemon", deniable: true, initialState: "OPEN" },
  { id: "legacy-ide-extension-host", kind: "ide", deniable: true, initialState: "OPEN" },
  { id: "legacy-launcher-shortcut", kind: "launcher", deniable: true, initialState: "OPEN" },
  { id: "legacy-fs-watcher", kind: "watcher", deniable: true, initialState: "OPEN" },
  { id: "legacy-scheduled-start", kind: "scheduled-start", deniable: true, initialState: "OPEN" },
  { id: "legacy-worker-process", kind: "process", deniable: true, initialState: "OPEN" },
  { id: "legacy-cli-process", kind: "process", deniable: true, initialState: "OPEN" },
  { id: "legacy-sqlite-handle", kind: "handle", deniable: true, initialState: "OPEN" },
  { id: "legacy-http-access-path", kind: "access-path", deniable: true, initialState: "OPEN" },
  { id: "legacy-archive-mount", kind: "access-path", deniable: true, initialState: "DENIED" },
]);

const createAccessTable = (declarations: readonly AccessPathDeclaration[]): CutoverAccessTable => {
  const states = new Map<string, AccessPathState>(declarations.map((d) => [d.id, d.initialState]));
  return {
    declarations,
    stateOf: (id) => states.get(id),
    setState: (id, state) => {
      if (!states.has(id)) {
        throw new Error(`cutover fixture: unknown access path id ${id}`);
      }
      states.set(id, state);
    },
  };
};

/** A table carrying one path that cannot be denied, for the refusal case only. */
export const createUndeniableAccessTable = (): CutoverAccessTable =>
  createAccessTable(
    Object.freeze([
      ...DECLARED_PATHS,
      { id: "legacy-firmware-timer", kind: "scheduled-start", deniable: false, initialState: "OPEN" },
    ] as const),
  );

/** An empty table, for the vacuity refusal case only. */
export const createEmptyAccessTable = (): CutoverAccessTable => createAccessTable(Object.freeze([]));

/**
 * Tables that violate one invariant each, so the inventory's internal guards are
 * reachable from a test instead of being unexercised code. "inert-writes" models
 * the case that matters most in a real cutover: a deny or a restore that reports
 * success while the underlying state never moved.
 */
export type AccessTableDefect = "duplicate" | "missing-state" | "inert-writes";

export const createDefectiveAccessTable = (defect: AccessTableDefect): CutoverAccessTable => {
  if (defect === "duplicate") {
    const first = DECLARED_PATHS[0];
    if (first === undefined) {
      throw new Error("cutover fixture: no declared paths to duplicate");
    }
    return createAccessTable(Object.freeze([...DECLARED_PATHS, first]));
  }
  const table = createAccessTable(DECLARED_PATHS);
  if (defect === "missing-state") {
    return { declarations: table.declarations, stateOf: () => undefined, setState: table.setState };
  }
  return { declarations: table.declarations, stateOf: table.stateOf, setState: () => undefined };
};

/** The file mutated by `mutateOneByte`. Named so the drill can assert on it. */
export const MUTATION_TARGET = "data/records-large.bin";

const LARGE_FILE_BYTES = 4096;

/** Seeded, never random: the same fixture bytes on every host and every run. */
const largeFileContent = (): Buffer =>
  Buffer.from(Uint8Array.from({ length: LARGE_FILE_BYTES }, (_unused, i) => (i * 31 + 7) % 251));

const FIXTURE_FILES: readonly (readonly [string, Buffer])[] = Object.freeze([
  ["config/legacy.json", Buffer.from('{"schema":1,"writer":"legacy"}', "utf8")],
  ["config/nested/deep/very/much/leaf.txt", Buffer.from("leaf of a deliberately deep path\n", "utf8")],
  ["data/Alpha.txt", Buffer.from("uppercase A sorts before lowercase a by code point\n", "utf8")],
  ["data/alpha-2.txt", Buffer.from("lowercase sibling\n", "utf8")],
  ["data/empty.txt", Buffer.alloc(0)],
  ["data/café-日本語.txt", Buffer.from("non-ASCII content: ß æ 日本語 — em dash\n", "utf8")],
  ["logs/old.log", Buffer.from("an entry whose mtime is deliberately older\n", "utf8")],
]);

/** Fixed past mtime, so "older than the others" is a fact and not a race. */
const OLD_MTIME_SECONDS = Date.UTC(2021, 0, 2, 3, 4, 5) / 1000;

export interface CutoverFixture {
  readonly root: string;
  readonly accessTable: CutoverAccessTable;
  readonly teardown: () => void;
}

export const createCutoverFixture = (): CutoverFixture => {
  const root = mkdtempSync(join(tmpdir(), "moe-cutover-"));
  for (const [relative, content] of FIXTURE_FILES) {
    const segments = relative.split("/");
    const fileName = segments[segments.length - 1];
    if (fileName === undefined) {
      throw new Error(`cutover fixture: malformed fixture path ${relative}`);
    }
    const directory = join(root, ...segments.slice(0, -1));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, fileName), content);
  }
  writeFileSync(join(root, ...MUTATION_TARGET.split("/")), largeFileContent());
  utimesSync(join(root, "logs", "old.log"), OLD_MTIME_SECONDS, OLD_MTIME_SECONDS);

  /**
   * A deliberately held descriptor, modelling the "handle" access path. On
   * Windows a descriptor still open at `rmSync` leaves the whole temp tree
   * behind, so teardown closes every handle FIRST and only then removes.
   */
  const heldHandles: number[] = [openSync(join(root, ...MUTATION_TARGET.split("/")), "r")];

  return {
    root,
    accessTable: createAccessTable(DECLARED_PATHS),
    teardown: () => {
      while (heldHandles.length > 0) {
        const handle = heldHandles.pop();
        if (handle !== undefined) {
          closeSync(handle);
        }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
};

export interface ByteMutation {
  readonly relativePath: string;
  readonly offset: number;
  readonly previousByte: number;
  readonly nextByte: number;
}

/**
 * Flip exactly one byte in exactly one file and REPORT which. The drill's
 * positive control asserts against this report, so a mutator that changed
 * something silently — or changed nothing — would make that control vacuous.
 * The byte count is preserved so the comparison must detect CONTENT_CHANGED
 * rather than the easier LENGTH_CHANGED.
 */
export const mutateOneByte = (root: string): ByteMutation => {
  const offset = 17;
  const absolute = join(root, ...MUTATION_TARGET.split("/"));
  const content = readFileSync(absolute);
  const previousByte = content[offset];
  if (previousByte === undefined) {
    throw new Error(`cutover fixture: ${MUTATION_TARGET} is shorter than offset ${offset}`);
  }
  const nextByte = previousByte ^ 0xff;
  content[offset] = nextByte;
  writeFileSync(absolute, content);
  if (content.length !== LARGE_FILE_BYTES) {
    throw new Error("cutover fixture: mutation changed the byte count");
  }
  return { relativePath: MUTATION_TARGET, offset, previousByte, nextByte };
};

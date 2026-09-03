/**
 * Legacy quiesce drill — rehearsal against an ISOLATED SANDBOX.
 *
 * WHAT THIS DOES NOT DO. It does not stop, deny, signal or kill any real daemon,
 * IDE, launcher, watcher, scheduled start, process or handle. Every access path
 * here is a simulated entry in a fixture table, and every byte is under the OS
 * temp directory. The live quiesce is gated on an explicit human GO_QUIESCE that
 * has not been given, and the moe daemon serving this board is itself one of the
 * paths DoD 1 enumerates — a drill that reached for a real path would take the
 * board down mid-flight.
 *
 * Three of the four DoD checks are the kind that pass while asserting nothing,
 * so each carries a named guard: the inventory asserts a NON-ZERO population by
 * name, the ten-second rule asserts the ACHIEVED elapsed gap from a monotonic
 * clock, and the manifest match is only meaningful because the positive control
 * below proves the same comparison FAILS on a one-byte change.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { compareCutoverManifests } from "./cutover-compare.js";
import {
  MUTATION_TARGET,
  createCutoverFixture,
  createEmptyAccessTable,
  createUndeniableAccessTable,
  mutateOneByte,
} from "./cutover-fixture.js";
import type { AccessPathKind } from "./cutover-fixture.js";
import {
  denyAccessPaths,
  inventoryAccessPaths,
  restoreAccessPaths,
  snapshotAccessStates,
} from "./cutover-inventory.js";
import { MAX_WALK_DEPTH, MAX_WALK_ENTRIES, captureCutoverManifest } from "./cutover-manifest.js";
import type { CutoverDirent, CutoverManifest, CutoverWalkPorts } from "./cutover-manifest.js";

/** Every path kind DoD 1 enumerates. An inventory missing one is not an inventory. */
const DOD1_KINDS: readonly AccessPathKind[] = [
  "daemon",
  "ide",
  "launcher",
  "watcher",
  "scheduled-start",
  "process",
  "handle",
  "access-path",
];

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

const fixture = () => {
  const created = createCutoverFixture();
  cleanups.push(created.teardown);
  return created;
};

function assertOk<T extends { readonly ok: boolean }>(
  result: T,
): asserts result is Extract<T, { readonly ok: true }> {
  if (!result.ok) {
    throw new Error(`expected ok:true, received ${JSON.stringify(result)}`);
  }
}

function assertRefused<T extends { readonly ok: boolean }>(
  result: T,
): asserts result is Extract<T, { readonly ok: false }> {
  if (result.ok) {
    throw new Error("expected a refusal, received ok:true");
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const dirent = (name: string, kind: "file" | "dir" | "link" | "other"): CutoverDirent => ({
  name,
  isDirectory: () => kind === "dir",
  isFile: () => kind === "file",
  isSymbolicLink: () => kind === "link",
});

/**
 * A link read that THROWS by default. Every arm that does not deliberately walk
 * a link gets this, so a walk that started following links would surface as a
 * loud UNREADABLE_ENTRY refusal rather than as a quietly plausible entry.
 */
const noLinks = (): string => {
  throw new Error("this fixture declares no symlinks");
};

describe("DoD 1 — every access path is inventoried and denied", () => {
  it("inventories the whole declared population and denies each path by name", () => {
    const { accessTable } = fixture();
    const declaredIds = accessTable.declarations.map((declaration) => declaration.id).sort();

    const before = inventoryAccessPaths(accessTable);
    assertOk(before);
    // Non-zero FIRST: "all paths stopped" over an empty population is trivially true.
    expect(before.inventory.pathCount).toBeGreaterThan(0);
    expect(before.inventory.pathCount).toBe(accessTable.declarations.length);
    expect(before.inventory.paths.map((path) => path.id).sort()).toEqual(declaredIds);
    expect(DOD1_KINDS).toHaveLength(8);
    for (const kind of DOD1_KINDS) {
      expect(before.inventory.paths.some((path) => path.kind === kind)).toBe(true);
    }

    const denied = denyAccessPaths(accessTable);
    assertOk(denied);
    // legacy-archive-mount was already DENIED, so it is not in the changed set.
    expect(denied.denied).toEqual(
      before.inventory.paths.filter((path) => path.state === "OPEN").map((path) => path.id),
    );

    const after = inventoryAccessPaths(accessTable);
    assertOk(after);
    // By NAME, not by count: a matching count says nothing about which path is open.
    expect(Object.fromEntries(after.inventory.paths.map((path) => [path.id, path.state]))).toEqual(
      Object.fromEntries(declaredIds.map((id) => [id, "DENIED"])),
    );
  });

  it("refuses an empty population instead of reporting that everything is stopped", () => {
    const refusal = inventoryAccessPaths(createEmptyAccessTable());
    assertRefused(refusal);
    expect(refusal.code).toBe("CUTOVER_INVENTORY_EMPTY_POPULATION");
    expect(refusal.layer).toBe("cutover-inventory");
  });

  it("names an undeniable path and mutates nothing before refusing", () => {
    const table = createUndeniableAccessTable();
    const refusal = denyAccessPaths(table);
    assertRefused(refusal);
    expect(refusal.code).toBe("CUTOVER_INVENTORY_UNDENIABLE_PATH");
    expect(refusal.layer).toBe("cutover-inventory");
    expect(refusal.pathId).toBe("legacy-firmware-timer");
    // Refuse-before-mutate: the table must not be left half-quiesced.
    expect(table.stateOf("legacy-daemon")).toBe("OPEN");
  });
});

describe("DoD 2 — two manifests at least ten seconds apart match", () => {
  it(
    "matches across a real, monotonically measured wait of at least ten seconds",
    async () => {
      const { root } = fixture();
      const before = captureCutoverManifest(root);
      assertOk(before);

      const startedAt = process.hrtime.bigint();
      await sleep(10_200);
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      // The load-bearing assertion. A faked clock or a clamped delay would leave
      // the match below green while no ten seconds had passed.
      expect(elapsedMs).toBeGreaterThanOrEqual(10_000);

      const after = captureCutoverManifest(root);
      assertOk(after);
      const comparison = compareCutoverManifests(before.manifest, after.manifest);
      assertOk(comparison);
      expect(comparison.matched).toBe(true);
      expect(comparison.differences).toEqual([]);
      expect(comparison.comparedEntryCount).toBe(before.manifest.entryCount);
      expect(comparison.comparedEntryCount).toBeGreaterThan(0);
    },
    60_000,
  );

  it("POSITIVE CONTROL: the same comparison fails on a single changed byte", () => {
    const { root } = fixture();
    const before = captureCutoverManifest(root);
    assertOk(before);

    const mutation = mutateOneByte(root);
    expect(mutation.relativePath).toBe(MUTATION_TARGET);
    expect(mutation.nextByte).not.toBe(mutation.previousByte);

    const after = captureCutoverManifest(root);
    assertOk(after);
    const comparison = compareCutoverManifests(before.manifest, after.manifest);
    assertOk(comparison);
    expect(comparison.matched).toBe(false);
    // The exact path and the exact kind: the byte count was preserved, so only a
    // content hash — not a length check — can have caught this.
    expect(comparison.differences).toEqual([{ path: MUTATION_TARGET, kind: "CONTENT_CHANGED" }]);
  });

  it("refuses rather than matching an empty or self-inconsistent manifest", () => {
    const empty = { root: "sandbox", entryCount: 0, entries: [], excludedDirectories: [] };
    const emptyRefusal = compareCutoverManifests(empty, empty);
    assertRefused(emptyRefusal);
    expect(emptyRefusal.code).toBe("CUTOVER_MANIFEST_EMPTY");
    expect(emptyRefusal.layer).toBe("cutover-manifest");

    const lying = { root: "sandbox", entryCount: 7, entries: [], excludedDirectories: [] };
    const countRefusal = compareCutoverManifests(lying, lying);
    assertRefused(countRefusal);
    expect(countRefusal.code).toBe("CUTOVER_MANIFEST_COUNT_INCONSISTENT");
    expect(countRefusal.layer).toBe("cutover-manifest");
  });
});

describe("DoD 3 — abort restores pre-cutover access and legacy bytes are unchanged", () => {
  it("restores every path to its exact saved state, not merely to open", () => {
    const { root, accessTable } = fixture();
    const preCutover = captureCutoverManifest(root);
    assertOk(preCutover);

    const before = inventoryAccessPaths(accessTable);
    assertOk(before);
    const saved = snapshotAccessStates(before.inventory);
    // The saved state is deliberately NOT uniform. Without this, "restore to all
    // open" would be indistinguishable from an exact restore.
    expect(saved["legacy-archive-mount"]).toBe("DENIED");
    expect(saved["legacy-daemon"]).toBe("OPEN");

    assertOk(denyAccessPaths(accessTable));
    const quiesced = inventoryAccessPaths(accessTable);
    assertOk(quiesced);
    expect(quiesced.inventory.paths.every((path) => path.state === "DENIED")).toBe(true);

    assertOk(restoreAccessPaths(accessTable, saved));

    // Read the table again rather than trusting what restore reported.
    const aborted = inventoryAccessPaths(accessTable);
    assertOk(aborted);
    expect(Object.fromEntries(aborted.inventory.paths.map((path) => [path.id, path.state]))).toEqual(
      saved,
    );
    expect(accessTable.stateOf("legacy-archive-mount")).toBe("DENIED");

    const postAbort = captureCutoverManifest(root);
    assertOk(postAbort);
    const comparison = compareCutoverManifests(preCutover.manifest, postAbort.manifest);
    assertOk(comparison);
    expect(comparison.matched).toBe(true);
    // Byte for byte, not merely "no differences reported".
    expect(postAbort.manifest.entries).toEqual(preCutover.manifest.entries);
    expect(postAbort.manifest.entryCount).toBe(preCutover.manifest.entryCount);
  });

  it("refuses a saved state that does not describe this table", () => {
    const { accessTable } = fixture();
    const inventoried = inventoryAccessPaths(accessTable);
    assertOk(inventoried);
    const saved = snapshotAccessStates(inventoried.inventory);

    const { "legacy-daemon": _omitted, ...incomplete } = saved;
    const incompleteRefusal = restoreAccessPaths(accessTable, incomplete);
    assertRefused(incompleteRefusal);
    expect(incompleteRefusal.code).toBe("CUTOVER_INVENTORY_RESTORE_INCOMPLETE");
    expect(incompleteRefusal.layer).toBe("cutover-inventory");
    expect(incompleteRefusal.pathId).toBe("legacy-daemon");

    const unknownRefusal = restoreAccessPaths(accessTable, { ...saved, "legacy-ghost": "OPEN" });
    assertRefused(unknownRefusal);
    expect(unknownRefusal.code).toBe("CUTOVER_INVENTORY_RESTORE_UNKNOWN_PATH");
    expect(unknownRefusal.pathId).toBe("legacy-ghost");
  });
});

describe("the walk refuses with exact codes instead of throwing or skipping", () => {
  const throwingPorts = (failing: "readDirectory" | "readFile"): CutoverWalkPorts => ({
    readDirectory: (absolute) => {
      if (failing === "readDirectory") {
        throw new Error("simulated EACCES");
      }
      return absolute.endsWith("sealed") ? [] : [dirent("sealed.bin", "file")];
    },
    readFile: () => {
      throw new Error("simulated EACCES");
    },
    readLinkTarget: noLinks,
  });

  it("refuses an unreadable file rather than silently skipping it", () => {
    const { root } = fixture();
    const result = captureCutoverManifest(root, { ports: throwingPorts("readFile") });
    assertRefused(result);
    expect(result.code).toBe("CUTOVER_MANIFEST_UNREADABLE_ENTRY");
    expect(result.layer).toBe("cutover-manifest");
    expect(result.path).toBe("sealed.bin");
  });

  it("refuses an unreadable directory rather than silently skipping it", () => {
    const { root } = fixture();
    const result = captureCutoverManifest(root, { ports: throwingPorts("readDirectory") });
    assertRefused(result);
    expect(result.code).toBe("CUTOVER_MANIFEST_UNREADABLE_ENTRY");
    expect(result.path).toBe("");
  });

  it("refuses an entry that is neither a regular file nor a directory", () => {
    const { root } = fixture();
    const result = captureCutoverManifest(root, {
      ports: {
        readDirectory: () => [dirent("legacy.sock", "other")],
        readFile: () => Buffer.alloc(0),
        readLinkTarget: noLinks,
      },
    });
    assertRefused(result);
    expect(result.code).toBe("CUTOVER_MANIFEST_UNSUPPORTED_ENTRY");
    expect(result.path).toBe("legacy.sock");
  });

  it("refuses a tree deeper than the real production depth bound", () => {
    const deepRoot = mkdtempSync(join(tmpdir(), "moe-cutover-deep-"));
    cleanups.push(() => rmSync(deepRoot, { recursive: true, force: true }));
    const segments = Array.from({ length: MAX_WALK_DEPTH + 1 }, () => "d");
    mkdirSync(join(deepRoot, ...segments), { recursive: true });
    writeFileSync(join(deepRoot, ...segments, "leaf.txt"), "too deep");

    const result = captureCutoverManifest(deepRoot);
    assertRefused(result);
    expect(result.code).toBe("CUTOVER_MANIFEST_DEPTH_EXCEEDED");
    expect(result.layer).toBe("cutover-manifest");
    expect(result.path).toBe(segments.join("/"));
  });

  it("refuses a tree wider than the entry bound, and the shipped bounds are the production ones", () => {
    // The bound is lowered so the case is tractable; the branch under test is the
    // production one, and the shipped constants are pinned right here.
    expect(MAX_WALK_DEPTH).toBe(32);
    expect(MAX_WALK_ENTRIES).toBe(10_000);

    const { root } = fixture();
    const result = captureCutoverManifest(root, { maxEntries: 3 });
    assertRefused(result);
    expect(result.code).toBe("CUTOVER_MANIFEST_ENTRY_LIMIT_EXCEEDED");
    expect(result.layer).toBe("cutover-manifest");
  });

  it("refuses an unreadable root", () => {
    const { root } = fixture();
    const result = captureCutoverManifest(join(root, "does-not-exist"));
    assertRefused(result);
    expect(result.code).toBe("CUTOVER_MANIFEST_ROOT_UNREADABLE");
    expect(result.layer).toBe("cutover-manifest");
  });
});

/**
 * TASK-MF - a pnpm workspace is not a flat tree of files and directories.
 *
 * The live quiesce (task-e60b874b) fired `captureCutoverManifest` on the real
 * repo root and refused on the FIRST junction it met:
 *   {"ok":false,"layer":"cutover-manifest","code":"CUTOVER_MANIFEST_UNSUPPORTED_ENTRY",
 *    "path":"packages/testkit/node_modules/@moe/contracts"}
 *
 * The repair keeps the module doctrine at line 6 intact - nothing is silently
 * skipped. A link is RECORDED as a link, an excluded directory is RECORDED as an
 * exclusion, and anything still unclassifiable stays a hard refusal.
 */
describe("TASK-MF: links are manifested and node_modules is excluded on the record", () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

  const linkPorts = (target: string): CutoverWalkPorts => ({
    readDirectory: () => [dirent("legacy-link", "link")],
    readFile: () => Buffer.alloc(0),
    readLinkTarget: () => target,
  });

  it("TASK-MF ARM A: records a symlink as a LINK entry with its target and no content hash", () => {
    const { root } = fixture();
    const result = captureCutoverManifest(root, {
      ports: linkPorts("D:/projexts/moe-next/packages/contracts"),
    });
    assertOk(result);

    expect(result.manifest.entryCount).toBe(1);
    const entry = result.manifest.entries[0];
    if (entry === undefined) {
      throw new Error("the walk recorded no entry at all");
    }
    expect(entry.kind).toBe("LINK");
    expect(entry.path).toBe("legacy-link");
    // The resolved target, not a bare boolean: a junction that starts pointing
    // somewhere else is a change, and only the target can show it.
    expect(entry).toEqual({
      kind: "LINK",
      path: "legacy-link",
      target: "D:/projexts/moe-next/packages/contracts",
    });
    // No content hash. A link has no bytes of its own to hash.
    expect("sha256" in entry).toBe(false);
    expect("byteLength" in entry).toBe(false);
    expect(result.manifest.excludedDirectories).toEqual([]);
  });

  it("TASK-MF ARM A2: refuses a link whose target cannot be read rather than recording an empty target", () => {
    const { root } = fixture();
    const result = captureCutoverManifest(root, {
      ports: {
        readDirectory: () => [dirent("legacy-link", "link")],
        readFile: () => Buffer.alloc(0),
        readLinkTarget: () => {
          throw new Error("simulated EACCES");
        },
      },
    });
    assertRefused(result);
    expect(result.code).toBe("CUTOVER_MANIFEST_UNREADABLE_ENTRY");
    expect(result.layer).toBe("cutover-manifest");
    expect(result.path).toBe("legacy-link");
  });

  /**
   * ARM B - THE DIVERGENCE INPUT. The tempting repair is
   * `if (!dirent.isFile()) { record a link }`, which greens the junction AND
   * silently swallows sockets and fifos, destroying the property this walker was
   * built for. The socket arm above (`legacy.sock`, assertions unchanged) is the
   * only thing that can tell the two repairs apart: under that mutant it goes red
   * HERE and nowhere else, because a socket and a symlink of the same name are
   * the one pair of inputs the two branches must answer differently.
   */
  it("TASK-MF ARM B: a socket and a symlink of the SAME name reach different outcomes", () => {
    const { root } = fixture();
    const asSocket = captureCutoverManifest(root, {
      ports: {
        readDirectory: () => [dirent("same-name", "other")],
        readFile: () => Buffer.alloc(0),
        readLinkTarget: noLinks,
      },
    });
    const asLink = captureCutoverManifest(root, { ports: linkPorts("D:/elsewhere") });

    assertRefused(asSocket);
    expect(asSocket.code).toBe("CUTOVER_MANIFEST_UNSUPPORTED_ENTRY");
    expect(asSocket.layer).toBe("cutover-manifest");
    expect(asSocket.path).toBe("same-name");
    // Same seam, same walk, opposite answer. Not merely "did not crash".
    assertOk(asLink);
    expect(asLink.manifest.entries.map((entry) => entry.kind)).toEqual(["LINK"]);
  });

  const excludingPorts = (root: string, descended: string[]): CutoverWalkPorts => ({
    readDirectory: (absolute) => {
      descended.push(absolute);
      if (absolute === root) {
        return [dirent("node_modules", "dir"), dirent("src", "dir"), dirent("node_modules.md", "file")];
      }
      if (absolute.endsWith("node_modules")) {
        return [dirent("buried.txt", "file")];
      }
      return absolute.endsWith("src") ? [dirent("kept.txt", "file")] : [];
    },
    readFile: () => Buffer.from("bytes"),
    readLinkTarget: noLinks,
  });

  it("TASK-MF ARM C1: the skipped directory is DECLARED in the manifest, not silently dropped", () => {
    const { root } = fixture();
    const result = captureCutoverManifest(root, { ports: excludingPorts(root, []) });
    assertOk(result);
    expect(result.manifest.excludedDirectories).toEqual(["node_modules"]);
  });

  it("TASK-MF ARM C2: nothing beneath the excluded directory is walked or counted", () => {
    const { root } = fixture();
    const descended: string[] = [];
    const result = captureCutoverManifest(root, { ports: excludingPorts(root, descended) });
    assertOk(result);

    expect(result.manifest.entries.some((entry) => entry.path.startsWith("node_modules/"))).toBe(false);
    // Excluded at QUEUE time: the directory is never even read, so its children
    // can never be counted toward the entry bound.
    expect(descended.some((absolute) => absolute.endsWith("node_modules"))).toBe(false);
    // A NAME match, not a path substring: `node_modules.md` is an ordinary file.
    expect(result.manifest.entries.map((entry) => entry.path).sort()).toEqual([
      "node_modules.md",
      "src/kept.txt",
    ]);
  });

  const manifestOf = (
    entries: CutoverManifest["entries"],
    excludedDirectories: readonly string[] = ["node_modules"],
  ): CutoverManifest => ({ root: "D:/legacy", entryCount: entries.length, entries, excludedDirectories });

  const FILE_ENTRY = { kind: "FILE", path: "state.json", byteLength: 5, sha256: "a".repeat(64) } as const;
  const LINK_ENTRY = { kind: "LINK", path: "state.json", target: "D:/a" } as const;

  it("TASK-MF ARM D1: comparing manifests with different exclusion sets REFUSES", () => {
    const refusal = compareCutoverManifests(
      manifestOf([FILE_ENTRY], []),
      manifestOf([FILE_ENTRY], ["node_modules"]),
    );
    assertRefused(refusal);
    // A widened exclusion between the two captures could hide a real change, so
    // this fails closed rather than reporting a clean match over fewer files.
    expect(refusal.code).toBe("CUTOVER_MANIFEST_EXCLUSION_MISMATCH");
    expect(refusal.layer).toBe("cutover-manifest");
  });

  it("TASK-MF ARM D2: a LINK whose target moved is its own difference kind", () => {
    const comparison = compareCutoverManifests(
      manifestOf([LINK_ENTRY]),
      manifestOf([{ ...LINK_ENTRY, target: "D:/b" }]),
    );
    assertOk(comparison);
    expect(comparison.matched).toBe(false);
    expect(comparison.differences).toEqual([{ path: "state.json", kind: "LINK_TARGET_CHANGED" }]);
  });

  it("TASK-MF ARM D3: a FILE replaced by a LINK is its own difference kind, never CONTENT_CHANGED", () => {
    const comparison = compareCutoverManifests(manifestOf([FILE_ENTRY]), manifestOf([LINK_ENTRY]));
    assertOk(comparison);
    expect(comparison.matched).toBe(false);
    expect(comparison.differences).toEqual([{ path: "state.json", kind: "KIND_CHANGED" }]);
  });

  /**
   * ARM E - THE ACCEPTANCE. Fixtures stayed green through the entire defect
   * because none of them contained a pnpm junction tree. Only the real root
   * proves this row unblocked task-e60b874b.
   */
  it(
    "TASK-MF ARM E: captureCutoverManifest succeeds against the REAL repo root",
    () => {
      const result = captureCutoverManifest(REPO_ROOT);
      assertOk(result);
      // Non-zero FIRST: a walk that silently returned nothing must not read as success.
      expect(result.manifest.entryCount).toBeGreaterThan(0);
      expect(result.manifest.entries).toHaveLength(result.manifest.entryCount);
      expect(result.manifest.excludedDirectories.length).toBeGreaterThan(0);
      expect(result.manifest.excludedDirectories).toContain("node_modules");
    },
    300_000,
  );

  /**
   * ARM E2 walks `packages/` rather than REPO_ROOT. The equality this arm asserts
   * needs a tree that is genuinely unchanged BETWEEN the two captures, and the
   * repository root is not one while the suite runs: every CI leg invokes this
   * lane as `pnpm test | tee vitest-root-posix.log` (cross-host.yml:97, :309),
   * so a root-level log file grows between the captures and lands as a
   * LENGTH_CHANGED difference that says nothing about the walk. `packages/`
   * still carries ten pnpm junction trees, one node_modules per package, so the
   * link-and-exclusion behaviour this row exists to prove is fully exercised;
   * ARM E above keeps the real root under a single capture, where churn is
   * harmless.
   */
  it(
    "TASK-MF ARM E2: two successive captures of an unchanged real subtree compare EQUAL",
    () => {
      const subtree = join(REPO_ROOT, "packages");
      const before = captureCutoverManifest(subtree);
      assertOk(before);
      const after = captureCutoverManifest(subtree);
      assertOk(after);
      // The subtree really does carry the junction trees this row is about:
      // one `node_modules` per workspace package, recorded by relative path.
      const excludedLinkTrees = before.manifest.excludedDirectories
        .filter((entry) => entry.endsWith("node_modules"));
      expect(excludedLinkTrees.length).toBeGreaterThan(1);
      const comparison = compareCutoverManifests(before.manifest, after.manifest);
      assertOk(comparison);
      expect(comparison.comparedEntryCount).toBeGreaterThan(0);
      expect(comparison.differences).toEqual([]);
      expect(comparison.matched).toBe(true);
    },
    600_000,
  );
});

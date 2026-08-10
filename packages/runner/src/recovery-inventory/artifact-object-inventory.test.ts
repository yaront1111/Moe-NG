/**
 * Behaviour contract for the ARTIFACT_OBJECT_STAGING recovery-inventory adapter.
 *
 * The bytes are real: every happy-path arm stages through the shipped
 * `createArtifactStore` over `createNodeArtifactFs` into an `mkdtemp` directory
 * under the OS temp root, so the `<root>/objects/<sha256>` layout on disk is the
 * one being enumerated. No address grammar, digest or layout rule is
 * reimplemented here.
 *
 * The hostile arms inject `ArtifactFsPort` stubs, which is what that port is for:
 * a real filesystem cannot be made to hold 4097 entries or two files of one name
 * on demand. Every refusal is asserted END TO END through the shipped
 * `collectRecoveryInventory`, the only surface that mints coverage codes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  collectRecoveryInventory,
  createRecoveryInventoryRegistry,
  isRecoveryInventoryFailure,
} from "@moe/runner";
import type {
  RecoveryInventoryCoverageProof,
  RecoveryInventoryReport,
  RecoveryInventoryUnknownReason,
} from "@moe/runner";

import {
  sha256Hex,
  type ArtifactDirectoryEntry,
  type ArtifactFsPort,
} from "../artifacts/artifact-contract.js";
import { createNodeArtifactFs } from "../artifacts/artifact-node-fs.js";
import { createArtifactStore } from "../artifacts/artifact-store.js";
import {
  artifactObjectInventoryRegistration,
  enumerateArtifactObjectInventory,
  type ArtifactObjectInventoryInput,
} from "./artifact-object-inventory.js";
import { identityKey, readIdentity } from "./recovery-inventory-shape.js";

const CLASS = "ARTIFACT_OBJECT_STAGING";
const LAYER = "INVENTORY_ADAPTER";
const UNKNOWN_CODE = "RECOVERY_INVENTORY_COVERAGE_UNKNOWN";
const PROJECT = "moe-next";
const OBSERVED_AT = "2026-08-05T12:00:00.000Z";
const OUTSIDE_WINDOW = "2026-07-01T00:00:00.000Z";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const STAGING_A = "aaaaaaaaaaaaaaaa.0.tmp";
const STAGING_B = "bbbbbbbbbbbbbbbb.0.tmp";

/** Counts coverage cases actually generated: a sweep producing nothing must fail. */
const GENERATED: string[] = [];

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "moe-recovery-artifact-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function storeAt(storeRoot: string, fs: ArtifactFsPort = createNodeArtifactFs()) {
  let counter = 0;
  return createArtifactStore({ root: storeRoot, fs, nextStagingCounter: () => (counter += 1) });
}

/** Writes straight into the real layout, bypassing staging, as corruption would. */
function placeInObjects(name: string, contents: string): void {
  mkdirSync(join(root, "objects"), { recursive: true });
  writeFileSync(join(root, "objects", name), contents);
}

interface StubShape {
  readonly entries: readonly ArtifactDirectoryEntry[];
  readonly readAllThrows?: boolean;
  readonly withoutListDirectory?: boolean;
}

/** A caller-supplied port, exactly as the optional `listDirectory` signature allows. */
function stubFs(shape: StubShape): ArtifactFsPort {
  const unreachable = (): never => {
    throw new Error("this port only supports enumeration");
  };
  const base = {
    openWrite: unreachable,
    write: unreachable,
    fsync: unreachable,
    close: unreachable,
    exists: (): boolean => true,
    rename: unreachable,
    persistAfterRename: unreachable,
    readAll: (): Uint8Array => {
      if (shape.readAllThrows === true) {
        throw new Error("entry is unreadable");
      }
      return new Uint8Array();
    },
    unlink: unreachable,
  };
  if (shape.withoutListDirectory === true) {
    return base;
  }
  return { ...base, listDirectory: (): readonly ArtifactDirectoryEntry[] => shape.entries };
}

function files(names: readonly string[]): readonly ArtifactDirectoryEntry[] {
  return names.map((name) => ({ name, kind: "FILE" as const }));
}

function inputFor(
  store: ReturnType<typeof storeAt>,
  observedAt: string = OBSERVED_AT,
): ArtifactObjectInventoryInput {
  return { store, clock: { observedAt: () => observedAt } };
}

const CONTEXT = {
  class: CLASS,
  projectTag: PROJECT,
  backup: { kind: "BACKUP_CURSOR_GENERATION", ref: "gen-42", digest: DIGEST_A },
  incarnation: { kind: "RECOVERY_INCARNATION", ref: "inc-7", digest: DIGEST_B },
  window: { startInclusive: "2026-08-01T00:00:00Z", endInclusive: "2026-08-09T23:59:59Z" },
} as const;

function request(): Record<string, unknown> {
  return {
    projectTag: PROJECT,
    backup: { ...CONTEXT.backup },
    incarnation: { ...CONTEXT.incarnation },
    window: { ...CONTEXT.window },
    configuredClasses: [CLASS],
  };
}

async function collect(input: ArtifactObjectInventoryInput): Promise<RecoveryInventoryReport> {
  const registry = createRecoveryInventoryRegistry([artifactObjectInventoryRegistration(input)]);
  const result = await collectRecoveryInventory(request(), registry);
  if (isRecoveryInventoryFailure(result)) {
    throw new Error(`expected a report, got refusal ${result.code}`);
  }
  return result;
}

function proofFor(report: RecoveryInventoryReport): RecoveryInventoryCoverageProof {
  const proof = report.proofs.find((candidate) => candidate.class === CLASS);
  if (proof === undefined) {
    throw new Error(`configured class ${CLASS} vanished from the report`);
  }
  GENERATED.push(CLASS);
  return proof;
}

function summary(proof: RecoveryInventoryCoverageProof): Record<string, unknown> {
  return { truth: proof.truth, code: proof.code, reason: proof.reason, layer: proof.layer };
}

const COMPLETE_PROOF = { truth: "COMPLETE", code: null, reason: null, layer: LAYER };

function expectUnknown(report: RecoveryInventoryReport, reason: RecoveryInventoryUnknownReason): void {
  expect(summary(proofFor(report))).toEqual({ truth: "UNKNOWN", code: UNKNOWN_CODE, reason, layer: LAYER });
  expect(report.coverage).toBe("UNKNOWN");
  expect(report.items).toHaveLength(0);
}

function identities(report: RecoveryInventoryReport): readonly string[] {
  return report.items.map((item) => identityKey(item.identity));
}

function factsOf(report: RecoveryInventoryReport, path: string): Record<string, unknown> {
  const found = report.items.find(
    (candidate) => candidate.identity.kind === "PATH" && candidate.identity.path === path,
  );
  if (found === undefined) {
    throw new Error(`no inventory item for external identity ${path}`);
  }
  return { ...found.facts };
}

describe("enumeration over real artifact-store bytes", () => {
  it("binds every object and staging entry to the class, an identity and a proof", async () => {
    const store = storeAt(root);
    expect(store.stageArtifact(bytesOf("alpha")).ok).toBe(true);
    expect(store.stageArtifact(bytesOf("beta")).ok).toBe(true);
    writeFileSync(join(root, "objects", STAGING_A), "temp");
    const report = await collect(inputFor(store));

    expect(summary(proofFor(report))).toEqual(COMPLETE_PROOF);
    expect(report.coverage).toBe("COMPLETE");
    expect(report.items).toHaveLength(3);
    for (const item of report.items) {
      expect(item.class).toBe(CLASS);
      expect(item.projectTag).toBe(PROJECT);
      expect(item.observedAt).toBe(OBSERVED_AT);
      expect(item.sourceProofDigest).toMatch(/^[0-9a-f]{64}$/u);
    }
    const alphaAddress = sha256Hex(bytesOf("alpha"));
    expect(factsOf(report, `objects/${alphaAddress}`)).toEqual({
      entry: "OBJECT",
      sha256: alphaAddress,
      byteLength: 5,
    });
    expect(factsOf(report, `objects/${STAGING_A}`)).toEqual({
      entry: "STAGING",
      name: STAGING_A,
      sha256: sha256Hex(bytesOf("temp")),
      byteLength: 4,
    });
    expect(identities(report)).toContain(`PATH objects/${sha256Hex(bytesOf("beta"))}`);
  });

  it("proves an observed but empty objects directory rather than staying silent", async () => {
    mkdirSync(join(root, "objects"), { recursive: true });
    const proof = proofFor(await collect(inputFor(storeAt(root))));
    expect(summary(proof)).toEqual(COMPLETE_PROOF);
    expect(proof.itemCount).toBe(0);
    // The store's own observation digest IS the negative proof.
    expect(proof.negativeProofDigest).toMatch(/^[0-9a-f]{64}$/u);
  });
});

/**
 * DoD 2. A skipped entry is invisible in a green test, which is exactly why the
 * assertion is that the VALID artifact does NOT come through: a module that
 * quietly ignored the bad name would report COMPLETE with one item.
 */
describe("an entry that is not a valid content address", () => {
  it("is reported with a stable code instead of being silently skipped", async () => {
    const store = storeAt(root);
    expect(store.stageArtifact(bytesOf("alpha")).ok).toBe(true);
    placeInObjects("not-a-content-address", "junk");

    const report = await collect(inputFor(store));
    expectUnknown(report, "RESULT_TRUNCATED");
    expect(report.proofs[0]?.itemCount).toBe(0);
    const reading = enumerateArtifactObjectInventory(inputFor(store), CONTEXT);
    expect(reading.refusal?.code).toBe("RUNNER_ARTIFACT_ADDRESS_CORRUPT");
    expect(reading.refusal?.layer).toBe("ARTIFACT_STORE");
    expect(reading.refusal?.message).toContain("not-a-content-address");
  });

  it("refuses an address whose bytes do not hash to it", async () => {
    placeInObjects(sha256Hex(bytesOf("alpha")), "these are not alpha's bytes");
    const store = storeAt(root);
    expectUnknown(await collect(inputFor(store)), "RESULT_TRUNCATED");
    expect(enumerateArtifactObjectInventory(inputFor(store), CONTEXT).refusal).toMatchObject({
      code: "RUNNER_ARTIFACT_ADDRESS_CORRUPT",
      layer: "ARTIFACT_STORE",
    });
  });
});

/**
 * Three different facts, three different answers. Two of them additionally name
 * the boundary underneath, so a layout fault never reads as an I/O fault.
 */
describe("empty, absent and unreadable are three different answers", () => {
  it("answers ENUMERATOR_UNAVAILABLE for a store root with no objects directory", async () => {
    const store = storeAt(join(root, "never-created"));
    expectUnknown(await collect(inputFor(store)), "ENUMERATOR_UNAVAILABLE");
    expect(enumerateArtifactObjectInventory(inputFor(store), CONTEXT).refusal).toMatchObject({
      code: "RUNNER_ARTIFACT_MISSING",
      layer: "ARTIFACT_FS_PORT",
    });
  });

  it("answers RESULT_TRUNCATED for an entry the port could not read", async () => {
    const store = storeAt(root, stubFs({ entries: files([STAGING_A]), readAllThrows: true }));
    expectUnknown(await collect(inputFor(store)), "RESULT_TRUNCATED");
    expect(enumerateArtifactObjectInventory(inputFor(store), CONTEXT).refusal).toMatchObject({
      code: "RUNNER_ARTIFACT_VERIFY_FAILED",
      layer: "ARTIFACT_FS_PORT",
    });
  });

  it("keeps the three answers distinct rather than sharing one code", async () => {
    mkdirSync(join(root, "objects"), { recursive: true });
    const empty = proofFor(await collect(inputFor(storeAt(root))));
    const absent = proofFor(await collect(inputFor(storeAt(join(root, "absent")))));
    const unreadable = proofFor(
      await collect(inputFor(storeAt(root, stubFs({ entries: files([STAGING_A]), readAllThrows: true })))),
    );
    const answers = [empty, absent, unreadable].map((proof) => `${proof.truth}/${String(proof.reason)}`);
    expect(answers).toEqual([
      "COMPLETE/null",
      "UNKNOWN/ENUMERATOR_UNAVAILABLE",
      "UNKNOWN/RESULT_TRUNCATED",
    ]);
    expect(new Set(answers).size).toBe(3);
  });

  it("answers CAPABILITY_UNSUPPORTED for a port that cannot list a directory at all", async () => {
    const store = storeAt(root, stubFs({ entries: [], withoutListDirectory: true }));
    expectUnknown(await collect(inputFor(store)), "CAPABILITY_UNSUPPORTED");
    expect(enumerateArtifactObjectInventory(inputFor(store), CONTEXT).refusal).toMatchObject({
      code: "RUNNER_ARTIFACT_ENUMERATION_UNAVAILABLE",
      layer: "ARTIFACT_STORE",
    });
  });
});

describe("ceilings and rejected rows", () => {
  it("reports RESULT_OVER_LIMIT one entry above the inventory ceiling", async () => {
    const names = Array.from({ length: 4097 }, (_ignored, index) => `${"0".repeat(16)}.${index}.tmp`);
    expect(names).toHaveLength(4097);
    const store = storeAt(root, stubFs({ entries: files(names) }));
    expectUnknown(await collect(inputFor(store)), "RESULT_OVER_LIMIT");
  });

  it("refuses two entries claiming one external identity rather than merging them", async () => {
    const store = storeAt(root, stubFs({ entries: files([STAGING_A, STAGING_A]) }));
    const report = await collect(inputFor(store));
    expect(summary(proofFor(report))).toEqual({
      truth: "UNKNOWN",
      code: "RECOVERY_INVENTORY_EXTERNAL_IDENTITY_DUPLICATE",
      reason: "ITEM_REJECTED",
      layer: LAYER,
    });
    expect(report.items).toHaveLength(0);
  });

  it("refuses an item observed outside the exact recovery window", async () => {
    const store = storeAt(root);
    expect(store.stageArtifact(bytesOf("alpha")).ok).toBe(true);
    const registry = createRecoveryInventoryRegistry([
      artifactObjectInventoryRegistration(inputFor(store, OUTSIDE_WINDOW)),
    ]);
    const result = await collectRecoveryInventory(request(), registry);
    if (isRecoveryInventoryFailure(result)) {
      throw new Error(`expected a report, got refusal ${result.code}`);
    }
    expect(summary(proofFor(result))).toEqual({
      truth: "UNKNOWN",
      code: "RECOVERY_INVENTORY_WINDOW_MISMATCH",
      reason: "ITEM_REJECTED",
      layer: LAYER,
    });
    expect(result.items).toHaveLength(0);
  });
});

/** DoD 4, asserted against the production enumerator's own output. */
describe("deterministic order and digest", () => {
  function orderOf(names: readonly string[]): { readonly keys: readonly string[]; readonly proof: string | null } {
    const reading = enumerateArtifactObjectInventory(
      inputFor(storeAt(root, stubFs({ entries: files(names) }))),
      CONTEXT,
    ).reading;
    if (reading.status !== "ENUMERATED") {
      throw new Error(`expected an enumeration, got ${reading.status}`);
    }
    const keys = reading.items.map((item) => {
      const identity = readIdentity((item as { identity: unknown }).identity);
      if (identity === null) throw new Error("the enumerator emitted an unreadable identity");
      return identityKey(identity);
    });
    return { keys, proof: reading.negativeProofDigest };
  }

  it("orders by code point and is unchanged by the order the port listed in", () => {
    const forward = orderOf([STAGING_A, STAGING_B]);
    const reversed = orderOf([STAGING_B, STAGING_A]);
    expect(forward.keys).toEqual([`PATH objects/${STAGING_A}`, `PATH objects/${STAGING_B}`]);
    expect(reversed.keys).toEqual(forward.keys);
    expect(reversed.proof).toBe(forward.proof);
    expect(forward.proof).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("gives a different population a different negative proof", () => {
    expect(orderOf([STAGING_A]).proof).not.toBe(orderOf([STAGING_A, STAGING_B]).proof);
  });
});

describe("coverage sweep", () => {
  it("generated a non-zero, exact number of coverage cases for the artifact class", () => {
    expect(GENERATED.filter((entry) => entry === CLASS)).toHaveLength(13);
    expect(GENERATED.length).toBeGreaterThan(0);
  });
});

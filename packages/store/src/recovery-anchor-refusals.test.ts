/**
 * DoD 4's refusal surface: anchor, database, command and incarnation mismatch,
 * absent persistence proof, and unverifiable inactive bytes. Each must answer
 * with its OWN stable code at layer RECOVERY_ANCHOR, so a test can say which
 * fault was found rather than only that something was wrong.
 */
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteEventStore } from "./index.js";
import {
  RECOVERY_ANCHOR_DATABASE_NAME,
  RECOVERY_ANCHOR_FILE_NAME,
  RECOVERY_ANCHOR_SLOTS_DIR_NAME,
  RECOVERY_ANCHOR_SLOT_MANIFEST_NAME,
} from "./recovery-anchor-contracts.js";
import type { RecoveryAnchorRecord } from "./recovery-anchor-contracts.js";
import {
  discardRecoveryAnchor,
  inspectRecoveryAnchor,
  installRecoveryAnchor,
  prepareRecoveryAnchor,
} from "./recovery-anchor.js";
import {
  LEGACY_RECOVERY_SLOT_MANIFEST_VERSION,
  RECOVERY_SLOT_MANIFEST_VERSION,
} from "./recovery-slot-manifest.js";

const encoder = new TextEncoder();
/** Built from a char code so no escaping layer can collapse it to a plain name. */
const BACKSLASH_PATH = `artifacts${String.fromCharCode(92)}one.bin`;
const INCARNATION_REF = "1a".repeat(32);
const KEY_EPOCH_REF = "4d".repeat(32);
const PROJECT_ID = "recovery-anchor-refusal-project";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `moe-anchor-refusal-${label}-`));
  directories.push(directory);
  return directory;
}

function restoredDatabaseBytes(): Uint8Array {
  const path = join(temporaryDirectory("source"), "restored.sqlite");
  SqliteEventStore.openForProject(path, PROJECT_ID).close();
  return readFileSync(path);
}

function request(root: string, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    anchorRoot: root,
    generationDigest: "aa".repeat(32),
    incarnationRef: INCARNATION_REF,
    keyEpochRef: KEY_EPOCH_REF,
    payload: {
      artifacts: [{ bytes: encoder.encode("artifact-one"), logicalPath: "artifacts/one.bin" }],
      databaseBytes: restoredDatabaseBytes(),
    },
    preparedAt: "2026-08-11T09:00:00.000Z",
    projectId: PROJECT_ID,
    restoreCommandId: "restore-command-refusal",
    ...overrides,
  };
}

/** A completed install, so every tamper below starts from a state that verifies. */
async function installedRoot(label: string): Promise<{ root: string; anchor: RecoveryAnchorRecord }> {
  const root = temporaryDirectory(label);
  const result = await installRecoveryAnchor(request(root));
  expect(result.ok, result.ok ? "installed" : `${result.layer}/${result.code}`).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return { anchor: result.anchor, root };
}

function currentSlotPath(root: string, anchor: RecoveryAnchorRecord): string {
  return join(root, RECOVERY_ANCHOR_SLOTS_DIR_NAME, anchor.currentSlot);
}

function slotManifestPath(root: string, slot: string): string {
  return join(root, RECOVERY_ANCHOR_SLOTS_DIR_NAME, slot, RECOVERY_ANCHOR_SLOT_MANIFEST_NAME);
}

function readSlotManifest(root: string, slot: string): Record<string, unknown> {
  return JSON.parse(readFileSync(slotManifestPath(root, slot), "utf8")) as Record<string, unknown>;
}

function writeLegacySlotManifest(root: string, anchor: RecoveryAnchorRecord): void {
  writeFileSync(
    slotManifestPath(root, anchor.currentSlot),
    JSON.stringify({
      generationDigest: anchor.generationDigest,
      incarnationRef: anchor.incarnationRef,
      keyEpochRef: anchor.keyEpochRef,
      payloadDigests: anchor.payloadDigests,
      slotManifestVersion: LEGACY_RECOVERY_SLOT_MANIFEST_VERSION,
    }),
  );
}

async function refusedInspect(root: string): Promise<{ code: string; layer: string }> {
  const result = await inspectRecoveryAnchor(root);
  expect(result.ok, "expected the inspection to refuse").toBe(false);
  if (result.ok) throw new Error("unreachable");
  return { code: result.code, layer: result.layer };
}

async function inspectedFault(
  root: string,
): Promise<{ code: string; layer: string; verified: boolean }> {
  const result = await inspectRecoveryAnchor(root);
  if (!result.ok || result.outcome !== "INSPECTED") throw new Error("expected INSPECTED");
  return {
    code: result.mutatingOpenRefusal.code,
    layer: result.mutatingOpenRefusal.layer,
    verified: result.slotVerified,
  };
}

describe("recovery anchor refuses a tampered anchor", () => {
  it("verifies before any tamper, so each refusal below is caused by the tamper", async () => {
    const { root } = await installedRoot("control");
    const observed = await inspectedFault(root);

    // POSITIVE CONTROL. Without it, a refusal test proves only that something
    // was wrong, not that the tamper is what made it wrong.
    expect(observed.verified).toBe(true);
    expect(observed.code).toBe("RECOVERY_ANCHOR_RECOVERY_REQUIRED");
  });

  it("refuses an anchor whose digest no longer covers its own contents", async () => {
    const { root } = await installedRoot("digest");
    const path = join(root, RECOVERY_ANCHOR_FILE_NAME);
    const stored = JSON.parse(readFileSync(path, "utf8"));
    // Valid JSON, supported codec version, every field still well formed — so
    // no earlier guard can answer and the digest check is what refuses.
    writeFileSync(path, JSON.stringify({ ...stored, restoreCommandId: "restore-command-forged" }));

    const outcome = await refusedInspect(root);
    expect(outcome.code).toBe("RECOVERY_ANCHOR_DIGEST_MISMATCH");
    expect(outcome.layer).toBe("RECOVERY_ANCHOR");
  });

  it("refuses an anchor written by a codec version it cannot read", async () => {
    const { root } = await installedRoot("codec");
    const path = join(root, RECOVERY_ANCHOR_FILE_NAME);
    const stored = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...stored, anchorCodecVersion: "moe-recovery-anchor/99" }));

    const outcome = await refusedInspect(root);
    // The version check runs BEFORE the digest check: an unreadable codec must
    // not be reported as a corrupt digest.
    expect(outcome.code).toBe("RECOVERY_ANCHOR_CODEC_VERSION_UNSUPPORTED");
    expect(outcome.layer).toBe("RECOVERY_ANCHOR");
  });
});

describe("recovery anchor refuses an unverifiable slot", () => {
  it("reports absent persistence proof when the slot manifest is gone", async () => {
    const { root, anchor } = await installedRoot("proof");
    unlinkSync(join(currentSlotPath(root, anchor), RECOVERY_ANCHOR_SLOT_MANIFEST_NAME));

    const observed = await inspectedFault(root);
    expect(observed.verified).toBe(false);
    expect(observed.code).toBe("RECOVERY_ANCHOR_PERSISTENCE_UNPROVEN");
    expect(observed.layer).toBe("RECOVERY_ANCHOR");
  });

  it("reports absent persistence proof when the slot database is gone", async () => {
    const { root, anchor } = await installedRoot("nodb");
    unlinkSync(join(currentSlotPath(root, anchor), RECOVERY_ANCHOR_DATABASE_NAME));

    const observed = await inspectedFault(root);
    expect(observed.verified).toBe(false);
    expect(observed.code).toBe("RECOVERY_ANCHOR_PERSISTENCE_UNPROVEN");
    expect(observed.layer).toBe("RECOVERY_ANCHOR");
  });

  it("reports unverifiable bytes when a restored artifact no longer matches", async () => {
    const { root, anchor } = await installedRoot("bytes");
    writeFileSync(join(currentSlotPath(root, anchor), "artifacts", "one.bin"), "tampered");

    const observed = await inspectedFault(root);
    expect(observed.verified).toBe(false);
    // Distinct from PERSISTENCE_UNPROVEN: the proof is present and the bytes
    // disagree with it, which is a different fault from having no proof.
    expect(observed.code).toBe("RECOVERY_ANCHOR_SLOT_UNVERIFIABLE");
  });

  it("reports a database mismatch when the stamped incarnation is not the selected one", async () => {
    const { root, anchor } = await installedRoot("dbmismatch");
    const manifestPath = join(currentSlotPath(root, anchor), RECOVERY_ANCHOR_SLOT_MANIFEST_NAME);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    // Artifacts still verify against their unchanged digests, so this reaches
    // the database comparison rather than being answered by the bytes check.
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, incarnationRef: "9f".repeat(32) }),
    );

    const observed = await inspectedFault(root);
    expect(observed.verified).toBe(false);
    expect(observed.code).toBe("RECOVERY_ANCHOR_DATABASE_MISMATCH");
  });
});

/**
 * The database is the one payload every restore must deliver, so it is the one
 * payload the slot proof must cover. Before this, the proof listed artifact
 * digests only: a restore with no artifacts could never verify (it burned its
 * fence on prepare, wrote the slot, and then refused PERSISTENCE_UNPROVEN over
 * an empty digest table, identically on every retry), while a restore WITH
 * artifacts verified a database whose bytes nobody had ever read back.
 */
describe("recovery anchor proves the restored database, not only the artifacts", () => {
  function slotDatabaseDigest(root: string, anchor: RecoveryAnchorRecord): string {
    const bytes = readFileSync(join(currentSlotPath(root, anchor), RECOVERY_ANCHOR_DATABASE_NAME));
    return createHash("sha256").update(bytes).digest("hex");
  }

  it("installs and verifies a restore that delivers only the database", async () => {
    const root = temporaryDirectory("artifactless");
    const result = await installRecoveryAnchor(
      request(root, { payload: { artifacts: [], databaseBytes: restoredDatabaseBytes() } }),
    );
    expect(result.ok, result.ok ? "installed" : `${result.layer}/${result.code}`).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.outcome).toBe("INSTALLED");
    expect(Object.keys(result.anchor.payloadDigests)).toEqual([]);

    // A fresh reader agrees: the slot holds a proof and the proof holds.
    const observed = await inspectedFault(root);
    expect(observed.verified).toBe(true);
    expect(observed.code).toBe("RECOVERY_ANCHOR_RECOVERY_REQUIRED");
  });

  it("carries the digest of the STAMPED database in the slot manifest", async () => {
    const { root, anchor } = await installedRoot("dbdigest");
    const manifestPath = join(currentSlotPath(root, anchor), RECOVERY_ANCHOR_SLOT_MANIFEST_NAME);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    expect(manifest.slotManifestVersion).toBe(RECOVERY_SLOT_MANIFEST_VERSION);
    expect(manifest.databaseDigest).toBe(slotDatabaseDigest(root, anchor));
    // Not the anchor's digest: that one describes the payload as delivered,
    // and the install transaction rewrote pages after delivery. A proof taken
    // from the anchor would fail every honest slot.
    expect(manifest.databaseDigest).not.toBe(anchor.databaseDigest);
  });

  it("reports unverifiable bytes when the slot database no longer matches its proof", async () => {
    const { root, anchor } = await installedRoot("dbtamper");
    writeFileSync(
      join(currentSlotPath(root, anchor), RECOVERY_ANCHOR_DATABASE_NAME),
      "not the restored database",
    );

    // Answered, not raised: these bytes are not a database SQLite can open,
    // and a verifier that opened them before comparing them would throw.
    const observed = await inspectedFault(root);
    expect(observed.verified).toBe(false);
    expect(observed.code).toBe("RECOVERY_ANCHOR_SLOT_UNVERIFIABLE");
  });

  it("reports absent persistence proof when a /2 manifest carries no database digest", async () => {
    const { root, anchor } = await installedRoot("dbproofless");
    const manifestPath = join(currentSlotPath(root, anchor), RECOVERY_ANCHOR_SLOT_MANIFEST_NAME);
    const { databaseDigest: _dropped, ...withoutProof } = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...withoutProof, slotManifestVersion: RECOVERY_SLOT_MANIFEST_VERSION }),
    );

    // Artifacts and the stamped incarnation still agree, so only the missing
    // database proof can answer, and "no proof" is not "bytes disagree".
    const observed = await inspectedFault(root);
    expect(observed.verified).toBe(false);
    expect(observed.code).toBe("RECOVERY_ANCHOR_PERSISTENCE_UNPROVEN");
    expect(observed.layer).toBe("RECOVERY_ANCHOR");
  });
});

describe("recovery anchor composes versioned slot manifests", () => {
  it("verifies a genuine pre-digest /1 slot through the historical integrity checks", async () => {
    const { root, anchor } = await installedRoot("legacy-v1");
    writeLegacySlotManifest(root, anchor);

    const observed = await inspectedFault(root);
    expect(observed.verified).toBe(true);
    expect(observed.code).toBe("RECOVERY_ANCHOR_RECOVERY_REQUIRED");
  });

  it("accepts the historical /1 writer's unsorted artifact insertion order", async () => {
    const root = temporaryDirectory("legacy-v1-order");
    const installed = await installRecoveryAnchor(
      request(root, {
        payload: {
          artifacts: [
            { bytes: encoder.encode("last"), logicalPath: "artifacts/z-last.bin" },
            { bytes: encoder.encode("first"), logicalPath: "artifacts/a-first.bin" },
          ],
          databaseBytes: restoredDatabaseBytes(),
        },
      }),
    );
    expect(installed.ok).toBe(true);
    if (!installed.ok) throw new Error("unreachable");
    expect(Object.keys(installed.anchor.payloadDigests)).toEqual([
      "artifacts/z-last.bin",
      "artifacts/a-first.bin",
    ]);
    writeLegacySlotManifest(root, installed.anchor);

    const observed = await inspectedFault(root);
    expect(observed.verified).toBe(true);
    expect(observed.code).toBe("RECOVERY_ANCHOR_RECOVERY_REQUIRED");
  });

  it("retains every historical /1 artifact, selection, SQLite, and binding check", async () => {
    const cases: readonly {
      readonly code: string;
      readonly label: string;
      readonly tamper: (root: string, anchor: RecoveryAnchorRecord) => void;
    }[] = [
      {
        code: "RECOVERY_ANCHOR_SLOT_UNVERIFIABLE",
        label: "artifact digest",
        tamper: (root, anchor) => {
          writeFileSync(join(currentSlotPath(root, anchor), "artifacts", "one.bin"), "tampered");
        },
      },
      {
        code: "RECOVERY_ANCHOR_DATABASE_MISMATCH",
        label: "selected generation",
        tamper: (root, anchor) => {
          const stored = readSlotManifest(root, anchor.currentSlot);
          writeFileSync(
            slotManifestPath(root, anchor.currentSlot),
            JSON.stringify({ ...stored, generationDigest: "ff".repeat(32) }),
          );
        },
      },
      {
        code: "RECOVERY_ANCHOR_SLOT_UNVERIFIABLE",
        label: "SQLite open",
        tamper: (root, anchor) => {
          writeFileSync(
            join(currentSlotPath(root, anchor), RECOVERY_ANCHOR_DATABASE_NAME),
            "invalid",
          );
        },
      },
      {
        code: "RECOVERY_ANCHOR_DATABASE_MISMATCH",
        label: "recovery binding",
        tamper: (root, anchor) => {
          const stored = readSlotManifest(root, anchor.currentSlot);
          writeFileSync(
            slotManifestPath(root, anchor.currentSlot),
            JSON.stringify({ ...stored, keyEpochRef: "6f".repeat(32) }),
          );
        },
      },
    ];
    expect(cases).toHaveLength(4);

    for (const hostile of cases) {
      const { root, anchor } = await installedRoot(`legacy-v1-${hostile.label.replace(" ", "-")}`);
      writeLegacySlotManifest(root, anchor);
      hostile.tamper(root, anchor);
      const observed = await inspectedFault(root);
      expect(observed.verified, hostile.label).toBe(false);
      expect(observed.code, hostile.label).toBe(hostile.code);
      expect(observed.layer, hostile.label).toBe("RECOVERY_ANCHOR");
    }
  });

  it("does not reinterpret a digest-bearing manifest as genuine /1", async () => {
    const { root, anchor } = await installedRoot("digest-bearing-v1");
    const stored = readSlotManifest(root, anchor.currentSlot);
    writeFileSync(
      slotManifestPath(root, anchor.currentSlot),
      JSON.stringify({ ...stored, slotManifestVersion: LEGACY_RECOVERY_SLOT_MANIFEST_VERSION }),
    );

    const observed = await inspectedFault(root);
    expect(observed.verified).toBe(false);
    expect(observed.code).toBe("RECOVERY_ANCHOR_PERSISTENCE_UNPROVEN");
    expect(observed.layer).toBe("RECOVERY_ANCHOR");
  });

  it.each(["", "A".repeat(64), "0".repeat(63), "g".repeat(64)])(
    "refuses a /2 database digest that is not lowercase sha256: %j",
    async (databaseDigest) => {
      const { root, anchor } = await installedRoot(`malformed-v2-${databaseDigest.length}`);
      const stored = readSlotManifest(root, anchor.currentSlot);
      writeFileSync(
        slotManifestPath(root, anchor.currentSlot),
        JSON.stringify({
          ...stored,
          databaseDigest,
          slotManifestVersion: RECOVERY_SLOT_MANIFEST_VERSION,
        }),
      );

      const observed = await inspectedFault(root);
      expect(observed.verified).toBe(false);
      expect(observed.code).toBe("RECOVERY_ANCHOR_PERSISTENCE_UNPROVEN");
      expect(observed.layer).toBe("RECOVERY_ANCHOR");
    },
  );

  it("reports unverifiable bytes for a well-formed /2 digest that disagrees with the database", async () => {
    const { root, anchor } = await installedRoot("mismatched-v2");
    const stored = readSlotManifest(root, anchor.currentSlot);
    writeFileSync(
      slotManifestPath(root, anchor.currentSlot),
      JSON.stringify({
        ...stored,
        databaseDigest: "0".repeat(64),
        slotManifestVersion: RECOVERY_SLOT_MANIFEST_VERSION,
      }),
    );

    const observed = await inspectedFault(root);
    expect(observed.verified).toBe(false);
    expect(observed.code).toBe("RECOVERY_ANCHOR_SLOT_UNVERIFIABLE");
    expect(observed.layer).toBe("RECOVERY_ANCHOR");
  });

  it("keeps the anchor-selected /1 slot live when a /2 install crashes before the switch", async () => {
    const root = temporaryDirectory("mixed-slot-switch");
    const first = await installRecoveryAnchor(request(root));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    writeLegacySlotManifest(root, first.anchor);

    const second = {
      incarnationRef: "2b".repeat(32),
      keyEpochRef: "5e".repeat(32),
      restoreCommandId: "restore-command-mixed-v2",
    };
    await expect(
      installRecoveryAnchor(
        request(root, {
          ...second,
          injectFault: (point: string) => {
            if (point === "SWITCH") throw new Error("injected fault at SWITCH");
          },
        }),
      ),
    ).rejects.toThrow("injected fault at SWITCH");

    const midWindow = await inspectRecoveryAnchor(root);
    expect(midWindow.ok).toBe(true);
    if (!midWindow.ok || midWindow.outcome !== "INSPECTED") throw new Error("expected INSPECTED");
    expect(midWindow.anchor.currentSlot).toBe(first.anchor.currentSlot);
    expect(midWindow.anchor.targetSlot).not.toBe(midWindow.anchor.currentSlot);
    expect(midWindow.slotVerified).toBe(true);
    expect(readSlotManifest(root, midWindow.anchor.currentSlot)["slotManifestVersion"]).toBe(
      LEGACY_RECOVERY_SLOT_MANIFEST_VERSION,
    );
    expect(readSlotManifest(root, midWindow.anchor.targetSlot)["slotManifestVersion"]).toBe(
      RECOVERY_SLOT_MANIFEST_VERSION,
    );

    const resumed = await installRecoveryAnchor(request(root, second));
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error("unreachable");
    expect(resumed.anchor.currentSlot).toBe(midWindow.anchor.targetSlot);
    expect((await inspectedFault(root)).verified).toBe(true);
  });
});

describe("recovery anchor fails closed on an unreadable anchor file", () => {
  /**
   * The anchor still EXISTS but readFile faults — the file is replaced with a
   * directory, the cross-platform stand-in for EACCES/EBUSY/EIO. Missing and
   * unreadable must not collapse into one answer: absent means "no anchor",
   * while unreadable proves nothing about which slot is live, and a prepare
   * that read it as absent would aim the next install at the LIVE slot.
   */
  async function unreadableAnchorRoot(label: string): Promise<string> {
    const { root } = await installedRoot(label);
    const path = join(root, RECOVERY_ANCHOR_FILE_NAME);
    unlinkSync(path);
    mkdirSync(path);
    return root;
  }

  it("refuses to prepare a new restore rather than treating the anchor as absent", async () => {
    const root = await unreadableAnchorRoot("unreadable-prepare");
    // A request that WOULD legitimately prepare (fresh command, fresh fence)
    // were the stored anchor readable, so only the read fault can refuse it.
    const result = await prepareRecoveryAnchor(
      request(root, {
        incarnationRef: "2b".repeat(32),
        keyEpochRef: "5e".repeat(32),
        restoreCommandId: "restore-command-after-fault",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("RECOVERY_ANCHOR_UNREADABLE");
    expect(result.layer).toBe("RECOVERY_ANCHOR");
  });

  it("refuses to discard rather than answering ABSENT", async () => {
    const root = await unreadableAnchorRoot("unreadable-discard");
    const result = await discardRecoveryAnchor(root);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("RECOVERY_ANCHOR_UNREADABLE");
  });

  it("refuses to inspect rather than answering ABSENT", async () => {
    const root = await unreadableAnchorRoot("unreadable-inspect");
    const result = await inspectRecoveryAnchor(root);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("RECOVERY_ANCHOR_UNREADABLE");
  });
});

describe("recovery anchor refuses a slot that is whole but wrong", () => {
  it("refuses an INSTALLED anchor whose current slot holds another generation", async () => {
    const root = temporaryDirectory("wrongslot");
    const first = await installRecoveryAnchor(request(root));
    if (!first.ok) throw new Error("first install refused");
    const second = await installRecoveryAnchor(
      request(root, {
        incarnationRef: "2b".repeat(32),
        keyEpochRef: "5e".repeat(32),
        restoreCommandId: "restore-command-second",
      }),
    );
    if (!second.ok) throw new Error("second install refused");

    // Overwrite the live slot with the OTHER generation, wholesale. The slot
    // stays internally consistent — manifest, artifacts and stamped database
    // all agree — so every within-slot check still passes. Only the anchor
    // knows this is not the generation it selected. This is the observable
    // shape of two installs racing on one anchor root.
    const live = join(root, RECOVERY_ANCHOR_SLOTS_DIR_NAME, second.anchor.currentSlot);
    const displaced = join(root, RECOVERY_ANCHOR_SLOTS_DIR_NAME, first.anchor.currentSlot);
    rmSync(live, { force: true, recursive: true });
    cpSync(displaced, live, { recursive: true });

    const observed = await inspectedFault(root);
    expect(observed.verified).toBe(false);
    expect(observed.code).toBe("RECOVERY_ANCHOR_DATABASE_MISMATCH");
  });
});

describe("recovery anchor refuses a malformed request", () => {
  const MALFORMED = [
    ["a missing restore command", { restoreCommandId: "" }],
    ["a path escaping its slot", { payload: { artifacts: [{ bytes: encoder.encode("x"), logicalPath: "../escape.bin" }], databaseBytes: restoredDatabaseBytes() } }],
    ["a backslash path that collides with its forward-slash twin on win32", { payload: { artifacts: [{ bytes: encoder.encode("x"), logicalPath: BACKSLASH_PATH }], databaseBytes: restoredDatabaseBytes() } }],
    ["an absolute artifact path", { payload: { artifacts: [{ bytes: encoder.encode("x"), logicalPath: "/etc/passwd" }], databaseBytes: restoredDatabaseBytes() } }],
    ["a fence whose halves are the same value", { incarnationRef: KEY_EPOCH_REF }],
    ["an empty restored database", { payload: { artifacts: [], databaseBytes: new Uint8Array() } }],
  ] as const;

  it.each(MALFORMED)("refuses %s", async (_label, overrides) => {
    const result = await installRecoveryAnchor(
      request(temporaryDirectory("malformed"), overrides as Record<string, unknown>),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("RECOVERY_ANCHOR_REQUEST_INVALID");
    expect(result.layer).toBe("RECOVERY_ANCHOR");
  });

  it("refuses two artifacts claiming the same logical path", async () => {
    const bytes = encoder.encode("collide");
    const result = await installRecoveryAnchor(
      request(temporaryDirectory("duplicate"), {
        payload: {
          artifacts: [
            { bytes, logicalPath: "artifacts/one.bin" },
            { bytes, logicalPath: "artifacts/one.bin" },
          ],
          databaseBytes: restoredDatabaseBytes(),
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // One would silently overwrite the other and still verify, because only the
    // survivor is ever read back.
    expect(result.code).toBe("RECOVERY_ANCHOR_REQUEST_INVALID");
  });
});

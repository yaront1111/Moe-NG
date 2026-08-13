/**
 * DoD 4's refusal surface: anchor, database, command and incarnation mismatch,
 * absent persistence proof, and unverifiable inactive bytes. Each must answer
 * with its OWN stable code at layer RECOVERY_ANCHOR, so a test can say which
 * fault was found rather than only that something was wrong.
 */
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

async function refusedInspect(root: string): Promise<{ code: string; layer: string }> {
  const result = await inspectRecoveryAnchor(root);
  expect(result.ok, "expected the inspection to refuse").toBe(false);
  if (result.ok) throw new Error("unreachable");
  return { code: result.code, layer: result.layer };
}

async function inspectedFault(root: string): Promise<{ code: string; verified: boolean }> {
  const result = await inspectRecoveryAnchor(root);
  if (!result.ok || result.outcome !== "INSPECTED") throw new Error("expected INSPECTED");
  return { code: result.mutatingOpenRefusal.code, verified: result.slotVerified };
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
  });

  it("reports absent persistence proof when the slot database is gone", async () => {
    const { root, anchor } = await installedRoot("nodb");
    unlinkSync(join(currentSlotPath(root, anchor), RECOVERY_ANCHOR_DATABASE_NAME));

    const observed = await inspectedFault(root);
    expect(observed.verified).toBe(false);
    expect(observed.code).toBe("RECOVERY_ANCHOR_PERSISTENCE_UNPROVEN");
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

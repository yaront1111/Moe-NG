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

/**
 * The frozen pre-PR /1 bytes. Read at runtime through a URL so the fixture
 * stays out of the src tree, the same form the codec unit test uses.
 */
const LEGACY_FIXTURE_PATH = new URL(
  "../test-fixtures/recovery-slot-manifest-v1.json",
  import.meta.url,
);

function legacyFixtureShape(): Record<string, unknown> {
  return JSON.parse(readFileSync(LEGACY_FIXTURE_PATH, "utf8")) as Record<string, unknown>;
}

/**
 * The historical /1 shape is DERIVED from the frozen fixture, never
 * reimplemented here: the fixture's own key order is walked and only the
 * value-bearing keys are swapped for this anchor's live values, so
 * `slotManifestVersion` reaches the slot as the byte string the pre-PR writer
 * actually emitted rather than as whatever the live constant now says. A
 * fixture key with no substitution is dropped rather than invented, which is
 * what makes the key-set equality assertion below able to see the drift.
 */
function writeLegacySlotManifest(
  root: string,
  anchor: RecoveryAnchorRecord,
  slot: string = anchor.currentSlot,
): void {
  const live: Readonly<Record<string, unknown>> = {
    generationDigest: anchor.generationDigest,
    incarnationRef: anchor.incarnationRef,
    keyEpochRef: anchor.keyEpochRef,
    payloadDigests: anchor.payloadDigests,
  };
  const fixture = legacyFixtureShape();
  // Null-prototype target and `Object.hasOwn`, not `{}` and `in`: a frozen key
  // named `constructor` or `__proto__` would otherwise resolve up the prototype
  // chain instead of being reported as uncovered.
  const manifest: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(fixture)) {
    if (key === "slotManifestVersion") {
      manifest[key] = fixture[key];
    } else if (Object.hasOwn(live, key)) {
      manifest[key] = live[key];
    }
  }
  writeFileSync(slotManifestPath(root, slot), JSON.stringify(manifest));
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

    /**
     * The bytes the installer is about to read carry the FROZEN pre-PR key
     * set, key for key in both directions, so this arm cannot drift into
     * proving that a shape invented here installs. Asserted BEFORE the inspect
     * on purpose: a dropped or renamed key also makes the manifest unreadable,
     * and that refusal would otherwise mask the drift that caused it.
     */
    const written = readSlotManifest(root, anchor.currentSlot);
    const fixture = legacyFixtureShape();
    expect(Object.keys(written).sort()).toEqual(Object.keys(fixture).sort());
    // Frozen bytes and live constant must still agree on the version string.
    expect(written["slotManifestVersion"]).toBe(fixture["slotManifestVersion"]);
    expect(written["slotManifestVersion"]).toBe(LEGACY_RECOVERY_SLOT_MANIFEST_VERSION);

    const observed = await inspectedFault(root);
    expect(observed.verified).toBe(true);
    expect(observed.code).toBe("RECOVERY_ANCHOR_RECOVERY_REQUIRED");
  });

  /**
   * A DIVERGENCE arm, not a reaching one: both halves run on the SAME root,
   * over the SAME empty payloadDigests map and the SAME restored database
   * bytes. The only byte that differs between them is the `slotManifestVersion`
   * string, so nothing but the version gate can change the outcome. /2 may
   * represent a database-only restore because its databaseDigest covers the
   * required payload directly; /1 had no database-byte authority, so its
   * artifact proof was mandatory.
   *
   * WHICH production mechanism emits the /1 refusal is a REDUNDANT PAIR, and
   * that is a measured finding rather than the single clause it looks like:
   *   - `readLegacy` (recovery-slot-manifest.ts:168) passes requirePayload=true
   *     into `readCommon`, so the codec already refuses an empty-payload /1
   *     manifest and `verifySlot` answers PERSISTENCE_UNPROVEN on the null
   *     decode at recovery-anchor-install.ts:160;
   *   - the later clause at recovery-anchor-install.ts:182
   *     (`decoded.kind === "LEGACY_V1" && entries.length === 0`) emits the SAME
   *     code at the SAME layer, and is unreachable through the public codec
   *     because a decoded LEGACY_V1 manifest can never carry an empty map.
   * No constructible input isolates either fence, so loosening exactly one
   * leaves this arm green. The redundant clause is kept rather than deleted —
   * deleting it would read as "no guard needed" — and this arm's mutation
   * drill mutates BOTH fences together.
   */
  it("refuses an empty-payload slot as /1 while accepting the same slot as /2", async () => {
    const root = temporaryDirectory("empty-payload-version-gate");
    const installed = await installRecoveryAnchor(
      request(root, { payload: { artifacts: [], databaseBytes: restoredDatabaseBytes() } }),
    );
    expect(
      installed.ok,
      installed.ok ? "installed" : `${installed.layer}/${installed.code}`,
    ).toBe(true);
    if (!installed.ok) throw new Error("unreachable");
    expect(Object.keys(installed.anchor.payloadDigests)).toEqual([]);

    // The /2 half runs FIRST, on the bytes the installer itself wrote.
    expect(readSlotManifest(root, installed.anchor.currentSlot)["slotManifestVersion"]).toBe(
      RECOVERY_SLOT_MANIFEST_VERSION,
    );
    const asDigestBound = await inspectedFault(root);
    expect(asDigestBound.verified).toBe(true);
    expect(asDigestBound.code).toBe("RECOVERY_ANCHOR_RECOVERY_REQUIRED");

    // The /1 half rewrites that same slot as a genuine historical manifest:
    // no databaseDigest, the same empty proof table, the same database file.
    writeLegacySlotManifest(root, installed.anchor);
    const rewritten = readSlotManifest(root, installed.anchor.currentSlot);
    expect(rewritten["slotManifestVersion"]).toBe(LEGACY_RECOVERY_SLOT_MANIFEST_VERSION);
    expect(rewritten["payloadDigests"]).toEqual({});
    expect("databaseDigest" in rewritten).toBe(false);

    const asLegacy = await inspectedFault(root);
    expect(asLegacy.verified).toBe(false);
    expect(asLegacy.code).toBe("RECOVERY_ANCHOR_PERSISTENCE_UNPROVEN");
    expect(asLegacy.layer).toBe("RECOVERY_ANCHOR");
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

    const staged = await inspectRecoveryAnchor(root);
    expect(staged.ok).toBe(true);
    if (!staged.ok || staged.outcome !== "INSPECTED") throw new Error("expected INSPECTED");
    /**
     * Corrupt the staged TARGET database so the inactive slot cannot verify.
     * Without this the target verifies too, and the arm cannot tell an anchor-
     * driven selection from a reader that simply reached for the other slot:
     * both answer slotVerified true. The resume below rewrites this file, so
     * the crash-safety half of the arm is unaffected.
     */
    writeFileSync(
      join(
        root,
        RECOVERY_ANCHOR_SLOTS_DIR_NAME,
        staged.anchor.targetSlot,
        RECOVERY_ANCHOR_DATABASE_NAME,
      ),
      "not the restored database",
    );

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

  /**
   * The mirror of the arm above, versions swapped, so DoD 4's determinism is
   * proven in BOTH directions: a "prefer whichever slot carries /1" selection
   * bug is invisible to the /1-current case alone, and a "prefer /2" bug is
   * invisible to this one alone.
   *
   * The stale /1 manifest planted in the TARGET slot deliberately carries the
   * FIRST install's incarnationRef while the bytes staged there are bound to
   * the SECOND install's, so that slot cannot verify. That is what makes the
   * arm sensitive to selection at all: a reader that followed the manifest
   * version, or simply reached for the inactive slot, would report an
   * unverified anchor instead of the healthy /2 one the record names.
   */
  it("keeps the anchor-selected /2 slot live when a /1-manifest target is staged", async () => {
    const root = temporaryDirectory("mixed-slot-switch-mirror");
    const first = await installRecoveryAnchor(request(root));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    // The current slot is left exactly as the installer wrote it: /2.
    expect(readSlotManifest(root, first.anchor.currentSlot)["slotManifestVersion"]).toBe(
      RECOVERY_SLOT_MANIFEST_VERSION,
    );

    const second = {
      incarnationRef: "3c".repeat(32),
      keyEpochRef: "6f".repeat(32),
      restoreCommandId: "restore-command-mixed-mirror",
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
    // Plant the stale /1 manifest on the TARGET slot, not the current one.
    writeLegacySlotManifest(root, first.anchor, midWindow.anchor.targetSlot);

    const reinspected = await inspectRecoveryAnchor(root);
    expect(reinspected.ok).toBe(true);
    if (!reinspected.ok || reinspected.outcome !== "INSPECTED") throw new Error("expected INSPECTED");
    expect(reinspected.anchor.currentSlot).toBe(first.anchor.currentSlot);
    expect(reinspected.anchor.targetSlot).not.toBe(reinspected.anchor.currentSlot);
    expect(reinspected.slotVerified).toBe(true);
    expect(readSlotManifest(root, reinspected.anchor.currentSlot)["slotManifestVersion"]).toBe(
      RECOVERY_SLOT_MANIFEST_VERSION,
    );
    expect(readSlotManifest(root, reinspected.anchor.targetSlot)["slotManifestVersion"]).toBe(
      LEGACY_RECOVERY_SLOT_MANIFEST_VERSION,
    );

    const resumed = await installRecoveryAnchor(request(root, second));
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error("unreachable");
    expect(resumed.anchor.currentSlot).toBe(reinspected.anchor.targetSlot);
    expect(readSlotManifest(root, resumed.anchor.currentSlot)["slotManifestVersion"]).toBe(
      RECOVERY_SLOT_MANIFEST_VERSION,
    );
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

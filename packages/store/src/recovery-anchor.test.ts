import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteEventStore } from "./index.js";
import {
  RECOVERY_BINDING_SLOTS,
  RECOVERY_INSTALL_REASON_CODES,
} from "./recovery-install-contracts.js";
import {
  RECOVERY_ANCHOR_CODEC_VERSION,
  RECOVERY_ANCHOR_DATABASE_NAME,
  RECOVERY_ANCHOR_FAULT_POINTS,
  RECOVERY_ANCHOR_FILE_NAME,
  RECOVERY_ANCHOR_LAYER,
  RECOVERY_ANCHOR_REASON_CODES,
  RECOVERY_ANCHOR_SLOTS_DIR_NAME,
  RECOVERY_ANCHOR_SLOT_MANIFEST_NAME,
  RECOVERY_ANCHOR_STATES,
} from "./recovery-anchor-contracts.js";
import type {
  RecoveryAnchorInstallResult,
  RecoveryAnchorPrepareResult,
  RecoveryAnchorRecord,
  RecoveryBindingSlotName,
} from "./recovery-anchor-contracts.js";
import { publishFileAtomically } from "./recovery-anchor-fs.js";
import {
  discardRecoveryAnchor,
  inspectRecoveryAnchor,
  installRecoveryAnchor,
  prepareRecoveryAnchor,
  resumeRecoveryAnchor,
  selectInactiveSlot,
} from "./recovery-anchor.js";

const encoder = new TextEncoder();
const GENERATION_DIGEST = "aa".repeat(32);
const OTHER_GENERATION_DIGEST = "bb".repeat(32);
const INCARNATION_REF = "1a".repeat(32);
const OTHER_INCARNATION_REF = "2b".repeat(32);
const KEY_EPOCH_REF = "4d".repeat(32);
const OTHER_KEY_EPOCH_REF = "5e".repeat(32);
const RESTORE_COMMAND_ID = "restore-command-alpha";
const PREPARED_AT = "2026-08-11T09:00:00.000Z";
const PROJECT_ID = "recovery-anchor-project";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function anchorRoot(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `moe-recovery-anchor-${label}-`));
  directories.push(directory);
  return directory;
}

/**
 * A real restored database. The installer opens what it writes and runs the
 * landed install transaction against it, so these bytes have to be a genuine
 * bootstrapped store rather than a marker string.
 */
function restoredDatabaseBytes(): Uint8Array {
  const directory = mkdtempSync(join(tmpdir(), "moe-recovery-anchor-source-"));
  directories.push(directory);
  const path = join(directory, "restored.sqlite");
  SqliteEventStore.openForProject(path, PROJECT_ID).close();
  return readFileSync(path);
}

/**
 * The restored payload the installer writes into the inactive slot. Artifact
 * bytes carry a generation marker so a slot holding two generations at once is
 * detectable; the database carries its generation as the incarnation the
 * install transaction stamps into it.
 */
function payload(marker: string): Record<string, unknown> {
  return {
    artifacts: [
      { bytes: encoder.encode(`artifact-one-${marker}`), logicalPath: "artifacts/one.bin" },
      { bytes: encoder.encode(`artifact-two-${marker}`), logicalPath: "artifacts/nested/two.bin" },
    ],
    databaseBytes: restoredDatabaseBytes(),
  };
}

function request(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    anchorRoot: anchorRoot("request"),
    generationDigest: GENERATION_DIGEST,
    incarnationRef: INCARNATION_REF,
    keyEpochRef: KEY_EPOCH_REF,
    payload: payload("base"),
    preparedAt: PREPARED_AT,
    projectId: PROJECT_ID,
    restoreCommandId: RESTORE_COMMAND_ID,
    ...overrides,
  };
}

function prepared(result: RecoveryAnchorPrepareResult): RecoveryAnchorRecord {
  expect(result.ok, result.ok ? "prepared" : `${result.layer}/${result.code}`).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.outcome).toBe("PREPARED");
  return result.anchor;
}

function installedAnchor(result: RecoveryAnchorInstallResult): RecoveryAnchorRecord {
  expect(result.ok, result.ok ? "installed" : `${result.layer}/${result.code}`).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.outcome).toBe("INSTALLED");
  return result.anchor;
}

/**
 * A second restore over an existing anchor. A new command for the same
 * generation MUST carry a fresh incarnation and key epoch (DoD 5), so every
 * follow-on install in these tests rotates both rather than reusing the fence.
 */
function secondInstall(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return request({
    incarnationRef: OTHER_INCARNATION_REF,
    keyEpochRef: OTHER_KEY_EPOCH_REF,
    restoreCommandId: "restore-command-second",
    ...overrides,
  });
}

/**
 * The generation markers carried by a slot's ARTIFACTS. The database is
 * excluded deliberately — it is real SQLite and carries its generation as the
 * stamped incarnation instead, asserted separately by `slotIncarnation`.
 * A slot answering with more than one marker is the mixed state DoD 3 forbids.
 */
function markersIn(root: string, slot: RecoveryBindingSlotName): Set<string> {
  const slotRoot = join(root, RECOVERY_ANCHOR_SLOTS_DIR_NAME, slot);
  const markers = new Set<string>();
  let artifacts = 0;
  for (const [path, bytes] of walkFiles(slotRoot)) {
    if (path.endsWith(".sqlite") || path.endsWith(RECOVERY_ANCHOR_SLOT_MANIFEST_NAME)) continue;
    artifacts += 1;
    const matched = /-(gen\d+)$/u.exec(bytes.toString("utf8"));
    if (matched === null) throw new Error(`slot artifact ${path} carries no generation marker`);
    markers.add(matched[1] as string);
  }
  // A slot that lost its artifacts would otherwise answer with an empty set and
  // compare equal to nothing, which reads as a pass.
  expect(artifacts, `slot ${slot} holds no artifacts`).toBe(2);
  return markers;
}

/** The incarnation the install transaction stamped into a slot's database. */
function slotIncarnation(root: string, slot: RecoveryBindingSlotName): string | null {
  const path = join(root, RECOVERY_ANCHOR_SLOTS_DIR_NAME, slot, RECOVERY_ANCHOR_DATABASE_NAME);
  const store = SqliteEventStore.openForProject(path, PROJECT_ID);
  try {
    const read = store.readRecoveryBinding(RECOVERY_BINDING_SLOTS[0]);
    if (!read.ok) throw new Error(`slot ${slot} database refused: ${read.code}`);
    return read.outcome === "FOUND" ? read.binding.incarnationRef : null;
  } finally {
    store.close();
  }
}

/** Every file under `root`, as [path relative to root, bytes]. */
function walkFiles(root: string, base = root): readonly (readonly [string, Buffer])[] {
  const found: (readonly [string, Buffer])[] = [];
  for (const entry of readdirSync(root)) {
    const absolute = join(root, entry);
    if (statSync(absolute).isDirectory()) {
      found.push(...walkFiles(absolute, base));
    } else {
      found.push([relative(base, absolute).split(sep).join("/"), readFileSync(absolute)] as const);
    }
  }
  return found;
}

describe("recovery anchor record and slot selection", () => {
  it("prepares one versioned record bound to command, generation, incarnation and key epoch", async () => {
    const anchor = prepared(await prepareRecoveryAnchor(request()));

    expect(anchor.anchorCodecVersion).toBe(RECOVERY_ANCHOR_CODEC_VERSION);
    expect(anchor.state).toBe("PREPARED");
    expect(RECOVERY_ANCHOR_STATES).toContain(anchor.state);
    expect(anchor.restoreCommandId).toBe(RESTORE_COMMAND_ID);
    expect(anchor.generationDigest).toBe(GENERATION_DIGEST);
    expect(anchor.incarnationRef).toBe(INCARNATION_REF);
    expect(anchor.keyEpochRef).toBe(KEY_EPOCH_REF);
    expect(anchor.preparedAt).toBe(PREPARED_AT);
    // taskRail 2: recorded as selection metadata, never enacted by the store.
    expect(anchor.restoredAuthorityRevoked).toBe(true);
    expect(anchor.restoredLifecycle).toBe("QUIESCED");
    expect(anchor.restoredReadiness).toBe("RECOVERY_REQUIRED");
  });

  it("names both slots from RECOVERY_BINDING_SLOTS and targets the inactive one", async () => {
    const anchor = prepared(await prepareRecoveryAnchor(request()));

    expect(RECOVERY_BINDING_SLOTS).toContain(anchor.currentSlot);
    expect(RECOVERY_BINDING_SLOTS).toContain(anchor.targetSlot);
    expect(anchor.targetSlot).not.toBe(anchor.currentSlot);
    // With no prior anchor the first declared slot is current, so the first
    // install writes the second — never the slot a fresh reader would open.
    expect(anchor.currentSlot).toBe(RECOVERY_BINDING_SLOTS[0]);
    expect(anchor.targetSlot).toBe(RECOVERY_BINDING_SLOTS[1]);
  });

  it("selects the other slot for every declared slot, and never the one given", () => {
    expect(RECOVERY_BINDING_SLOTS.length).toBe(2);
    for (const slot of RECOVERY_BINDING_SLOTS) {
      const inactive = selectInactiveSlot(slot);
      expect(inactive).not.toBe(slot);
      expect(RECOVERY_BINDING_SLOTS).toContain(inactive);
      expect(selectInactiveSlot(inactive)).toBe(slot);
    }
  });

  it("alternates the target slot after an install has switched the current slot", async () => {
    const root = anchorRoot("alternates");
    const first = installedAnchor(
      await installRecoveryAnchor(request({ anchorRoot: root, payload: payload("first") })),
    );
    expect(first.currentSlot).toBe(RECOVERY_BINDING_SLOTS[1]);

    const second = prepared(
      await prepareRecoveryAnchor(
        request({
          anchorRoot: root,
          incarnationRef: OTHER_INCARNATION_REF,
          keyEpochRef: OTHER_KEY_EPOCH_REF,
          restoreCommandId: "restore-command-beta",
        }),
      ),
    );
    expect(second.currentSlot).toBe(RECOVERY_BINDING_SLOTS[1]);
    expect(second.targetSlot).toBe(RECOVERY_BINDING_SLOTS[0]);
  });
});

describe("recovery anchor identity", () => {
  // Hand-written on purpose. A sweep derived from Object.keys(anchor) would
  // shrink silently with the record and still report every case as covered.
  const IDENTITY_BOUND_FIELDS = [
    "generationDigest",
    "incarnationRef",
    "keyEpochRef",
    "preparedAt",
    "restoreCommandId",
  ] as const;

  const PERTURBATIONS: Readonly<Record<(typeof IDENTITY_BOUND_FIELDS)[number], unknown>> = {
    generationDigest: OTHER_GENERATION_DIGEST,
    incarnationRef: OTHER_INCARNATION_REF,
    keyEpochRef: OTHER_KEY_EPOCH_REF,
    preparedAt: "2026-08-11T10:30:00.000Z",
    restoreCommandId: "restore-command-gamma",
  };

  it("declares a perturbation for exactly the fields the identity binds", () => {
    expect(IDENTITY_BOUND_FIELDS.length).toBe(5);
    expect(Object.keys(PERTURBATIONS).sort()).toEqual([...IDENTITY_BOUND_FIELDS].sort());
  });

  it.each(IDENTITY_BOUND_FIELDS)("changes the anchor identity when %s is perturbed", async (field) => {
    const baseline = prepared(await prepareRecoveryAnchor(request()));
    const perturbed = prepared(
      await prepareRecoveryAnchor(request({ [field]: PERTURBATIONS[field] })),
    );

    expect(perturbed[field]).not.toBe(baseline[field]);
    expect(perturbed.preparedIdentity).not.toBe(baseline.preparedIdentity);
    expect(perturbed.anchorDigest).not.toBe(baseline.anchorDigest);
  });

  it("reproduces the identical identity for an identical request", async () => {
    const baseline = prepared(await prepareRecoveryAnchor(request()));
    const repeated = prepared(await prepareRecoveryAnchor(request()));

    expect(repeated.preparedIdentity).toBe(baseline.preparedIdentity);
    expect(repeated.anchorDigest).toBe(baseline.anchorDigest);
  });

  it("distinguishes the installed record from the prepared one it grew from", async () => {
    const root = anchorRoot("state-identity");
    const preparedRecord = prepared(
      await prepareRecoveryAnchor(request({ anchorRoot: root })),
    );
    const installed = installedAnchor(
      await installRecoveryAnchor(request({ anchorRoot: root })),
    );

    // The fence survives the transition; the record's own identity does not.
    expect(installed.preparedIdentity).toBe(preparedRecord.preparedIdentity);
    expect(installed.anchorDigest).not.toBe(preparedRecord.anchorDigest);
    expect(installed.state).toBe("INSTALLED");
  });
});

describe("recovery anchor exclusion from the restored payload", () => {
  it("keeps the anchor record outside every slot it selects", async () => {
    const root = anchorRoot("exclusion");
    const anchor = installedAnchor(
      await installRecoveryAnchor(request({ anchorRoot: root, payload: payload("excl") })),
    );

    const slotsRoot = join(root, RECOVERY_ANCHOR_SLOTS_DIR_NAME);
    const slotFiles = walkFiles(slotsRoot);
    expect(slotFiles.length).toBeGreaterThan(0);

    // POSITIVE CONTROL: the identity really is findable as bytes, so the absence
    // assertion below is measuring exclusion rather than an unsearchable value.
    const anchorFile = readFileSync(join(root, RECOVERY_ANCHOR_FILE_NAME));
    expect(anchorFile.includes(anchor.preparedIdentity)).toBe(true);

    for (const [path, bytes] of slotFiles) {
      expect(bytes.includes(anchor.preparedIdentity), `${path} carries the anchor identity`).toBe(
        false,
      );
      expect(bytes.includes(anchor.anchorDigest), `${path} carries the anchor digest`).toBe(false);
      expect(path).not.toContain(RECOVERY_ANCHOR_FILE_NAME);
    }
  });

  it("publishes the anchor beside the slots directory rather than within it", async () => {
    const root = anchorRoot("layout");
    installedAnchor(await installRecoveryAnchor(request({ anchorRoot: root })));

    const anchorPath = join(root, RECOVERY_ANCHOR_FILE_NAME);
    expect(statSync(anchorPath).isFile()).toBe(true);
    expect(relative(join(root, RECOVERY_ANCHOR_SLOTS_DIR_NAME), anchorPath).startsWith("..")).toBe(
      true,
    );
  });
});

describe("recovery anchor install ordering", () => {
  it("crosses every declared boundary exactly once, in the declared order", async () => {
    const observed: string[] = [];
    installedAnchor(
      await installRecoveryAnchor(
        request({ injectFault: (point: string) => void observed.push(point) }),
      ),
    );

    // The ORDER is the crash-safety property, not the end state: an install
    // that reached INSTALLED by persisting after the switch would still end
    // with a correct-looking anchor.
    expect(observed).toEqual([...RECOVERY_ANCHOR_FAULT_POINTS]);
  });

  it("declares the eight boundaries DoD 3 names, without duplicates", () => {
    expect(RECOVERY_ANCHOR_FAULT_POINTS.length).toBe(8);
    expect(new Set(RECOVERY_ANCHOR_FAULT_POINTS).size).toBe(8);
    expect([...RECOVERY_ANCHOR_FAULT_POINTS]).toEqual([
      "PREPARE",
      "INACTIVE_INSTALL",
      "TRANSACTION",
      "FILE_FSYNC",
      "DIRECTORY_PERSISTENCE",
      "VERIFICATION",
      "SWITCH",
      "INSTALLED_MARKER",
    ]);
  });

  it("writes nothing into the current slot before the switch", async () => {
    const root = anchorRoot("untouched");
    installedAnchor(
      await installRecoveryAnchor(request({ anchorRoot: root, payload: payload("gen1") })),
    );
    const settled = installedAnchor(
      await installRecoveryAnchor(
        secondInstall({ anchorRoot: root, payload: payload("gen2") }),
      ),
    );

    // gen2 landed in the slot gen1 was NOT occupying, so a reader that never
    // saw the switch still had an intact gen1 underneath it the whole time.
    expect(settled.currentSlot).toBe(RECOVERY_BINDING_SLOTS[0]);
    expect(markersIn(root, settled.currentSlot)).toEqual(new Set(["gen2"]));
    expect(slotIncarnation(root, settled.currentSlot)).toBe(OTHER_INCARNATION_REF);
    const displaced = selectInactiveSlot(settled.currentSlot);
    expect(markersIn(root, displaced)).toEqual(new Set(["gen1"]));
    expect(slotIncarnation(root, displaced)).toBe(INCARNATION_REF);
  });
});

describe("recovery anchor failure injection", () => {
  /**
   * Hand-written, and the split is the assertion: every boundary up to and
   * including the switch must leave the PRIOR slot current, and only the
   * installed-marker boundary — which runs after the switch has landed — may
   * expose the newly restored one. A production reorder moves a row here.
   */
  const EXPECTED_AFTER_FAULT: Readonly<Record<string, "PRIOR" | "RESTORED">> = {
    DIRECTORY_PERSISTENCE: "PRIOR",
    FILE_FSYNC: "PRIOR",
    INACTIVE_INSTALL: "PRIOR",
    INSTALLED_MARKER: "RESTORED",
    PREPARE: "PRIOR",
    SWITCH: "PRIOR",
    TRANSACTION: "PRIOR",
    VERIFICATION: "PRIOR",
  };

  it("expects an outcome for exactly the declared boundaries", () => {
    expect(Object.keys(EXPECTED_AFTER_FAULT).sort()).toEqual(
      [...RECOVERY_ANCHOR_FAULT_POINTS].sort(),
    );
    expect(Object.values(EXPECTED_AFTER_FAULT).filter((v) => v === "RESTORED").length).toBe(1);
  });

  it.each(RECOVERY_ANCHOR_FAULT_POINTS)(
    "exposes one whole verified slot when the install dies at %s",
    async (point) => {
      const root = anchorRoot(`fault-${point}`);
      installedAnchor(
        await installRecoveryAnchor(request({ anchorRoot: root, payload: payload("gen1") })),
      );

      const crash = new Error(`injected fault at ${point}`);
      await expect(
        installRecoveryAnchor(
          secondInstall({
            anchorRoot: root,
            injectFault: (reached: string) => {
              if (reached === point) throw crash;
            },
            payload: payload("gen2"),
          }),
        ),
      ).rejects.toThrow(`injected fault at ${point}`);

      // A NEW reader, not the process that died: crash safety is what survives.
      const inspected = await inspectRecoveryAnchor(root);
      expect(inspected.ok, inspected.ok ? "inspected" : `${inspected.layer}/${inspected.code}`).toBe(
        true,
      );
      if (!inspected.ok || inspected.outcome !== "INSPECTED") {
        throw new Error(`expected INSPECTED, got ${inspected.outcome}`);
      }

      const prior = EXPECTED_AFTER_FAULT[point] === "PRIOR";
      expect(inspected.slotVerified).toBe(true);
      expect(markersIn(root, inspected.currentSlot)).toEqual(new Set([prior ? "gen1" : "gen2"]));
      // The stamped incarnation and the artifacts must name the SAME
      // generation: that pairing is what "never mixed slots" actually means.
      expect(slotIncarnation(root, inspected.currentSlot)).toBe(
        prior ? INCARNATION_REF : OTHER_INCARNATION_REF,
      );
      expect(inspected.anchor.currentSlot).toBe(inspected.currentSlot);
      // Never mutating authority: a half-finished restore stays quiesced.
      expect(inspected.anchor.restoredReadiness).toBe("RECOVERY_REQUIRED");
      expect(inspected.mutatingOpenAllowed).toBe(false);
      // The slot verified, so the anchor's refusal is the standing one rather
      // than a verification fault — a distinct, named code either way.
      expect(inspected.mutatingOpenRefusal.code).toBe("RECOVERY_ANCHOR_RECOVERY_REQUIRED");
      expect(inspected.mutatingOpenRefusal.layer).toBe(RECOVERY_ANCHOR_LAYER);
      expect([...inspected.allowedOperations].sort()).toEqual(["DISCARD", "INSPECT", "RESUME"]);
    },
  );
});

describe("recovery anchor fence and resume", () => {
  function refused(
    result: { readonly ok: boolean } & Partial<{ code: string; layer: string }>,
  ): { readonly code: string; readonly layer: string } {
    expect(result.ok, "expected a refusal").toBe(false);
    return { code: result.code as string, layer: result.layer as string };
  }

  it("reuses the prepared identity when the same command is prepared again", async () => {
    const root = anchorRoot("reprepare");
    const first = prepared(await prepareRecoveryAnchor(request({ anchorRoot: root })));
    const second = prepared(await prepareRecoveryAnchor(request({ anchorRoot: root })));

    expect(second.preparedIdentity).toBe(first.preparedIdentity);
    expect(second.anchorDigest).toBe(first.anchorDigest);
    // No second anchor: a fence that can be minted twice is a cache.
    expect(readdirSync(root).filter((entry) => entry === RECOVERY_ANCHOR_FILE_NAME).length).toBe(1);
  });

  it("does not downgrade a completed install when the same command is prepared again", async () => {
    const root = anchorRoot("prepare-settled");
    const live = installedAnchor(await installRecoveryAnchor(request({ anchorRoot: root })));

    // Rebuilding the record instead of returning the stored one would stamp
    // state PREPARED over a finished install and un-mark a completed recovery.
    const again = prepared(await prepareRecoveryAnchor(request({ anchorRoot: root })));
    expect(again.state).toBe("INSTALLED");
    expect(again.anchorDigest).toBe(live.anchorDigest);

    const inspected = await inspectRecoveryAnchor(root);
    if (!inspected.ok || inspected.outcome !== "INSPECTED") throw new Error("expected INSPECTED");
    expect(inspected.anchor.state).toBe("INSTALLED");
  });

  it("resumes a prepared command through to INSTALLED on the same identity", async () => {
    const root = anchorRoot("resume");
    const preparedRecord = prepared(await prepareRecoveryAnchor(request({ anchorRoot: root })));
    const resumed = installedAnchor(await resumeRecoveryAnchor(request({ anchorRoot: root })));

    expect(resumed.preparedIdentity).toBe(preparedRecord.preparedIdentity);
    expect(resumed.state).toBe("INSTALLED");
  });

  it("resumes repeatedly without minting a new identity", async () => {
    const root = anchorRoot("resume-twice");
    const first = installedAnchor(await resumeRecoveryAnchor(request({ anchorRoot: root })));
    const again = installedAnchor(await resumeRecoveryAnchor(request({ anchorRoot: root })));

    expect(again.preparedIdentity).toBe(first.preparedIdentity);
  });

  it("never re-enters the protocol against an install that already completed", async () => {
    const root = anchorRoot("resume-settled");
    const live = installedAnchor(await installRecoveryAnchor(request({ anchorRoot: root })));

    // After the switch currentSlot === targetSlot, so a resume that re-ran the
    // install would clear and rewrite the LIVE slot. Comparing markers cannot
    // see that — the rewrite lands the same bytes. A sentinel can: it only
    // survives if the slot was left alone.
    const sentinel = join(root, RECOVERY_ANCHOR_SLOTS_DIR_NAME, live.currentSlot, "sentinel.txt");
    writeFileSync(sentinel, "written between install and resume");

    installedAnchor(await resumeRecoveryAnchor(request({ anchorRoot: root })));
    expect(existsSync(sentinel)).toBe(true);
  });

  it("refuses to resume under a different restore command", async () => {
    const root = anchorRoot("resume-foreign");
    prepared(await prepareRecoveryAnchor(request({ anchorRoot: root })));

    const outcome = refused(
      await resumeRecoveryAnchor(
        request({
          anchorRoot: root,
          incarnationRef: OTHER_INCARNATION_REF,
          keyEpochRef: OTHER_KEY_EPOCH_REF,
          restoreCommandId: "restore-command-foreign",
        }),
      ),
    );
    expect(outcome.code).toBe("RECOVERY_ANCHOR_COMMAND_MISMATCH");
    // Pinned to the LITERAL, not to RECOVERY_ANCHOR_LAYER. Comparing production's
    // constant against itself is a tautology that survives any layer change.
    expect(outcome.layer).toBe("RECOVERY_ANCHOR");
  });

  // Each leg names which half of the fence is being reused, so a guard that
  // only checks the incarnation cannot pass the whole table.
  const REUSED_FENCE_LEGS = [
    ["both halves", INCARNATION_REF, KEY_EPOCH_REF],
    ["the incarnation alone", INCARNATION_REF, OTHER_KEY_EPOCH_REF],
    ["the key epoch alone", OTHER_INCARNATION_REF, KEY_EPOCH_REF],
  ] as const;

  it.each(REUSED_FENCE_LEGS)(
    "refuses a new command on the identical generation that reuses %s",
    async (_label, incarnationRef, keyEpochRef) => {
      const root = anchorRoot("fence");
      installedAnchor(await installRecoveryAnchor(request({ anchorRoot: root })));

      const outcome = refused(
        await prepareRecoveryAnchor(
          request({
            anchorRoot: root,
            incarnationRef,
            keyEpochRef,
            restoreCommandId: "restore-command-replay",
          }),
        ),
      );
      expect(outcome.code).toBe("RECOVERY_ANCHOR_INCARNATION_REUSED");
      expect(outcome.layer).toBe(RECOVERY_ANCHOR_LAYER);
      // Not the install layer's UNIQUE violation: no database was consulted.
      expect(RECOVERY_INSTALL_REASON_CODES).not.toContain(outcome.code);
    },
  );

  it("admits a new command on the identical generation with both halves fresh", async () => {
    const root = anchorRoot("fence-fresh");
    const first = installedAnchor(await installRecoveryAnchor(request({ anchorRoot: root })));
    const second = prepared(
      await prepareRecoveryAnchor(
        request({
          anchorRoot: root,
          incarnationRef: OTHER_INCARNATION_REF,
          keyEpochRef: OTHER_KEY_EPOCH_REF,
          restoreCommandId: "restore-command-fresh",
        }),
      ),
    );

    expect(second.generationDigest).toBe(first.generationDigest);
    expect(second.preparedIdentity).not.toBe(first.preparedIdentity);
  });
});

describe("recovery anchor discard", () => {
  it("clears the slot that is not current and leaves the live one verified", async () => {
    const root = anchorRoot("discard");
    installedAnchor(await installRecoveryAnchor(request({ anchorRoot: root, payload: payload("gen1") })));
    const live = installedAnchor(
      await installRecoveryAnchor(secondInstall({ anchorRoot: root, payload: payload("gen2") })),
    );

    const result = await discardRecoveryAnchor(root);
    expect(result.ok).toBe(true);
    if (!result.ok || result.outcome !== "DISCARDED") {
      throw new Error(`expected DISCARDED, got ${result.outcome}`);
    }
    expect(result.discardedSlot).toBe(selectInactiveSlot(live.currentSlot));

    const inspected = await inspectRecoveryAnchor(root);
    if (!inspected.ok || inspected.outcome !== "INSPECTED") throw new Error("expected INSPECTED");
    expect(inspected.currentSlot).toBe(live.currentSlot);
    expect(inspected.slotVerified).toBe(true);
    expect(markersIn(root, live.currentSlot)).toEqual(new Set(["gen2"]));
  });

  it("answers ABSENT for a root that carries no anchor", async () => {
    const result = await discardRecoveryAnchor(anchorRoot("discard-empty"));
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("ABSENT");
  });
});

describe("recovery anchor atomic publish", () => {
  it("leaves the previous bytes readable when the publish cannot complete", async () => {
    const root = anchorRoot("atomic");
    const target = join(root, "published.json");
    writeFileSync(target, "PREVIOUS");

    // Occupy the staging name with a DIRECTORY, so opening it for write fails
    // partway through the publish. A publish that wrote the final path directly
    // would already have destroyed PREVIOUS by the time it noticed.
    mkdirSync(`${target}.staging`);
    await expect(publishFileAtomically(target, encoder.encode("NEXT"))).rejects.toThrow();

    expect(readFileSync(target, "utf8")).toBe("PREVIOUS");
  });
});

describe("recovery anchor root publication", () => {
  const PUBLISHED = [
    "RECOVERY_ANCHOR_ALLOWED_OPERATIONS",
    "RECOVERY_ANCHOR_CODEC_VERSION",
    // Published by task-0c89476b (disaster restore proof, 4e0201a): the fault suite
    // tests/fault/disaster-restore/anchor-boundary-crash.fault.ts sweeps every fault
    // point off the root barrel; the producer moved the export but not this roster row.
    "RECOVERY_ANCHOR_FAULT_POINTS",
    "RECOVERY_ANCHOR_LAYER",
    "RECOVERY_ANCHOR_REASON_CODES",
    "RECOVERY_ANCHOR_STATES",
    "discardRecoveryAnchor",
    "inspectRecoveryAnchor",
    "installRecoveryAnchor",
    "prepareRecoveryAnchor",
    "resumeRecoveryAnchor",
    "selectInactiveSlot",
  ] as const;

  // Deliberately withheld: layout constants and the injection seam are internal.
  // A consumer passes an anchorRoot and lets this module own the layout.
  const WITHHELD = [
    "RECOVERY_ANCHOR_DATABASE_NAME",
    "RECOVERY_ANCHOR_FILE_NAME",
    "RECOVERY_ANCHOR_SLOTS_DIR_NAME",
    "RECOVERY_ANCHOR_SLOT_MANIFEST_NAME",
  ] as const;

  it("publishes exactly the anchor surface a restore controller composes", async () => {
    const root: Record<string, unknown> = await import("./index.js");
    for (const name of PUBLISHED) {
      expect(root[name], `${name} is not published`).toBeDefined();
    }
    // Negative control: without this, the assertion above passes for a barrel
    // that re-exported the whole module and published far more than intended.
    for (const name of WITHHELD) {
      expect(root[name], `${name} leaked onto the root`).toBeUndefined();
    }
  });
});

describe("recovery anchor vocabulary", () => {
  it("refuses at its own layer with codes distinct from the install layer's", () => {
    expect(RECOVERY_ANCHOR_LAYER).toBe("RECOVERY_ANCHOR");
    expect(RECOVERY_ANCHOR_REASON_CODES.length).toBeGreaterThan(0);
    for (const code of RECOVERY_ANCHOR_REASON_CODES) {
      expect(code.startsWith("RECOVERY_ANCHOR_")).toBe(true);
    }
    expect(new Set(RECOVERY_ANCHOR_REASON_CODES).size).toBe(RECOVERY_ANCHOR_REASON_CODES.length);
  });

  it("declares exactly the two states the protocol moves between", () => {
    expect([...RECOVERY_ANCHOR_STATES]).toEqual(["PREPARED", "INSTALLED"]);
  });
});

/**
 * REGISTER ITEM 2 — the post-switch, pre-marker window.
 *
 * runInstall publishes TWICE: the switch (`currentSlot := targetSlot`, state
 * still PREPARED) and then the INSTALLED marker. A crash between them leaves a
 * durable record that has SELECTED the restored slot without saying so.
 *
 * settledInstall recognised only `state === "INSTALLED"`, so that record fell
 * through to prepare + runInstall and RE-ENTERED the protocol — whose first two
 * steps write the database in `targetSlot`, which after the switch is the LIVE
 * slot. recovery-anchor.ts's own comment above settledInstall already forbids
 * exactly this: "re-entering the protocol would write the restored payload into
 * the slot that is now LIVE — the one thing this module exists to never do."
 * The guard was one condition short of covering the window it describes.
 *
 * THE HARM IS THAT THOSE STEPS RUN, not that the resulting bytes differ: a
 * re-entry that happens to succeed still ends with a correct-looking anchor.
 * So these tests observe the fault seam — which boundaries the second call
 * crossed — rather than inspecting disk content, which would pass either way.
 */
async function crashAfterSwitch(root: string): Promise<void> {
  const crash = new Error("injected fault at INSTALLED_MARKER");
  await expect(
    installRecoveryAnchor(
      request({
        anchorRoot: root,
        injectFault: (reached: string) => {
          if (reached === "INSTALLED_MARKER") throw crash;
        },
      }),
    ),
  ).rejects.toThrow("injected fault at INSTALLED_MARKER");
}

/** The boundaries whose re-execution is the actual defect. */
const PROTOCOL_REENTRY_POINTS = Object.freeze([
  "INACTIVE_INSTALL",
  "TRANSACTION",
  "FILE_FSYNC",
  "DIRECTORY_PERSISTENCE",
  "VERIFICATION",
  "SWITCH",
] as const);

describe("resume after the switch completes the marker instead of re-installing", () => {
  it("records the marker without crossing a single install boundary again", async () => {
    const root = anchorRoot("post-switch");
    await crashAfterSwitch(root);

    // The stored record is the window itself: switched, but unmarked.
    const midWindow = await inspectRecoveryAnchor(root);
    expect(midWindow.ok, midWindow.ok ? "inspected" : "refused").toBe(true);
    if (!midWindow.ok || midWindow.outcome !== "INSPECTED") {
      throw new Error("expected INSPECTED");
    }
    expect(midWindow.anchor.state).toBe("PREPARED");
    expect(midWindow.anchor.currentSlot).toBe(midWindow.anchor.targetSlot);

    const observed: string[] = [];
    const resumed = await installRecoveryAnchor(
      request({ anchorRoot: root, injectFault: (point: string) => void observed.push(point) }),
    );

    expect(resumed.ok, resumed.ok ? "resumed" : `${resumed.layer}/${resumed.code}`).toBe(true);
    if (!resumed.ok) throw new Error("unreachable");
    expect(resumed.outcome).toBe("INSTALLED");
    expect(resumed.anchor.state).toBe("INSTALLED");
    // Named one by one: an emptiness assertion alone would not say WHICH
    // boundary re-ran when this fails.
    for (const point of PROTOCOL_REENTRY_POINTS) {
      expect(observed, `boundary ${point} must not be crossed again`).not.toContain(point);
    }
    expect(observed).toEqual([]);
    // The switch is not re-made: the slot chosen before the crash is kept.
    expect(resumed.anchor.currentSlot).toBe(midWindow.anchor.currentSlot);
  });
});

describe("the post-switch arm does not swallow the cases around it", () => {
  it("still runs a full install when the crash landed BEFORE the switch", async () => {
    const root = anchorRoot("pre-switch");
    const crash = new Error("injected fault at SWITCH");
    await expect(
      installRecoveryAnchor(
        request({
          anchorRoot: root,
          injectFault: (reached: string) => {
            if (reached === "SWITCH") throw crash;
          },
        }),
      ),
    ).rejects.toThrow("injected fault at SWITCH");

    // The genuine pre-switch state: PREPARED, and current still names the OTHER
    // slot. A condition written one notch too broadly would mistake this for a
    // completed switch and skip a real install.
    const midWindow = await inspectRecoveryAnchor(root);
    if (!midWindow.ok || midWindow.outcome !== "INSPECTED") throw new Error("expected INSPECTED");
    expect(midWindow.anchor.state).toBe("PREPARED");
    expect(midWindow.anchor.currentSlot).not.toBe(midWindow.anchor.targetSlot);

    const observed: string[] = [];
    const resumed = await installRecoveryAnchor(
      request({ anchorRoot: root, injectFault: (point: string) => void observed.push(point) }),
    );
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error("unreachable");
    expect(resumed.outcome).toBe("INSTALLED");
    // The protocol MUST have run this time — the install was never completed.
    expect(observed).toEqual([...RECOVERY_ANCHOR_FAULT_POINTS]);
  });

  it("refuses a different command's fence over the post-switch window, by exact code and layer", async () => {
    const root = anchorRoot("post-switch-foreign");
    await crashAfterSwitch(root);

    // A DIFFERENT restore command reusing the incarnation the crashed one spent.
    // The new arm must not become a way to adopt another command's anchor.
    const refused = await installRecoveryAnchor(
      request({ anchorRoot: root, restoreCommandId: "restore-command-intruder" }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.code).toBe("RECOVERY_ANCHOR_INCARNATION_REUSED");
    expect(refused.layer).toBe(RECOVERY_ANCHOR_LAYER);

    // resumeRecoveryAnchor screens the same intruder one layer earlier, and the
    // two refusals are DIFFERENT codes — asserting only "refused" would let
    // either layer answer and never notice which one did.
    const resumeRefused = await resumeRecoveryAnchor(
      request({ anchorRoot: root, restoreCommandId: "restore-command-intruder" }),
    );
    expect(resumeRefused.ok).toBe(false);
    if (resumeRefused.ok) throw new Error("unreachable");
    expect(resumeRefused.code).toBe("RECOVERY_ANCHOR_COMMAND_MISMATCH");
    expect(resumeRefused.layer).toBe(RECOVERY_ANCHOR_LAYER);

    // And the window is untouched by the refusal: still unmarked, still ours.
    const after = await inspectRecoveryAnchor(root);
    if (!after.ok || after.outcome !== "INSPECTED") throw new Error("expected INSPECTED");
    expect(after.anchor.state).toBe("PREPARED");
    expect(after.anchor.restoreCommandId).toBe(RESTORE_COMMAND_ID);
  });

  it("is idempotent on the third call and writes nothing further", async () => {
    const root = anchorRoot("post-switch-thrice");
    await crashAfterSwitch(root);

    const second = await installRecoveryAnchor(request({ anchorRoot: root }));
    if (!second.ok) throw new Error("unreachable");
    const marked = statSync(join(root, RECOVERY_ANCHOR_FILE_NAME)).mtimeMs;

    const observed: string[] = [];
    const third = await installRecoveryAnchor(
      request({ anchorRoot: root, injectFault: (point: string) => void observed.push(point) }),
    );
    if (!third.ok) throw new Error("unreachable");
    expect(third.outcome).toBe("INSTALLED");
    expect(third.anchor).toEqual(second.anchor);
    expect(observed).toEqual([]);
    // Byte-identical content would look the same whether or not it was
    // republished, so the durable observation is that the file was not touched.
    expect(statSync(join(root, RECOVERY_ANCHOR_FILE_NAME)).mtimeMs).toBe(marked);
  });
});

describe("a resume completes the install from every declared crash boundary", () => {
  const resumeCases = RECOVERY_ANCHOR_FAULT_POINTS.map((point) => [point] as const);

  it("generates one resume case per declared boundary", () => {
    // Hand-written literal, not derived from the array under test: a sweep that
    // silently produced zero cases would otherwise pass while testing nothing,
    // and a boundary added later must fail this count rather than be skipped.
    expect(resumeCases.length).toBe(8);
    expect(RECOVERY_ANCHOR_FAULT_POINTS.length).toBe(8);
  });

  it.each(resumeCases)("resumes to INSTALLED after a crash at %s", async (point) => {
    const root = anchorRoot(`resume-${point}`);
    const crash = new Error(`injected fault at ${point}`);
    await expect(
      installRecoveryAnchor(
        request({
          anchorRoot: root,
          injectFault: (reached: string) => {
            if (reached === point) throw crash;
          },
        }),
      ),
    ).rejects.toThrow(`injected fault at ${point}`);

    const resumed = await installRecoveryAnchor(request({ anchorRoot: root }));
    expect(resumed.ok, resumed.ok ? "resumed" : `${resumed.layer}/${resumed.code}`).toBe(true);
    if (!resumed.ok) throw new Error("unreachable");
    expect(resumed.outcome).toBe("INSTALLED");
    expect(resumed.anchor.state).toBe("INSTALLED");
    // Whichever boundary it died at, the anchor ends up selecting the slot it
    // targeted — never half-selecting, never selecting the other one.
    expect(resumed.anchor.currentSlot).toBe(resumed.anchor.targetSlot);
  });
});

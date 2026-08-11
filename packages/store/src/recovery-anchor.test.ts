import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RECOVERY_BINDING_SLOTS } from "./recovery-install-contracts.js";
import {
  RECOVERY_ANCHOR_CODEC_VERSION,
  RECOVERY_ANCHOR_FILE_NAME,
  RECOVERY_ANCHOR_LAYER,
  RECOVERY_ANCHOR_REASON_CODES,
  RECOVERY_ANCHOR_SLOTS_DIR_NAME,
  RECOVERY_ANCHOR_STATES,
} from "./recovery-anchor-contracts.js";
import type {
  RecoveryAnchorInstallResult,
  RecoveryAnchorPrepareResult,
  RecoveryAnchorRecord,
} from "./recovery-anchor-contracts.js";
import {
  installRecoveryAnchor,
  prepareRecoveryAnchor,
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
 * The restored payload the installer writes into the inactive slot. Bytes are
 * deliberately distinctive so the DoD 1 exclusion assertion can search for the
 * anchor's own identity inside them without matching incidental noise.
 */
function payload(marker: string): Record<string, unknown> {
  return {
    artifacts: [
      { bytes: encoder.encode(`artifact-one-${marker}`), logicalPath: "artifacts/one.bin" },
      { bytes: encoder.encode(`artifact-two-${marker}`), logicalPath: "artifacts/nested/two.bin" },
    ],
    databaseBytes: encoder.encode(`database-${marker}`),
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

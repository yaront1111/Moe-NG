/**
 * DoD 2 — restoring the SAME backup generation twice mints a fresh fencing
 * identity, and every grant the first restore held goes stale.
 *
 * The nonce and the key epoch are ONE atomic identity, so both operands are
 * proven separately throughout: a test that checked only the incarnation would
 * stay green while the key epoch was reused, and vice versa.
 *
 * Every refusal below is pinned by CODE and by the LAYER that answered. Five
 * layers can refuse in this area — RECOVERY_ANCHOR, RECOVERY_SUCCESSION,
 * RECOVERY_INVENTORY, RECOVERY_INVENTORY_LEDGER, RECOVERY_COMPLETION — so
 * "refused" alone is one added layer away from vacuous.
 */
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  RECOVERY_ANCHOR_LAYER,
  RECOVERY_ANCHOR_REASON_CODES,
  RECOVERY_BINDING_CODEC_VERSION,
  RECOVERY_BINDING_SLOTS,
  installRecoveryAnchor,
} from "../../../packages/store/src/index.js";
import type { SqliteEventStore } from "../../../packages/store/src/index.js";
import {
  RECOVERY_COMPLETE_PAYLOAD_KEYS,
  RECOVERY_COMPLETION_CODES,
  RECOVERY_COMPLETION_SCHEMA_VERSION,
  RECOVERY_SUCCESSION_ERROR_CODES,
  RECOVERY_SUCCESSION_LAYER,
  anchorIncarnation,
  createNodeRecoveryCryptoPort,
  createRecoveryIncarnationService,
  readAnchoredIncarnation,
  readSuccessionChain,
  recordRecoveryReconciliation,
  runRecoveryCompleteCommand,
} from "@moe/daemon";
import type { RestoreIncarnationBinding } from "@moe/daemon";

import {
  DISASTER_PREPARED_AT,
  DISASTER_PRINCIPAL_ID,
  DISASTER_PROJECT_ID,
  anchorRequest,
  cleanupDisasterRoots,
  openDisasterStore,
  recoveryCompleteEnvelope,
  seedGeneration,
  unreachableAuthority,
} from "./disaster-harness.js";
import type { SeededGeneration } from "./disaster-harness.js";

const FIRST_COMMAND = "restore-command-first";
const SECOND_COMMAND = "restore-command-second";
const THIRD_COMMAND = "restore-command-third";

const writeRequest = {
  correlationId: "correlation-disaster-identity",
  decidedAt: DISASTER_PREPARED_AT,
  principalId: DISASTER_PRINCIPAL_ID,
  projectId: DISASTER_PROJECT_ID,
};

interface IdentityWorld {
  readonly anchorRoot: string;
  readonly first: RestoreIncarnationBinding;
  readonly generation: SeededGeneration;
  readonly second: RestoreIncarnationBinding;
  readonly store: SqliteEventStore;
}

let world: IdentityWorld;

/** Installs one ACTIVE-slot binding through the production store method. */
function installBinding(store: SqliteEventStore, incarnationRef: string, keyEpochRef: string): void {
  const installed = store.installRecoveryBinding({
    bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
    incarnationRef,
    installedAt: DISASTER_PREPARED_AT,
    keyEpochRef,
    payload: new TextEncoder().encode(world.generation.generationDigest),
    slot: RECOVERY_BINDING_SLOTS[0],
  });
  if (!installed.ok) throw new Error(`binding install refused: ${installed.code}`);
}

/** The external facts a reconciliation quotes. Only observations, no verdicts. */
function facts(): Record<string, unknown> {
  return {
    backupCursor: "0",
    backupGenerationDigest: world.generation.generationDigest,
    configuredClasses: [],
    projectTag: "disaster-tag",
    proofs: [],
    subjects: [],
  };
}

beforeAll(async () => {
  const generation = await seedGeneration("identity");
  const store = openDisasterStore(join(generation.root, "identity.db"));
  const service = createRecoveryIncarnationService(createNodeRecoveryCryptoPort());
  const mint = async (restoreCommandId: string): Promise<RestoreIncarnationBinding> => {
    const minted = await service.mint({
      backupGenerationDigest: generation.generationDigest,
      restoreCommandId,
    });
    if (!minted.ok) throw new Error(`mint refused: ${minted.code}`);
    return minted.binding;
  };
  const first = await mint(FIRST_COMMAND);
  const second = await mint(SECOND_COMMAND);
  if (!anchorIncarnation(store, writeRequest, first)) throw new Error("first anchor failed");
  if (!anchorIncarnation(store, writeRequest, second)) throw new Error("second anchor failed");
  world = { anchorRoot: join(generation.root, "anchor"), first, generation, second, store };
}, 60_000);

describe("a repeated same-generation restore mints a fresh fence and stales the old one", () => {
  afterAll(cleanupDisasterRoots);

  /**
   * The MINT property, asserted before anything installs. Kept separate on
   * purpose: the anchor also refuses a reused key epoch, so folding these into
   * the install case would let the anchor's refusal answer first and this
   * assertion would never be the one that reddens.
   */
  it("mints two fully distinct fencing identities for one generation", () => {
    const { first, second } = world;
    expect(second.incarnationRef).not.toBe(first.incarnationRef);
    expect(second.keyEpochRef).not.toBe(first.keyEpochRef);
    // A fence that spent the same string twice has fenced nothing.
    expect(first.keyEpochRef).not.toBe(first.incarnationRef);
    expect(second.keyEpochRef).not.toBe(second.incarnationRef);
    // Same generation on both sides of the fresh identity.
    expect(first.backupGenerationDigest).toBe(world.generation.generationDigest);
    expect(second.backupGenerationDigest).toBe(first.backupGenerationDigest);
  });

  it("restores ONE generation twice under two fresh, fully distinct identities", async () => {
    const { anchorRoot, first, generation, second } = world;
    const one = await installRecoveryAnchor(
      anchorRequest({
        anchorRoot,
        generation,
        incarnationRef: first.incarnationRef,
        keyEpochRef: first.keyEpochRef,
        restoreCommandId: FIRST_COMMAND,
      }),
    );
    if (!one.ok) throw new Error(`first restore refused: ${one.code}`);
    const two = await installRecoveryAnchor(
      anchorRequest({
        anchorRoot,
        generation,
        incarnationRef: second.incarnationRef,
        keyEpochRef: second.keyEpochRef,
        restoreCommandId: SECOND_COMMAND,
      }),
    );
    if (!two.ok) throw new Error(`second restore refused: ${two.code}`);

    // The "same generation" premise is pinned, so it cannot silently become two.
    expect(one.anchor.generationDigest).toBe(generation.generationDigest);
    expect(two.anchor.generationDigest).toBe(one.anchor.generationDigest);
    // Both operands, separately, as the two anchor RECORDS carry them.
    expect(two.anchor.incarnationRef).not.toBe(one.anchor.incarnationRef);
    expect(two.anchor.keyEpochRef).not.toBe(one.anchor.keyEpochRef);
    expect(one.anchor.incarnationRef).toBe(first.incarnationRef);
    expect(two.anchor.keyEpochRef).toBe(second.keyEpochRef);
  }, 60_000);

  it("reads the second incarnation back against the SAME generation digest", () => {
    const { first, generation, second, store } = world;
    const readSecond = readAnchoredIncarnation(store, DISASTER_PROJECT_ID, second.incarnationRef);
    expect(readSecond?.incarnationRef).toBe(second.incarnationRef);
    expect(readSecond?.keyEpochRef).toBe(second.keyEpochRef);
    expect(readSecond?.backupGenerationDigest).toBe(generation.generationDigest);
    expect(readSecond?.restoreCommandId).toBe(SECOND_COMMAND);
    // Fresh identity, same generation — that is the whole point.
    const readFirst = readAnchoredIncarnation(store, DISASTER_PROJECT_ID, first.incarnationRef);
    expect(readFirst?.backupGenerationDigest).toBe(readSecond?.backupGenerationDigest);
    expect(readFirst?.incarnationRef).not.toBe(readSecond?.incarnationRef);
  });

  /**
   * The anchor fences the grant the CURRENT record holds. Its own root per case,
   * so the positive control below cannot move the record the sibling case reads.
   */
  it.each([
    ["a spent incarnation paired with a fresh key epoch", true, false],
    ["a spent key epoch paired with a fresh incarnation", false, true],
  ])("refuses %s at the anchor", async (_label, spentIncarnation, spentEpoch) => {
    const { first, generation, second } = world;
    const slot = spentIncarnation ? "nonce" : "epoch";
    const anchorRoot = join(generation.root, `anchor-${slot}`);
    const seated = await installRecoveryAnchor(
      anchorRequest({
        anchorRoot,
        generation,
        incarnationRef: second.incarnationRef,
        keyEpochRef: second.keyEpochRef,
        restoreCommandId: SECOND_COMMAND,
      }),
    );
    if (!seated.ok) throw new Error(`seating the current fence refused: ${seated.code}`);
    // The FIRST identity is genuinely superseded here: the anchor no longer
    // holds it, which is why the ledger and the coordinator below are the layers
    // that stale it rather than this one.
    expect(seated.anchor.incarnationRef).not.toBe(first.incarnationRef);
    expect(seated.anchor.keyEpochRef).not.toBe(first.keyEpochRef);

    const fresh = await createRecoveryIncarnationService(createNodeRecoveryCryptoPort()).mint({
      backupGenerationDigest: generation.generationDigest,
      restoreCommandId: `${THIRD_COMMAND}-${slot}`,
    });
    if (!fresh.ok) throw new Error(`third mint refused: ${fresh.code}`);
    const refused = await installRecoveryAnchor(
      anchorRequest({
        anchorRoot,
        generation,
        incarnationRef: spentIncarnation ? second.incarnationRef : fresh.binding.incarnationRef,
        keyEpochRef: spentEpoch ? second.keyEpochRef : fresh.binding.keyEpochRef,
        restoreCommandId: `${THIRD_COMMAND}-${slot}`,
      }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("a spent fence must never be re-spendable");
    expect(refused.code).toBe("RECOVERY_ANCHOR_INCARNATION_REUSED");
    expect(RECOVERY_ANCHOR_REASON_CODES).toContain(refused.code);
    expect(refused.layer).toBe(RECOVERY_ANCHOR_LAYER);
    expect(refused.truth).toBe("UNKNOWN");

    // Positive control: the SAME third command with BOTH operands fresh is
    // accepted, so the refusal above is about the spent operand and not about
    // being a third command.
    const accepted = await installRecoveryAnchor(
      anchorRequest({
        anchorRoot,
        generation,
        incarnationRef: fresh.binding.incarnationRef,
        keyEpochRef: fresh.binding.keyEpochRef,
        restoreCommandId: `${THIRD_COMMAND}-${slot}`,
      }),
    );
    if (!accepted.ok) throw new Error(`the fresh control was refused: ${accepted.code}`);
    expect(accepted.outcome).toBe("INSTALLED");
  }, 60_000);

  it("grants nothing from the superseded chain and refuses a key epoch as a predecessor", () => {
    const { first, second, store } = world;
    const stale = readSuccessionChain(store, DISASTER_PROJECT_ID, first.incarnationRef);
    if (!stale.ok) throw new Error(`the first incarnation must still read: ${stale.code}`);
    // Anchored, but it reaches nothing: it cannot speak for the second restore.
    expect(stale.links).toEqual([]);
    expect(stale.originIncarnationRef).toBe(first.incarnationRef);
    expect(stale.originIncarnationRef).not.toBe(second.incarnationRef);
    expect(stale.restoreCommandId).toBe(FIRST_COMMAND);

    // A key epoch is not itself a grant: presented where an incarnation is
    // expected it is refused, with the code AND the layer pinned.
    const asPredecessor = readSuccessionChain(store, DISASTER_PROJECT_ID, first.keyEpochRef);
    expect(asPredecessor.ok).toBe(false);
    if (asPredecessor.ok) throw new Error("a key epoch must not resolve as an incarnation");
    expect(asPredecessor.code).toBe("RECOVERY_PREDECESSOR_NOT_FOUND");
    expect(RECOVERY_SUCCESSION_ERROR_CODES).toContain(asPredecessor.code);
    expect(asPredecessor.layer).toBe(RECOVERY_SUCCESSION_LAYER);
    expect(RECOVERY_SUCCESSION_LAYER).toBe("RECOVERY_SUCCESSION");
    expect(asPredecessor.truth).toBe("UNKNOWN");
  });

  it.each([
    ["a stale key epoch under the current incarnation", "RECOVERY_BINDING_MISMATCH"],
    ["an incarnation that was never anchored", "RECOVERY_ANCHOR_UNAVAILABLE"],
  ])("refuses a reconciliation presenting %s", async (_label, upstreamCode) => {
    const { generation, second } = world;
    const store = openDisasterStore(join(generation.root, `ledger-${upstreamCode}.db`));
    if (upstreamCode === "RECOVERY_BINDING_MISMATCH") {
      // Anchored incarnation, WRONG key epoch: the fence is proven on the
      // second operand rather than on the conjunction.
      if (!anchorIncarnation(store, writeRequest, second)) throw new Error("anchor failed");
      installBinding(store, second.incarnationRef, world.first.keyEpochRef);
    } else {
      installBinding(store, second.incarnationRef, second.keyEpochRef);
    }
    const refused = recordRecoveryReconciliation(store, writeRequest, facts());
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("a stale grant must not record a reconciliation");
    // The coordinator answer is always UNKNOWN_TRUTH; the upstream tuple is what
    // says WHICH stale operand was rejected, so both are asserted.
    expect(refused.code).toBe("UNKNOWN_TRUTH");
    expect(refused.layer).toBe("RECOVERY_INVENTORY");
    expect(refused.upstream).toEqual({ code: upstreamCode, layer: "RECOVERY_INVENTORY_LEDGER" });
  });

  /**
   * The superseded identity addresses no reconciliation, so it can buy nothing:
   * its own ref is digest-shaped and passes ingress, and the coordinator still
   * withholds. Approval is never reached, which the throwing port proves.
   */
  it("withholds completion authority from a stale grant without consulting approval", () => {
    const { first, store } = world;
    const outcome = runRecoveryCompleteCommand(
      store,
      recoveryCompleteEnvelope({
        commandId: "recovery-complete-stale",
        payloadKeys: RECOVERY_COMPLETE_PAYLOAD_KEYS,
        reconciliationDigest: first.incarnationRef,
        schemaVersion: RECOVERY_COMPLETION_SCHEMA_VERSION,
      }),
      unreachableAuthority(),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("a stale grant must never complete recovery");
    // Refused by the inventory coordinator, not by ingress: the envelope is
    // valid at DAEMON_INGRESS by construction, so the guard under test answered.
    expect(outcome.code).toBe("UNKNOWN_TRUTH");
    expect(outcome.refusedBy).toBe("RECOVERY_INVENTORY");
    expect(outcome.upstream).toEqual({
      code: "RECORD_NOT_FOUND",
      layer: "RECOVERY_INVENTORY_LEDGER",
    });
    expect(RECOVERY_COMPLETION_CODES).not.toContain(outcome.code);
    expect(outcome.authority).toBe("NONE");
  });
});

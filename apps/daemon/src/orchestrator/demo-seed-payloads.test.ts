import { evaluatePolicy } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  envelope as bootstrapEnvelope,
  send as bootstrapSend,
} from "../bootstrap/bootstrap-test-fixtures.js";
import {
  admitProviderProfile,
  encodeProviderProfileBytes,
} from "../provider-profile/provider-profile-codec.js";
import { readReviewLedger } from "../review/review-read-model.js";
import {
  AUTHOR,
  PROJECT_ID as REVIEW_PROJECT_ID,
  SUBJECT_REF,
  closeStores,
  envelope as reviewEnvelope,
  openRestartableStore,
  send as reviewSend,
  submitPayload,
} from "../review/review-test-fixtures.js";
import {
  REVIEWER_CALIBRATION_SLICE_REF,
  readReviewerCalibration,
} from "../review/reviewer-calibration-record.js";
import {
  VERIFIER_POLICY_SLICE_REF,
  createVerifierAuthorityProvider,
} from "../review/verifier-authority-provider.js";
import type { NodeMission } from "./agent-wrapper.js";
import { activationWitness, probeObservation, providerProfileRef } from "./demo-seed-payloads.js";
import { buildDemoSeedPlan } from "./demo-seed-plan.js";
import type { DemoSeedInput, SeedCommand } from "./demo-seed-plan.js";

/**
 * The probe observation is graded by the DAEMON'S OWN admission function, never by a
 * second key list written here: a hand-written expectation on both sides is a tautology
 * that stays green while `admitProviderProfile` moves — which is exactly how the seed
 * shipped the retired two-string observation and refused at command 3 of 7.
 */

const NODE = Object.freeze({
  instructions: "Create math.mjs exporting add and multiply so test.mjs passes.",
  nodeRef: "node-code-1",
  test: "node test.mjs",
  title: "Implement the math module",
  workspace: "D:/demo/workspace",
});

const INPUT: DemoSeedInput = Object.freeze({
  correlationId: "corr-demo",
  decidedAt: "2026-08-18T00:00:00.000Z",
  goalId: "goal-demo",
  node: NODE,
  principalId: "principal-demo",
  projectId: "project-demo",
  runId: "run-demo",
});

const observation = (): Record<string, unknown> => probeObservation(INPUT);
const profileOf = (source: Record<string, unknown>): unknown => source["profile"];

/** The observation the plan actually sends, so the pins grade the shipped payload. */
const plannedObservation = (): Record<string, unknown> => {
  const probe = buildDemoSeedPlan(INPUT).find((command) => command.commandKind === "provider.probe");
  if (probe === undefined) throw new Error("the plan never builds provider.probe");
  return probe.payload["observation"] as Record<string, unknown>;
};

describe("the provider.probe observation", () => {
  it("carries a profile the daemon's own codec admits", () => {
    const admission = admitProviderProfile(profileOf(observation()));

    if (!admission.ok) {
      throw new Error(`the demo profile is refused ${admission.issue.code}: ${admission.issue.message}`);
    }
    expect(admission.revision.provider).toBe("claude");
  });

  it("is the same observation the plan sends for provider.probe", () => {
    expect(JSON.stringify(plannedObservation())).toBe(JSON.stringify(observation()));
    expect(admitProviderProfile(profileOf(plannedObservation())).ok).toBe(true);
  });

  it("refuses PROVIDER_PROFILE_INPUT_INVALID at PROVIDER_PROFILE_CODEC without the profile", () => {
    // The exact payload the seed shipped before this fix: two strings, no `profile`.
    const retired = { providerMinimumProfileRef: providerProfileRef(INPUT), truthClass: "DAEMON_VERIFIED" };
    const admission = admitProviderProfile(profileOf(retired));

    if (admission.ok) throw new Error("a profile-less observation must not be admitted");
    expect(admission.issue.code).toBe("PROVIDER_PROFILE_INPUT_INVALID");
    expect(admission.issue.layer).toBe("PROVIDER_PROFILE_CODEC");
  });

  it("names the envelope's ref inside the body, which a REF_MISMATCH would refuse", () => {
    const sent = observation();
    const admission = admitProviderProfile(profileOf(sent));

    if (!admission.ok) throw new Error("the demo profile must be admissible to compare its ref");
    // recordProbe: `profileRef !== revision.providerMinimumProfileRef` -> PROVIDER_PROFILE_REF_MISMATCH.
    expect(admission.revision.providerMinimumProfileRef).toBe(sent["providerMinimumProfileRef"]);
    // The activation witness names the SAME ref, so activate agrees with what probe registered.
    expect(activationWitness(INPUT)["providerMinimumProfileRef"]).toBe(sent["providerMinimumProfileRef"]);
  });

  it("keeps profileRevisionId distinct from the profile ref: identity of content, not of the profile", () => {
    const admission = admitProviderProfile(profileOf(observation()));

    if (!admission.ok) throw new Error("the demo profile must be admissible to compare its ids");
    expect(admission.revision.profileRevisionId)
      .not.toBe(admission.revision.providerMinimumProfileRef);
  });

  it("is byte-constant, so a second seed run is the idempotent re-probe and not a CONFLICT", () => {
    const first = admitProviderProfile(profileOf(probeObservation(INPUT)));
    const second = admitProviderProfile(profileOf(probeObservation(INPUT)));

    if (!first.ok || !second.ok) throw new Error("the demo profile must be admissible twice");
    // conflictsWithProfileHistory compares profileDigest under the same profileRevisionId:
    // an equal digest is the idempotent re-probe, a changed one is IMMUTABILITY_CONFLICT.
    expect(second.revision.profileDigest).toBe(first.revision.profileDigest);
    expect(Buffer.from(encodeProviderProfileBytes(second.revision)).toString("hex"))
      .toBe(Buffer.from(encodeProviderProfileBytes(first.revision)).toString("hex"));
  });
});

/**
 * THE TWO POLICY SLICES, GRADED BY THE PRODUCTION READERS THAT REFUSED WITHOUT THEM.
 *
 * Measured before this change on a store the shipped seed had just filled 7/7:
 * `readReviewerCalibration` -> REVIEWER_CALIBRATION_NOT_INSTALLED @ DAEMON_PREREQUISITE and
 * `createVerifierAuthorityProvider(...)(node)` -> null, so `node-verifier.ts` reported
 * VERIFICATION_AUTHORITY_UNAVAILABLE before any test ran and no node could reach COMMITTED.
 *
 * Every case below installs the slices THE SHIPPED PLAN BUILDS (payload, command id and
 * expectedVersion all taken from `buildDemoSeedPlan`) through `runBootstrapCommand`, then asks
 * the production readers. Nothing here re-decides admissibility with a second key list.
 */

const DURABLE_INPUT: DemoSeedInput = Object.freeze({ ...INPUT, projectId: REVIEW_PROJECT_ID });

const BRIEF: NodeMission = Object.freeze({
  instructions: NODE.instructions,
  test: NODE.test,
  title: NODE.title,
  workspace: NODE.workspace,
});

const policyInstalls = (): readonly SeedCommand[] =>
  buildDemoSeedPlan(DURABLE_INPUT).filter((command) => command.commandKind === "policy.install");

const sliceRefOf = (command: SeedCommand): unknown =>
  (command.payload["slice"] as Record<string, unknown>)["sliceRef"];

/**
 * Installs the planned slices, optionally omitting exactly one by its ref. The omission is by
 * REF rather than by index so a case names the source it removes and cannot drift when the
 * order changes.
 */
function installPlannedSlices(store: SqliteEventStore, omitRef?: string): void {
  let installed = 0;
  for (const command of policyInstalls()) {
    if (sliceRefOf(command) === omitRef) continue;
    // With a slice omitted the stream never reaches the planned version, so the survivor is
    // installed at the version the aggregate actually holds. The PLAN's own expectedVersions are
    // graded by the full-install cases, which pass `command.expectedVersion` unchanged.
    const expectedVersion = omitRef === undefined ? command.expectedVersion : installed;
    const outcome = bootstrapSend(store, {
      ...bootstrapEnvelope("policy.install", expectedVersion, command.payload, command.commandId),
      projectId: REVIEW_PROJECT_ID,
    });
    if (!outcome.ok) throw new Error(`install refused: ${JSON.stringify(outcome)}`);
    installed += 1;
  }
  // A sweep that installs nothing would leave every negative case passing for the wrong reason.
  if (installed === 0 && omitRef === undefined) throw new Error("the plan builds no policy.install");
}

/** One clean round through the real `review.submit` handler; its routing is ACCEPT. */
function seedCleanRound(store: SqliteEventStore): void {
  const version = readReviewLedger(store, REVIEW_PROJECT_ID, SUBJECT_REF).version;
  const outcome = reviewSend(store, {
    ...reviewEnvelope(
      "review.submit", version, submitPayload(version + 1, []), `cmd-clean-${String(version)}`,
    ),
    principalId: AUTHOR,
  });
  if (!outcome.ok) throw new Error(`clean round setup failed: ${outcome.code}`);
}

describe("the demo seed's policy slices", () => {
  afterEach(closeStores);

  it("builds exactly the two slices the verifier's readers address, before goal.create", () => {
    const plan = buildDemoSeedPlan(DURABLE_INPUT);
    const kinds = plan.map((command) => command.commandKind);

    expect(policyInstalls().map(sliceRefOf))
      .toEqual([VERIFIER_POLICY_SLICE_REF, REVIEWER_CALIBRATION_SLICE_REF]);
    expect(kinds.lastIndexOf("policy.install")).toBeLessThan(kinds.indexOf("goal.create"));
    for (const command of policyInstalls()) {
      expect(command.targetAggregateId).toBe(`${REVIEW_PROJECT_ID}-policy`);
    }
    expect(policyInstalls().map((command) => command.expectedVersion)).toEqual([0, 1]);
  });

  it("flips readReviewerCalibration from NOT_INSTALLED to an eligible durable record", () => {
    const { store } = openRestartableStore();

    const before = readReviewerCalibration(store, REVIEW_PROJECT_ID);
    installPlannedSlices(store);
    const after = readReviewerCalibration(store, REVIEW_PROJECT_ID);

    expect(before).toEqual({
      code: "REVIEWER_CALIBRATION_NOT_INSTALLED", layer: "DAEMON_PREREQUISITE", ok: false,
    });
    if (!after.ok) throw new Error(`calibration still refuses ${after.code} at ${after.layer}`);
    // VALUES, not just ok: `qualifyReviewerForAcceptance` refuses REVIEWER_CALIBRATION_UNPROVEN
    // on a STALE/UNKNOWN staleness, a failed sentinel or an empty corpus revision, so a wrong
    // accepted record would pass an ok-only assertion and still block every acceptance.
    expect(after.calibration).toEqual({
      corpusRevision: `${REVIEW_PROJECT_ID}-demo-seed-declared-corpus-1`,
      sentinelPassed: true,
      staleness: "CURRENT",
    });
  });

  it("flips the verifier authority provider from null to facts the core evaluates ALLOW", () => {
    const { store } = openRestartableStore();
    seedCleanRound(store);
    const provider = createVerifierAuthorityProvider({ projectId: REVIEW_PROJECT_ID, store });

    const before = provider(SUBJECT_REF, BRIEF);
    installPlannedSlices(store);
    const after = provider(SUBJECT_REF, BRIEF);

    expect(before).toBeNull();
    if (after === null) throw new Error("the installed slices still leave the authority null");
    // `sliceRef` is the slice's ADDRESS: the stored 14 keys must read back as the core's exact
    // 13 or `evaluatePolicy` refuses INPUT_INVALID when the receipt is decoded again.
    expect(Object.keys(after.policy)).not.toContain("sliceRef");
    const evaluated = evaluatePolicy(after.policy);
    if (!evaluated.ok) throw new Error(`the seeded policy is inadmissible: ${evaluated.error.code}`);
    expect(evaluated.record.decision).toBe("ALLOW");
    expect(evaluated.record.reasonCodes).toEqual(["ALLOWED_BY_POLICY"]);
    expect(evaluated.record.action).toBe("integration.accept_output");
    expect(evaluated.record.actor).toBe("daemon:node-verifier");
  });

  it("keeps each slice load-bearing: dropping either one alone returns the authority to null", () => {
    const withoutPolicy = openRestartableStore().store;
    seedCleanRound(withoutPolicy);
    installPlannedSlices(withoutPolicy, VERIFIER_POLICY_SLICE_REF);
    const withoutCalibration = openRestartableStore().store;
    seedCleanRound(withoutCalibration);
    installPlannedSlices(withoutCalibration, REVIEWER_CALIBRATION_SLICE_REF);

    // The calibration is installed in the first store, so its null cannot be the calibration gap.
    expect(readReviewerCalibration(withoutPolicy, REVIEW_PROJECT_ID).ok).toBe(true);
    expect(createVerifierAuthorityProvider({ projectId: REVIEW_PROJECT_ID, store: withoutPolicy })(
      SUBJECT_REF, BRIEF,
    )).toBeNull();
    expect(readReviewerCalibration(withoutCalibration, REVIEW_PROJECT_ID))
      .toEqual({ code: "REVIEWER_CALIBRATION_NOT_INSTALLED", layer: "DAEMON_PREREQUISITE", ok: false });
    expect(createVerifierAuthorityProvider({
      projectId: REVIEW_PROJECT_ID, store: withoutCalibration,
    })(SUBJECT_REF, BRIEF)).toBeNull();
  });

  it("is byte-constant, so a second seed run replays instead of installing new bytes", () => {
    expect(JSON.stringify(policyInstalls())).toBe(JSON.stringify(policyInstalls()));
  });
});

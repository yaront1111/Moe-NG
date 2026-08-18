import { describe, expect, it } from "vitest";

import {
  admitProviderProfile,
  encodeProviderProfileBytes,
} from "../provider-profile/provider-profile-codec.js";
import { activationWitness, probeObservation, providerProfileRef } from "./demo-seed-payloads.js";
import { buildDemoSeedPlan } from "./demo-seed-plan.js";
import type { DemoSeedInput } from "./demo-seed-plan.js";

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

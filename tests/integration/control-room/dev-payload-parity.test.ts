import { expect, it } from "vitest";

import { journeyAuthority } from "../../../apps/daemon/src/planning/journey-authority-bodies.js";
import { DEFAULT_GOAL_SUBJECT, DEFAULT_RUN_SUBJECT } from "../../../apps/daemon/src/http/affordance-read.js";
import { DEV_PAYLOADS, payloadFor } from "../../../apps/control-room/src/live/live-dispatch.js";

/**
 * The control room cannot import the daemon, so its plan.propose dev payload SPELLS the
 * planning-authority bodies the daemon's journey producer mints for the live subjects. The
 * daemon re-encodes those bodies and re-derives their digests at plan.propose, so a drifted
 * spelling does not seal differently - it stops the board's chain at plan.propose with a codec
 * code. This test is the only place the two sides meet: the board's bytes against the producer.
 */

const hex64 = (seed: string): string =>
  (seed.replace(/[^0-9a-f]/gu, "0") + "0".repeat(64)).slice(0, 64);

function chainOf(version: number): readonly Record<string, unknown>[] {
  const payload = payloadFor("plan.propose", DEFAULT_RUN_SUBJECT, version);
  if (payload === null) throw new Error("no plan.propose payload");
  return payload["commands"] as readonly Record<string, unknown>[];
}

it("the board's sealed authority is byte-identical to the daemon producer's", () => {
  const sealed = journeyAuthority({
    authorRef: "operator-local",
    criterionIds: [`${DEFAULT_GOAL_SUBJECT}-criterion`],
    graphContentHash: hex64("c0ffee"),
    graphRevisionRef: "graph-revision-1",
    idPrefix: DEFAULT_RUN_SUBJECT,
    nodeIds: ["node-code-1"],
    stepDescription: "Land the live board's demo node.",
  });
  const planning = chainOf(0);
  const propose = planning[planning.length - 1] as Record<string, unknown>;
  expect(propose["kind"]).toBe("plan.propose");
  // Structural equality: the daemon canonicalises before digesting, so key order is not data.
  expect(propose["authority"]).toEqual(sealed.authority);
  expect(propose["submissionHash"]).toBe(sealed.submissionHash);

  const finalize = chainOf(1)[0] as Record<string, unknown>;
  expect((finalize["revision"] as Record<string, unknown>)["planHash"]).toBe(sealed.submissionHash);
  const approval = DEV_PAYLOADS["approval.decide"] as Record<string, unknown>;
  expect((approval["record"] as Record<string, unknown>)["exactRevisionHash"]).toBe(sealed.submissionHash);
  expect(approval["runId"]).toBe(DEFAULT_RUN_SUBJECT);
});

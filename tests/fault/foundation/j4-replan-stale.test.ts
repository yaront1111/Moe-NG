/**
 * J4 (rejection and re-plan) plus the stale-client subset — design section 18.2
 * and the stale-epoch bars of section 20.4.
 *
 * The stale-client schedules execute for real against the landed contracts
 * decoder and error registry: a superseded envelope version, a malformed
 * command shape and a stale expected version are all refused with named,
 * fail-closed outcomes. Lease staleness is split honestly — carriage and
 * classification exist today and are asserted; enforcement does not exist and
 * is probed rather than assumed.
 */

import { describe, expect, it } from "vitest";

import {
  buildCommandEnvelopeRecord,
  buildLeaseAuthority,
  encodeCanonicalBytes,
} from "../../../packages/testkit/src/foundation/foundation-fakes.js";
import type {
  CommandEnvelopeOverrides,
} from "../../../packages/testkit/src/foundation/foundation-fakes.js";
import {
  FOUNDATION_PARTITION_COUNTS,
  foundationPartition,
  resolveEvidenceOutcome,
} from "../../../packages/testkit/src/foundation/foundation-fault-schedule.js";
import { J4_MAX_ROUNDS, evaluateJ4Round } from "../../../packages/testkit/src/foundation/foundation-model-j3j4.js";
import {
  J4_CONFLICTING_DELTA,
  J4_ROUND,
} from "../../../packages/testkit/src/foundation/foundation-journey-fixtures.js";
import { passExpected } from "../../../packages/testkit/src/foundation/foundation-outcomes-fixtures.js";
import {
  accepted,
  assertPartitionOwnership,
  contracts,
  core,
  executorFor,
  fixturePayload,
  missingEvidenceOf,
  outcomeFromVerdict,
  partitionRows,
  produceAbsenceOutcome,
  refused,
} from "./foundation-harness.js";
import type { FoundationExecutors } from "./foundation-harness.js";

const PARTITION = foundationPartition("J4");

function decodeRecord(record: Readonly<Record<string, unknown>>) {
  return contracts.decodeRuntimeCommandEnvelopeBytes(encodeCanonicalBytes(record));
}

function decodeEnvelope(overrides: CommandEnvelopeOverrides) {
  return decodeRecord(buildCommandEnvelopeRecord("goal.create", overrides));
}

function draftGoal() {
  return accepted(core.reduceGoal(undefined, {
    budgetAccountRef: "budget-1", commandId: "cmd-goal-create", expectedVersion: 0,
    goalId: "goal-1", kind: "goal.create", planningRunRef: "planning-1", projectId: "project-1",
    witness: { projectReadyRef: "project-1", truthClass: "DAEMON_VERIFIED" },
  }), "goal.create").state;
}

const EXECUTORS: FoundationExecutors = {
  "fixture:j4-delta-approval-round": () =>
    outcomeFromVerdict(
      evaluateJ4Round(fixturePayload("fixture:j4-delta-approval-round", J4_ROUND)),
    ),

  "fixture:j4-node-both-invalidated-and-carried": () =>
    outcomeFromVerdict(
      evaluateJ4Round(
        fixturePayload("fixture:j4-node-both-invalidated-and-carried", J4_CONFLICTING_DELTA),
      ),
    ),

  "schedule:j4-delta-approval-round-accepted": () => {
    expect(evaluateJ4Round(J4_ROUND)).toEqual({ ok: true, roundsRemaining: 1 });
    expect(J4_ROUND.delta.changedHashes).toHaveLength(1);
    expect(J4_ROUND.readableHistoryRefs).toEqual(["plan/1", "attempt/1", "review/1"]);
    return passExpected();
  },

  "schedule:j4-invalidated-and-carried-conflict-refused": () => {
    const conflicting = {
      ...J4_ROUND,
      delta: { ...J4_ROUND.delta, carryForwardNodeRefs: ["node/codegen"] },
    };
    expect(evaluateJ4Round(conflicting)).toEqual({
      ok: false, refusal: "J4_NODE_BOTH_INVALIDATED_AND_CARRIED",
    });
    return passExpected();
  },

  "schedule:j4-finding-without-evidence-refused": () => {
    const unevidenced = {
      ...J4_ROUND,
      findings: [{ evidenceRef: null, findingRef: "finding/2", requiredChangeRef: "change/2" }],
    };
    expect(evaluateJ4Round(unevidenced)).toEqual({
      ok: false, refusal: "J4_FINDING_WITHOUT_EVIDENCE",
    });
    expect(evaluateJ4Round({ ...J4_ROUND, findings: [] })).toEqual({
      ok: false, refusal: "J4_FINDING_WITHOUT_EVIDENCE",
    });
    return passExpected();
  },

  "schedule:j4-round-limit-requires-explicit-escalation": () => {
    const past = { ...J4_ROUND, round: J4_MAX_ROUNDS + 1 };
    expect(evaluateJ4Round(past)).toEqual({
      ok: false, refusal: "J4_ROUND_LIMIT_WITHOUT_ESCALATION",
    });
    expect(evaluateJ4Round({ ...past, escalated: true })).toEqual({
      ok: true, roundsRemaining: 0,
    });
    return passExpected();
  },

  "schedule:j4-stale-envelope-version-rejected": () => {
    const stale = refused(
      decodeEnvelope({ schemaVersion: "moe-runtime-command/0" }), "superseded schema version",
    );
    expect(stale.error.code).toBe("SCHEMA_VERSION_UNSUPPORTED");
    expect(stale.error.details.supportedSchemaVersion).toBe(
      contracts.RUNTIME_COMMAND_ENVELOPE_VERSION,
    );
    expect(decodeEnvelope({}).ok).toBe(true);
    return passExpected();
  },

  "schedule:j4-stale-command-shape-rejected": () => {
    const shapes: readonly CommandEnvelopeOverrides[] = [
      { requestDigest: "not-a-digest" }, { commandId: "" }, { expectedVersion: -1 },
    ];
    for (const shape of shapes) {
      expect(refused(decodeEnvelope(shape), "malformed command shape").error.code)
        .toBe("INPUT_INVALID");
    }
    return passExpected();
  },

  "schedule:j4-stale-lease-epoch-classification": () => {
    // The lease epoch is carried and parsed today...
    const carried = accepted(
      decodeEnvelope({ leaseAuthority: buildLeaseAuthority(7, 3) }), "lease-bearing envelope",
    );
    expect(carried.envelope.leaseAuthority?.epoch).toBe(7);
    // A lease authority missing its required fields is refused, so the epoch
    // cannot be carried by a half-built authority block.
    const malformed = decodeRecord({
      ...buildCommandEnvelopeRecord("goal.create"), leaseAuthority: { epoch: 7 },
    });
    expect(refused(malformed, "malformed lease authority").error.code).toBe("INPUT_INVALID");

    // ...and both stale outcomes are registered fail-closed with epoch details.
    for (const code of ["STALE_LEASE", "STALE_EPOCH"] as const) {
      const descriptor = contracts.lookupRuntimeError(code);
      expect(descriptor.code).toBe(code);
      expect(descriptor.transport.httpStatus).toBe(412);
      expect(descriptor.truthClass).toBe("DAEMON_VERIFIED");
      expect([...descriptor.requiredDetailKeys].sort()).toEqual(
        ["expectedEpoch", "observedEpoch"],
      );
      expect(descriptor.validSources).toContain("LEASE");
    }
    expect(contracts.lookupRuntimeError("STALE_LEASE").recoveryCategory).toBe("RECONCILE");
    expect(contracts.lookupRuntimeError("STALE_EPOCH").retryability).toBe("AFTER_REFRESH");
    return passExpected();
  },

  "schedule:j4-expected-version-stale-client-refused": () => {
    const goal = draftGoal();
    const stale = refused(core.reduceGoal(goal, {
      commandId: "cmd-stale-client", expectedVersion: goal.version - 1, kind: "goal.pause",
      schedulingControl: "DRAIN_AND_PAUSE",
    }), "stale-client goal.pause");
    expect(stale.error.code).toBe("EXPECTED_VERSION_CONFLICT");
    expect(stale.error.details.actualVersion).toBe(goal.version);
    expect(stale.error.details.expectedVersion).toBe(goal.version - 1);
    return passExpected();
  },

  "schedule:j4-stale-lease-enforcement": (entry) => produceAbsenceOutcome(entry),
  "incident:silent-review-theft": (entry) => produceAbsenceOutcome(entry),
  "incident:stale-assets-refuse-handshake": (entry) => produceAbsenceOutcome(entry),

  "schedule:j4-review-round-corpus": (entry) =>
    resolveEvidenceOutcome([], missingEvidenceOf(entry)),
};

describe("J4 replan and stale-client fault schedules", () => {
  it("owns exactly the J4 manifest partition", () => {
    assertPartitionOwnership(PARTITION, EXECUTORS, FOUNDATION_PARTITION_COUNTS.J4);
  });

  it.each(partitionRows(PARTITION))("%s produces its declared outcome", (entryId, entry) => {
    expect(executorFor(EXECUTORS, entryId)(entry)).toEqual(entry.outcome);
  });
});

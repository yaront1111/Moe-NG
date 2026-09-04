import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { WORK_CLAIM_SCHEMA_VERSION } from "./work-claim-contracts.js";
import {
  aggregateIdFor,
  readWorkClaimLedger,
  runWorkClaimCommand,
} from "./work-claim-services.js";
import type { WorkClaimOutcome } from "./work-claim-services.js";

const PROJECT = "proj-work-claim";
const directory = mkdtempSync(join(tmpdir(), "moe-work-claim-"));
const store = SqliteEventStore.openForProject(join(directory, "store.db"), PROJECT);

afterAll(() => {
  store.close();
  rmSync(directory, { force: true, recursive: true });
});

const encoder = new TextEncoder();
let sequence = 0;

function run(
  kind: string, principalId: string, payload: Record<string, unknown>,
  expectedVersion = 0, decidedAt = "2026-08-09T12:00:00.000Z", commandId?: string,
) {
  return runWorkClaimCommand(store, encoder.encode(JSON.stringify({
    commandId: commandId ?? `cmd-claim-${String(sequence += 1)}`,
    correlationId: "corr-claim",
    decidedAt,
    expectedVersion,
    kind,
    payload,
    principalId,
    projectId: PROJECT,
    schemaVersion: WORK_CLAIM_SCHEMA_VERSION,
  })));
}

const ITEM = "goal.create@goal-live-1";
const LATER = "2026-08-09T13:00:00.000Z";

function expectDurableCasRefusal(commandId: string, principalId: string, item: string): void {
  expect(store.getCommandDecision({ commandId, principalId, projectId: PROJECT })).toMatchObject({
    effectDisposition: "NO_BUSINESS_EFFECT",
    expectedVersion: 0,
    observedVersion: 1,
    resultCode: "EXPECTED_VERSION_CONFLICT",
    targetAggregateId: aggregateIdFor(item),
  });
}

/**
 * A conflict refusal must NAME the version the store observed, so a caller can retry at it.
 * `actualVersion` is read back off the store's own aggregate head rather than copied from the
 * request, which is what makes this arm go red if the daemon ever echoes its own expectedVersion.
 */
function expectConflictNamesObservedVersion(
  outcome: WorkClaimOutcome, item: string, staleVersion: number,
): void {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("expected refusal");
  expect(outcome.error).not.toBeNull();
  expect(outcome.error?.code).toBe("EXPECTED_VERSION_CONFLICT");
  expect({ ...outcome.error?.details }).toEqual({
    actualVersion: store.getAggregateVersion(aggregateIdFor(item)),
    expectedVersion: staleVersion,
  });
}

describe("runWorkClaimCommand", () => {
  it("grants a fresh claim durably", () => {
    const outcome = run("work.claim", "agent-a", { expiresAt: LATER, workItemId: ITEM });
    expect(outcome).toMatchObject({ disposition: "DECIDED", ok: true });
  });

  it("fences a second agent off a held item with the stable code", () => {
    const outcome = run("work.claim", "agent-b", { expiresAt: LATER, workItemId: ITEM });
    expect(outcome).toMatchObject({
      code: "WORK_CLAIM_HELD", ok: false, refusedBy: "DAEMON_PREREQUISITE",
    });
  });

  it("refuses release by a non-claimant", () => {
    const outcome = run("work.release", "agent-b", { workItemId: ITEM });
    expect(outcome).toMatchObject({ code: "WORK_CLAIM_NOT_CLAIMANT", ok: false });
  });

  it("renews only for the claimant, then releases, then the fence lifts", () => {
    const renewed = run("work.renew", "agent-a", {
      expiresAt: "2026-08-09T14:00:00.000Z", workItemId: ITEM,
    }, 1);
    expect(renewed).toMatchObject({ ok: true });
    const released = run("work.release", "agent-a", { workItemId: ITEM }, 2);
    expect(released).toMatchObject({ ok: true });
    const reclaimed = run(
      "work.claim", "agent-b", { expiresAt: LATER, workItemId: ITEM }, 3,
    );
    expect(reclaimed).toMatchObject({ disposition: "DECIDED", ok: true });
  });

  it("lets an expired claim be taken over at the daemon's decide time", () => {
    const item = "plan.propose@run-live-1";
    run("work.claim", "agent-a", { expiresAt: "2026-08-09T12:30:00.000Z", workItemId: item });
    const takeover = run(
      "work.claim", "agent-b",
      { expiresAt: "2026-08-09T15:00:00.000Z", workItemId: item },
      1,
      "2026-08-09T12:31:00.000Z",
    );
    expect(takeover).toMatchObject({ disposition: "DECIDED", ok: true });
  });

  it("replays an identical command instead of double-claiming", () => {
    const item = "policy.install@proj-policy";
    const first = run(
      "work.claim", "agent-a", { expiresAt: LATER, workItemId: item },
      0, "2026-08-09T12:00:00.000Z", "cmd-claim-fixed",
    );
    expect(first).toMatchObject({ disposition: "DECIDED", ok: true });
    const replay = run(
      "work.claim", "agent-a", { expiresAt: LATER, workItemId: item },
      0, "2026-08-09T12:00:00.000Z", "cmd-claim-fixed",
    );
    expect(replay).toMatchObject({ disposition: "REPLAYED", ok: true });
    expect(store.readEvents(aggregateIdFor(item))).toHaveLength(1);
  });

  it("refuses a stale expectedVersion for claim takeover with zero business-state change", () => {
    const item = "plan.propose@run-stale-claim";
    expect(run("work.claim", "agent-a", {
      expiresAt: "2026-08-09T12:30:00.000Z", workItemId: item,
    })).toMatchObject({ ok: true });
    const before = {
      events: store.readEvents(aggregateIdFor(item)),
      record: readWorkClaimLedger(store, PROJECT).claims.get(item),
    };

    const stale = run(
      "work.claim", "agent-b",
      { expiresAt: "2026-08-09T15:00:00.000Z", workItemId: item },
      0, "2026-08-09T12:31:00.000Z", "cmd-stale-claim",
    );

    expect(stale).toMatchObject({
      code: "EXPECTED_VERSION_CONFLICT", ok: false, refusedBy: "DURABLE_STORE",
    });
    expectDurableCasRefusal("cmd-stale-claim", "agent-b", item);
    expectConflictNamesObservedVersion(stale, item, 0);
    expect({
      events: store.readEvents(aggregateIdFor(item)),
      record: readWorkClaimLedger(store, PROJECT).claims.get(item),
    }).toEqual(before);
  });

  it("refuses a stale expectedVersion for renewal with zero business-state change", () => {
    const item = "review.submit@node-stale-renew";
    expect(run("work.claim", "agent-a", { expiresAt: LATER, workItemId: item }))
      .toMatchObject({ ok: true });
    const before = {
      events: store.readEvents(aggregateIdFor(item)),
      record: readWorkClaimLedger(store, PROJECT).claims.get(item),
    };

    const stale = run("work.renew", "agent-a", {
      expiresAt: "2026-08-09T14:00:00.000Z", workItemId: item,
    }, 0, "2026-08-09T12:00:00.000Z", "cmd-stale-renew");

    expect(stale).toMatchObject({
      code: "EXPECTED_VERSION_CONFLICT", ok: false, refusedBy: "DURABLE_STORE",
    });
    expectDurableCasRefusal("cmd-stale-renew", "agent-a", item);
    expectConflictNamesObservedVersion(stale, item, 0);
    expect({
      events: store.readEvents(aggregateIdFor(item)),
      record: readWorkClaimLedger(store, PROJECT).claims.get(item),
    }).toEqual(before);
  });

  it("refuses a stale expectedVersion for release with zero business-state change", () => {
    const item = "node.deliver@node-stale-release";
    expect(run("work.claim", "agent-a", { expiresAt: LATER, workItemId: item }))
      .toMatchObject({ ok: true });
    const before = {
      events: store.readEvents(aggregateIdFor(item)),
      record: readWorkClaimLedger(store, PROJECT).claims.get(item),
    };

    const stale = run(
      "work.release", "agent-a", { workItemId: item },
      0, "2026-08-09T12:00:00.000Z", "cmd-stale-release",
    );

    expect(stale).toMatchObject({
      code: "EXPECTED_VERSION_CONFLICT", ok: false, refusedBy: "DURABLE_STORE",
    });
    expectDurableCasRefusal("cmd-stale-release", "agent-a", item);
    expectConflictNamesObservedVersion(stale, item, 0);
    expect({
      events: store.readEvents(aggregateIdFor(item)),
      record: readWorkClaimLedger(store, PROJECT).claims.get(item),
    }).toEqual(before);
  });

  it("refuses a malformed payload with the ingress code", () => {
    const outcome = run("work.claim", "agent-a", { workItemId: ITEM });
    expect(outcome).toMatchObject({
      code: "WORK_CLAIM_PAYLOAD_INVALID", ok: false, refusedBy: "DAEMON_INGRESS",
    });
  });
});

/**
 * A replay must PROVE same bytes before it echoes the stored decision. The
 * decision key is {commandId, principalId, projectId} — covering neither the
 * kind nor the payload — and `replayOf` answers before any store write, so
 * without a byte compare a resubmit under the same kind with DIFFERENT bytes
 * would be handed the earlier result as "ok, REPLAYED": authority for a command
 * never decided with those bytes, invisible to the store's own conflict arm.
 */
describe("runWorkClaimCommand replay proves same bytes", () => {
  it("refuses a claim resubmit whose bytes diverge, with zero business-state change", () => {
    const item = "goal.close@goal-bytes-1";
    const divergent = "goal.close@goal-bytes-2";
    const first = run(
      "work.claim", "agent-a", { expiresAt: LATER, workItemId: item },
      0, "2026-08-09T12:00:00.000Z", "cmd-bytes-claim",
    );
    expect(first).toMatchObject({ disposition: "DECIDED", ok: true });

    const conflicting = run(
      "work.claim", "agent-a", { expiresAt: LATER, workItemId: divergent },
      0, "2026-08-09T12:00:00.000Z", "cmd-bytes-claim",
    );

    expect(conflicting).toMatchObject({
      code: "WORK_CLAIM_COMMAND_BYTES_CONFLICT", ok: false, refusedBy: "DAEMON_PREREQUISITE",
    });
    expect(store.readEvents(aggregateIdFor(divergent))).toHaveLength(0);
    expect(readWorkClaimLedger(store, PROJECT).claims.get(divergent)).toBeUndefined();
    expect(store.readEvents(aggregateIdFor(item))).toHaveLength(1);
  });

  it("refuses a divergent release resubmit instead of echoing the stored release", () => {
    const item = "goal.close@goal-bytes-3";
    const divergent = "goal.close@goal-bytes-4";
    expect(run("work.claim", "agent-a", { expiresAt: LATER, workItemId: item }))
      .toMatchObject({ ok: true });
    expect(run(
      "work.release", "agent-a", { workItemId: item },
      1, "2026-08-09T12:00:00.000Z", "cmd-bytes-release",
    )).toMatchObject({ disposition: "DECIDED", ok: true });

    const conflicting = run(
      "work.release", "agent-a", { workItemId: divergent },
      1, "2026-08-09T12:00:00.000Z", "cmd-bytes-release",
    );

    expect(conflicting).toMatchObject({
      code: "WORK_CLAIM_COMMAND_BYTES_CONFLICT", ok: false, refusedBy: "DAEMON_PREREQUISITE",
    });
    expect(store.readEvents(aggregateIdFor(divergent))).toHaveLength(0);
  });

  it("still replays a byte-identical resubmit after the aggregate has advanced", () => {
    const item = "goal.close@goal-bytes-5";
    expect(run(
      "work.claim", "agent-a", { expiresAt: LATER, workItemId: item },
      0, "2026-08-09T12:00:00.000Z", "cmd-bytes-advance",
    )).toMatchObject({ ok: true });
    expect(run("work.renew", "agent-a", {
      expiresAt: "2026-08-09T14:00:00.000Z", workItemId: item,
    }, 1)).toMatchObject({ ok: true });

    // The stored fence, not the live version, feeds the digest — an honest
    // retry of the original claim must still read as a replay at version 2.
    const replay = run(
      "work.claim", "agent-a", { expiresAt: LATER, workItemId: item },
      0, "2026-08-09T12:00:00.000Z", "cmd-bytes-advance",
    );
    expect(replay).toMatchObject({ disposition: "REPLAYED", ok: true });
    expect(store.readEvents(aggregateIdFor(item))).toHaveLength(2);
  });

  it("still answers WORK_CLAIM_COMMAND_ID_REUSED when the reused id changes kind", () => {
    const item = "goal.close@goal-bytes-6";
    expect(run(
      "work.claim", "agent-a", { expiresAt: LATER, workItemId: item },
      0, "2026-08-09T12:00:00.000Z", "cmd-bytes-kind",
    )).toMatchObject({ ok: true });

    // Different kind AND different bytes: if the byte compare were ordered
    // first it would answer here and the kind guard would go silent.
    const reused = run(
      "work.release", "agent-a", { workItemId: item },
      1, "2026-08-09T12:00:00.000Z", "cmd-bytes-kind",
    );
    expect(reused).toMatchObject({
      code: "WORK_CLAIM_COMMAND_ID_REUSED", ok: false, refusedBy: "DAEMON_PREREQUISITE",
    });
  });
});

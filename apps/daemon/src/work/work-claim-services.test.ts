import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { SESSION_SCHEMA_VERSION } from "../identity/session-contracts.js";
import { readSessionLedger } from "../identity/session-read-model.js";
import { runSessionCommand } from "../identity/session-services.js";
import { commitRaw, installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
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
// `session.open` binds the store's recovery identity, so the seat fixtures below
// need it installed before any of them can seed a holder session.
installTestRecoveryBinding(store);

/** Per-arm stores for the holder-liveness suite: an unreadable session ledger is
 * a whole-STORE fact, so those arms cannot share one. */
const seatStores: SqliteEventStore[] = [];

afterAll(() => {
  while (seatStores.length > 0) {
    try {
      seatStores.pop()?.close();
    } catch {
      // Cleanup must not mask a test failure.
    }
  }
  store.close();
  rmSync(directory, { force: true, recursive: true });
});

const encoder = new TextEncoder();
let sequence = 0;

function runOn(
  target: SqliteEventStore, projectId: string,
  kind: string, principalId: string, payload: Record<string, unknown>,
  expectedVersion = 0, decidedAt = "2026-08-09T12:00:00.000Z", commandId?: string,
) {
  return runWorkClaimCommand(target, encoder.encode(JSON.stringify({
    commandId: commandId ?? `cmd-claim-${String(sequence += 1)}`,
    correlationId: "corr-claim",
    decidedAt,
    expectedVersion,
    kind,
    payload,
    principalId,
    projectId,
    schemaVersion: WORK_CLAIM_SCHEMA_VERSION,
  })));
}

function run(
  kind: string, principalId: string, payload: Record<string, unknown>,
  expectedVersion = 0, decidedAt = "2026-08-09T12:00:00.000Z", commandId?: string,
) {
  return runOn(store, PROJECT, kind, principalId, payload, expectedVersion, decidedAt, commandId);
}

function seatStore(projectId: string): SqliteEventStore {
  const fresh = SqliteEventStore.openEphemeralForProjectTest(projectId);
  installTestRecoveryBinding(fresh);
  seatStores.push(fresh);
  return fresh;
}

/** Opens a REAL seat session through the production session pipeline. */
function openSeat(
  target: SqliteEventStore, projectId: string, sessionId: string, expiresAt: string,
): void {
  const outcome = runSessionCommand(target, encoder.encode(JSON.stringify({
    commandId: `cmd-seat-open-${sessionId}`,
    correlationId: "corr-seat",
    decidedAt: "2026-08-09T11:00:00.000Z",
    expectedVersion: 0,
    kind: "session.open",
    payload: {
      capabilities: ["work.write"],
      credentialSha256: createHash("sha256").update(sessionId, "utf8").digest("hex"),
      expiresAt,
      sessionId,
    },
    // The seat's own working principal IS its session id (session-authenticator),
    // which is what `work.claim` under the seat's bearer records as `claimedBy`.
    principalId: sessionId,
    projectId,
    schemaVersion: SESSION_SCHEMA_VERSION,
  })));
  if (!outcome.ok) throw new Error(`session.open setup failed: ${outcome.code}`);
}

function closeSeat(target: SqliteEventStore, projectId: string, sessionId: string): void {
  const version = readSessionLedger(target, projectId).sessions.get(sessionId)?.version;
  if (version === undefined) throw new Error(`no seat session ${sessionId} to close`);
  const outcome = runSessionCommand(target, encoder.encode(JSON.stringify({
    commandId: `cmd-seat-close-${sessionId}`,
    correlationId: "corr-seat",
    decidedAt: "2026-08-09T11:30:00.000Z",
    expectedVersion: version,
    kind: "session.close",
    payload: { sessionId },
    principalId: "operator-local",
    projectId,
    schemaVersion: SESSION_SCHEMA_VERSION,
  })));
  if (!outcome.ok) throw new Error(`session.close setup failed: ${outcome.code}`);
}

/**
 * Puts bytes the session fold cannot parse into the log, through the PRODUCTION
 * commit seam: an accepted `session.open` decision whose stored result carries no
 * session facts is exactly what `readSessionLedger` reports as `unreadable`.
 */
function corruptSessionLedger(target: SqliteEventStore, projectId: string): void {
  commitRaw(target, {
    commandId: "cmd-seat-corrupt",
    correlationId: "corr-seat",
    decidedAt: "2026-08-09T11:00:00.000Z",
    expectedVersion: 0,
    kind: "session.open",
    payload: { sessionId: "sess-corrupt" },
    principalId: "sess-corrupt",
    projectId,
    schemaVersion: SESSION_SCHEMA_VERSION,
  }, {}, "sess-corrupt");
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

  it("refuses release by a non-claimant while the holder's seat is LIVE", () => {
    // The rule that admits a DEAD holder's release turns on holder liveness, so
    // this arm must give "agent-a" the live seat it never had: without one the
    // release would now be ADMITTED and this refusal would go vacuous.
    openSeat(store, PROJECT, "agent-a", "2026-08-09T15:00:00.000Z");
    const outcome = run("work.release", "agent-b", { workItemId: ITEM });
    expect(outcome).toMatchObject({
      code: "WORK_CLAIM_NOT_CLAIMANT", ok: false, refusedBy: "DAEMON_PREREQUISITE",
    });
  });

  it("keeps two seats' identical command ids apart: distinct decisions, distinct event ids", () => {
    // Seats choose their own work.* command ids; two sessions on one goal chose the same one.
    // The decision key already told them apart; the event id must too, or the second dies
    // DURABLE_ID_CONFLICT in the store's global event namespace (measured 2026-09-05).
    const projectId = "proj-shared-command-ids";
    const target = seatStore(projectId);
    const on = (kind: string, principal: string, payload: Record<string, unknown>, version: number, commandId: string) =>
      runOn(target, projectId, kind, principal, payload, version, "2026-08-09T12:00:00.000Z", commandId);
    expect(on("work.claim", "agent-a", { expiresAt: LATER, workItemId: ITEM }, 0, "claim-1"))
      .toMatchObject({ disposition: "DECIDED", ok: true });
    expect(on("work.release", "agent-a", { workItemId: ITEM }, 1, "release-1"))
      .toMatchObject({ disposition: "DECIDED", ok: true });
    expect(on("work.claim", "agent-b", { expiresAt: LATER, workItemId: ITEM }, 2, "claim-1"))
      .toMatchObject({ disposition: "DECIDED", ok: true });
    expect(on("work.release", "agent-b", { workItemId: ITEM }, 3, "release-1"))
      .toMatchObject({ disposition: "DECIDED", ok: true });
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

/**
 * THE DEAD-SEAT RULE. A seat claims under its OWN bearer, so `claimedBy` is the
 * seat's session id and the secret that could release it dies with the wrapper
 * process. Before this rule the only exit was the claim's 30-minute expiry.
 *
 * Every arm here seeds REAL session facts through `runSessionCommand` and reads
 * the verdict back off the durable work ledger, so nothing is asserted against a
 * reimplementation of the predicate.
 */
describe("a claim whose holder seat is not live may be released by a non-claimant", () => {
  const HELD = "node.deliver@dead-seat-node";
  const OPERATOR = "operator-local";

  function holdItem(target: SqliteEventStore, projectId: string, holder: string): void {
    const claimed = runOn(
      target, projectId, "work.claim", holder, { expiresAt: LATER, workItemId: HELD },
    );
    if (!claimed.ok) throw new Error(claimed.code);
  }

  function expectAdmittedRelease(target: SqliteEventStore, projectId: string, holder: string) {
    const outcome = runOn(
      target, projectId, "work.release", OPERATOR, { workItemId: HELD }, 1,
    );
    expect(outcome).toMatchObject({ disposition: "DECIDED", ok: true });
    // The RECORD, not just the outcome: the release commits WorkReleased and the
    // ledger still names the holder that was released.
    expect(readWorkClaimLedger(target, projectId).claims.get(HELD)).toMatchObject({
      claimedBy: holder, status: "RELEASED",
    });
    expect(target.readEvents(aggregateIdFor(HELD)).map((event) => event.eventType))
      .toEqual(["WorkClaimed", "WorkReleased"]);
  }

  it("admits the release when the holder's only seat session is CLOSED", () => {
    const projectId = "proj-dead-seat-closed";
    const target = seatStore(projectId);
    openSeat(target, projectId, "sess-dead-closed", "2026-08-09T15:00:00.000Z");
    closeSeat(target, projectId, "sess-dead-closed");
    holdItem(target, projectId, "sess-dead-closed");

    expectAdmittedRelease(target, projectId, "sess-dead-closed");
  });

  it("admits the release when the holder's seat is OPEN but expired at decidedAt", () => {
    const projectId = "proj-dead-seat-expired";
    const target = seatStore(projectId);
    // OPEN, never closed, and already past its horizon when the daemon decides.
    openSeat(target, projectId, "sess-dead-expired", "2026-08-09T11:45:00.000Z");
    holdItem(target, projectId, "sess-dead-expired");

    expectAdmittedRelease(target, projectId, "sess-dead-expired");
  });

  it("admits the release when the holder has no seat session at all", () => {
    const projectId = "proj-dead-seat-absent";
    const target = seatStore(projectId);
    holdItem(target, projectId, "sess-dead-absent");
    expect(readSessionLedger(target, projectId).sessions.size).toBe(0);

    expectAdmittedRelease(target, projectId, "sess-dead-absent");
  });

  it("still refuses a non-claimant work.renew when the holder is dead", () => {
    const projectId = "proj-dead-seat-renew";
    const target = seatStore(projectId);
    holdItem(target, projectId, "sess-dead-renew");

    const outcome = runOn(target, projectId, "work.renew", OPERATOR, {
      expiresAt: "2026-08-09T14:00:00.000Z", workItemId: HELD,
    }, 1);

    // Only RELEASE widens. Renewal is the holder's keepalive and would let a
    // stranger extend a fence it does not own.
    expect(outcome).toMatchObject({
      code: "WORK_CLAIM_NOT_CLAIMANT", ok: false, refusedBy: "DAEMON_PREREQUISITE",
    });
    expect(readWorkClaimLedger(target, projectId).claims.get(HELD)).toMatchObject({
      expiresAt: LATER, status: "OPEN",
    });
  });

  it("refuses the release while any seat session of the holder is LIVE", () => {
    const projectId = "proj-dead-seat-live";
    const target = seatStore(projectId);
    openSeat(target, projectId, "sess-live-holder", "2026-08-09T15:00:00.000Z");
    holdItem(target, projectId, "sess-live-holder");

    const outcome = runOn(
      target, projectId, "work.release", OPERATOR, { workItemId: HELD }, 1,
    );

    expect(outcome).toMatchObject({
      code: "WORK_CLAIM_NOT_CLAIMANT", ok: false, refusedBy: "DAEMON_PREREQUISITE",
    });
    expect(readWorkClaimLedger(target, projectId).claims.get(HELD)).toMatchObject({
      status: "OPEN",
    });
    expect(target.readEvents(aggregateIdFor(HELD)).map((event) => event.eventType))
      .toEqual(["WorkClaimed"]);
  });

  it("lets the dead holder itself release, exactly as before", () => {
    const projectId = "proj-dead-seat-self";
    const target = seatStore(projectId);
    openSeat(target, projectId, "sess-self", "2026-08-09T15:00:00.000Z");
    closeSeat(target, projectId, "sess-self");
    holdItem(target, projectId, "sess-self");

    const outcome = runOn(
      target, projectId, "work.release", "sess-self", { workItemId: HELD }, 1,
    );

    expect(outcome).toMatchObject({ disposition: "DECIDED", ok: true });
  });

  it("refuses the release when the session ledger is unreadable, failing closed", () => {
    const projectId = "proj-dead-seat-unreadable";
    const target = seatStore(projectId);
    holdItem(target, projectId, "sess-unreadable");
    corruptSessionLedger(target, projectId);
    // The precondition itself, or this arm would silently be arm 3 again.
    expect(readSessionLedger(target, projectId).unreadable).toBe(true);

    const outcome = runOn(
      target, projectId, "work.release", OPERATOR, { workItemId: HELD }, 1,
    );

    // Corrupt bytes are not evidence the holder is dead: a fold that could not
    // be understood must never read as "nobody is home".
    expect(outcome).toMatchObject({
      code: "WORK_CLAIM_NOT_CLAIMANT", ok: false, refusedBy: "DAEMON_PREREQUISITE",
    });
    expect(target.readEvents(aggregateIdFor(HELD)).map((event) => event.eventType))
      .toEqual(["WorkClaimed"]);
  });
});

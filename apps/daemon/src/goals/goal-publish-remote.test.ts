import type { CommandDecisionRecord, SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  GOAL_ID,
  PROJECT_ID,
  closeStores,
  decisionCount,
  driveThrough,
  envelope,
  openStore,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { PAYLOAD_KEYS } from "../daemon-command-vocabulary.js";
import { readProjectRemote } from "../repository/publish-ledger.js";
import {
  PUBLISH_REMOTE_UNBOUND,
  PUBLISH_REMOTE_URL_INVALID,
  REMOTE_BOUND_EVENT_TYPE,
  publishAggregateId,
  remoteAggregateId,
} from "../repository/publish-receipt-contracts.js";

/**
 * `repository.publish` binds the PROJECT's remote on its way through, and reuses it afterwards.
 *
 * The command's payload roster is frozen at `["goalId", "remoteUrl"]` — a new key would be a
 * twenty-file roster backfill — so the second publish says "the one you already named" by
 * sending `remoteUrl: null` rather than by naming a new command. Every arm below therefore has
 * to distinguish three values of one key: a STRING (bind it), NULL (resolve it) and ANYTHING
 * ELSE, including a MISSING key, which is a malformed request and must never be read as null.
 *
 * The binding is the SECOND LEG of the publish decision, not a decision of its own: a crash
 * between two decisions would leave a publish whose remote was never recorded, or a binding for
 * a publish that never happened. Every arm reads the durable aggregates back out of the store,
 * so a handler that refused after writing — or accepted without writing — reddens here.
 */

const REMOTE_A = "https://github.com/fixture/repo.git";
const REMOTE_B = "git@github.com:fixture/other.git";
const DECIDED_AT = "2026-08-08T00:00:00.000Z";
const PRINCIPAL = "principal-1";

afterEach(closeStores);

function publish(
  store: SqliteEventStore,
  expectedVersion: number,
  payload: Record<string, unknown>,
  commandId: string,
): ReturnType<typeof send> {
  return send(store, envelope("repository.publish", expectedVersion, payload, commandId));
}

/** The publish payload as production sends it: exactly the two rostered keys. */
function remotePayload(remoteUrl: unknown): Record<string, unknown> {
  return { goalId: GOAL_ID, remoteUrl };
}

function decodePayload(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

/** Every `RepositoryRemoteBound` payload on the project's remote aggregate, in ledger order. */
function boundEvents(store: SqliteEventStore): readonly Record<string, unknown>[] {
  return store.readEvents(remoteAggregateId(PROJECT_ID))
    .filter((event) => event.eventType === REMOTE_BOUND_EVENT_TYPE)
    .map((event) => decodePayload(event.payload));
}

function resultOf(decision: CommandDecisionRecord): Record<string, unknown> {
  return decodePayload(decision.resultBytes);
}

function expectRefusal(
  outcome: ReturnType<typeof send>, code: string, refusedBy: string,
): void {
  expect(outcome.ok, outcome.ok ? "expected a refusal" : "").toBe(false);
  if (outcome.ok) throw new Error("expected a refusal");
  expect(outcome.code).toBe(code);
  expect(outcome.refusedBy).toBe(refusedBy);
  expect(outcome.advisoryOnly).toBe(true);
  expect(outcome.authority).toBe("NONE");
}

describe("repository.publish binds the project remote", () => {
  it("keeps the frozen payload roster: the remote binds through an EXISTING key", () => {
    // Restated by hand at the point of use. A future key added to carry the binding would be the
    // roster backfill this design exists to avoid, and would redden here as well as in the two
    // vocabulary pins.
    expect(PAYLOAD_KEYS["repository.publish"]).toEqual(["goalId", "remoteUrl"]);
  });

  it("commits the publish request unchanged AND binds the remote in one decision", () => {
    const store = openStore();
    driveThrough(store, "repository.publish");
    const before = decisionCount(store);

    const outcome = publish(store, 0, remotePayload(REMOTE_A), "cmd-publish-1");

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    if (!outcome.ok) throw new Error("expected acceptance");
    // ONE decision, not two: the binding rides the publish decision's second leg.
    expect(decisionCount(store)).toBe(before + 1);
    // The result shape is FROZEN — the publisher, the receipt and the runs read all decode it.
    const result = resultOf(outcome.decision);
    expect(Object.keys(result).sort()).toEqual(["goalId", "remoteUrl", "requestedAt"]);
    expect(result).toEqual({ goalId: GOAL_ID, remoteUrl: REMOTE_A, requestedAt: DECIDED_AT });
    // The publish leg landed on the goal's publish aggregate, exactly as before.
    expect(store.readEvents(publishAggregateId(GOAL_ID)).map((event) => event.eventType))
      .toEqual(["RepositoryPublishRequested"]);
    // ...and the binding landed on the PROJECT's remote aggregate.
    expect(boundEvents(store)).toEqual([
      { boundAt: DECIDED_AT, boundBy: PRINCIPAL, remoteUrl: REMOTE_A },
    ]);
    expect(readProjectRemote(store, PROJECT_ID))
      .toEqual({ boundAt: DECIDED_AT, boundBy: PRINCIPAL, remoteUrl: REMOTE_A });
  });

  it("resolves the bound remote for a null publish without binding a second time", () => {
    const store = openStore();
    driveThrough(store, "repository.publish");
    expect(publish(store, 0, remotePayload(REMOTE_A), "cmd-publish-1").ok).toBe(true);

    const outcome = publish(store, 1, remotePayload(null), "cmd-publish-2");

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    if (!outcome.ok) throw new Error("expected acceptance");
    // The RESOLVED url is in the result, which is what keeps the publisher untouched: it reads
    // `request.remoteUrl` off the publish ledger and never learns the binding exists.
    expect(resultOf(outcome.decision))
      .toEqual({ goalId: GOAL_ID, remoteUrl: REMOTE_A, requestedAt: DECIDED_AT });
    // Reusing a remote is not rebinding it: still exactly ONE binding event.
    expect(boundEvents(store)).toHaveLength(1);
    expect(store.readEvents(publishAggregateId(GOAL_ID))).toHaveLength(2);
  });

  it("rebinds when a later publish names a DIFFERENT remote", () => {
    const store = openStore();
    driveThrough(store, "repository.publish");
    expect(publish(store, 0, remotePayload(REMOTE_A), "cmd-publish-1").ok).toBe(true);

    expect(publish(store, 1, remotePayload(REMOTE_B), "cmd-publish-2").ok).toBe(true);

    expect(boundEvents(store)).toEqual([
      { boundAt: DECIDED_AT, boundBy: PRINCIPAL, remoteUrl: REMOTE_A },
      { boundAt: DECIDED_AT, boundBy: PRINCIPAL, remoteUrl: REMOTE_B },
    ]);
    expect(readProjectRemote(store, PROJECT_ID)?.remoteUrl).toBe(REMOTE_B);
    // A third, null publish now resolves the NEW remote — the read is a fold, not a first-wins.
    const reused = publish(store, 2, remotePayload(null), "cmd-publish-3");
    expect(reused.ok, reused.ok ? "" : reused.code).toBe(true);
    if (!reused.ok) throw new Error("expected acceptance");
    expect(resultOf(reused.decision)["remoteUrl"]).toBe(REMOTE_B);
  });

  it("refuses a null publish while nothing is bound, and writes nothing", () => {
    const store = openStore();
    driveThrough(store, "repository.publish");
    const before = decisionCount(store);

    const outcome = publish(store, 0, remotePayload(null), "cmd-publish-1");

    expectRefusal(outcome, PUBLISH_REMOTE_UNBOUND, "DAEMON_PREREQUISITE");
    expect(PUBLISH_REMOTE_UNBOUND).toBe("PUBLISH_REMOTE_UNBOUND");
    expect(store.readEvents(remoteAggregateId(PROJECT_ID))).toHaveLength(0);
    expect(store.readEvents(publishAggregateId(GOAL_ID))).toHaveLength(0);
    expect(decisionCount(store)).toBe(before);
  });

  it.each([
    ["an embedded credential", "https://user:secret@github.com/o/r.git"],
    ["a scheme git cannot push", "file:///tmp/x"],
    ["an empty string, which is not null", ""],
    ["a url past the length bound", `https://github.com/o/${"r".repeat(2048)}`],
  ])("refuses %s at the ingress and binds nothing", (_label, remoteUrl) => {
    const store = openStore();
    driveThrough(store, "repository.publish");
    const before = decisionCount(store);

    const outcome = publish(store, 0, remotePayload(remoteUrl), "cmd-publish-1");

    expectRefusal(outcome, PUBLISH_REMOTE_URL_INVALID, "DAEMON_INGRESS");
    expect(PUBLISH_REMOTE_URL_INVALID).toBe("PUBLISH_REMOTE_URL_INVALID");
    expect(readProjectRemote(store, PROJECT_ID)).toBeNull();
    expect(store.readEvents(remoteAggregateId(PROJECT_ID))).toHaveLength(0);
    expect(decisionCount(store)).toBe(before);
  });

  it.each([
    ["a number", 7],
    ["a boolean", false],
    ["an array", []],
    ["an object", { url: REMOTE_A }],
  ])("refuses %s as neither a string nor null", (_label, remoteUrl) => {
    const store = openStore();
    driveThrough(store, "repository.publish");

    const outcome = publish(store, 0, remotePayload(remoteUrl), "cmd-publish-1");

    expectRefusal(outcome, "BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_INGRESS");
    expect(store.readEvents(remoteAggregateId(PROJECT_ID))).toHaveLength(0);
  });

  /**
   * The sharpest arm in the file. `payload["remoteUrl"]` is `undefined` when the key is absent,
   * and `undefined == null` in JavaScript: a handler that tested loosely would silently treat a
   * MALFORMED request as "reuse the bound remote" and publish to it. The world here HAS a
   * binding, so a refusal cannot be an accident of an empty store.
   */
  it("refuses a MISSING remoteUrl key rather than reading it as null", () => {
    const store = openStore();
    driveThrough(store, "repository.publish");
    expect(publish(store, 0, remotePayload(REMOTE_A), "cmd-publish-1").ok).toBe(true);
    const before = decisionCount(store);

    const outcome = publish(store, 1, { goalId: GOAL_ID }, "cmd-publish-2");

    expectRefusal(outcome, "BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_INGRESS");
    expect(decisionCount(store)).toBe(before);
    expect(boundEvents(store)).toHaveLength(1);
    expect(store.readEvents(publishAggregateId(GOAL_ID))).toHaveLength(1);
  });

  it("admits a remote at the exact length bound and refuses one byte past it", () => {
    const store = openStore();
    driveThrough(store, "repository.publish");
    const prefix = "https://github.com/o/";
    const atBound = prefix + "r".repeat(2048 - prefix.length);
    expect(atBound).toHaveLength(2048);

    expect(publish(store, 0, remotePayload(atBound), "cmd-publish-1").ok).toBe(true);
    expect(readProjectRemote(store, PROJECT_ID)?.remoteUrl).toBe(atBound);

    expectRefusal(
      publish(store, 1, remotePayload(`${atBound}r`), "cmd-publish-2"),
      PUBLISH_REMOTE_URL_INVALID, "DAEMON_INGRESS",
    );
    expect(boundEvents(store)).toHaveLength(1);
  });

  it("refuses on the goal's own prerequisites BEFORE binding anything", () => {
    const store = openStore();
    driveThrough(store, "repository.publish");

    // A goal that does not exist: the lifecycle gate answers, and a handler that had bound the
    // remote first would leave a binding behind for a publish that never happened.
    const outcome = send(store, envelope(
      "repository.publish", 0, { goalId: "goal-absent", remoteUrl: REMOTE_A }, "cmd-publish-1",
    ));

    expectRefusal(outcome, "BOOTSTRAP_PREREQUISITE_MISSING", "DAEMON_PREREQUISITE");
    expect(store.readEvents(remoteAggregateId(PROJECT_ID))).toHaveLength(0);
  });

  it("records the operator's principal id in boundBy, never the url's own userinfo", () => {
    const store = openStore();
    driveThrough(store, "repository.publish");
    expect(publish(store, 0, remotePayload(REMOTE_B), "cmd-publish-1").ok).toBe(true);

    const bound = readProjectRemote(store, PROJECT_ID);
    expect(bound?.boundBy).toBe(PRINCIPAL);
    expect(bound?.boundBy).not.toContain("@");
  });
});

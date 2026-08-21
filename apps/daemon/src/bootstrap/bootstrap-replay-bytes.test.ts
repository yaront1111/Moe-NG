import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { decodeBootstrapRequestBytes } from "./bootstrap-contracts.js";
import type { BootstrapRequest } from "./bootstrap-contracts.js";
import { commitAccepted, decisionKey, replayOf } from "./bootstrap-ledger.js";
import {
  PROJECT_ID,
  bootstrapSequence,
  closeStores,
  decisionCount,
  driveThrough,
  envelope,
  openStore,
  send,
} from "./bootstrap-test-fixtures.js";
import type { Envelope } from "./bootstrap-test-fixtures.js";

/**
 * A replay must PROVE same bytes before it echoes an earlier decision's authority.
 *
 * `replayOf` keys on {commandId, principalId, projectId} — which does not include the payload —
 * and answers before any handler or store write runs. Without a byte compare, resubmitting a used
 * commandId under the same kind with a DIFFERENT payload returns the earlier result as
 * "ok, REPLAYED": authority for a command that was never decided with those bytes. Nothing
 * downstream can catch it, because the short-circuit happens before the store's own conflict arm
 * is ever consulted.
 *
 * Every refusal case names the stable code AND the layer. Two daemon guards sit here — the
 * kind-mismatch guard and the new byte compare — so asserting only "it refused" would go vacuous
 * the moment the other one starts answering first.
 */

const decoder = new TextDecoder();
const encoder = new TextEncoder();

afterEach(closeStores);

function requestOf(request: Envelope): BootstrapRequest {
  const decoded = decodeBootstrapRequestBytes(encoder.encode(JSON.stringify(request)));
  if (!decoded.ok) throw new Error(`the fixture envelope did not decode: ${decoded.code}`);
  return decoded.request;
}

interface Snapshot {
  readonly decisionSha256: string;
  readonly replayRequestSha256: string | null;
  readonly result: string;
  readonly resultSha256: string;
}

/** The stored decision as immutable evidence: what a refusal must leave byte-identical. */
function snapshotDecision(store: SqliteEventStore, request: Envelope): Snapshot {
  const stored = store.getCommandDecision(decisionKey(requestOf(request)));
  if (stored === null) throw new Error("the committed decision is missing");
  return {
    decisionSha256: stored.decisionSha256,
    replayRequestSha256: stored.replayRequestSha256,
    result: decoder.decode(stored.resultBytes),
    resultSha256: stored.resultSha256,
  };
}

/**
 * The kinds this suite drives a conflicting resubmit through. The check lives in the ONE seam
 * every kind passes, so a second and third kind is the evidence that it is not a per-handler
 * patch; `plan.propose` additionally commits through the MULTI-LEG seam.
 */
const CONFLICT_CASES = [
  { conflicting: { owner: "owner-2" }, index: 0, kind: "project.register" },
  { conflicting: { slice: { rules: [] } }, index: 3, kind: "policy.install" },
  { conflicting: { commands: [], runId: "run-other" }, index: 7, kind: "plan.propose" },
] as const;

function originalOf(index: number): Envelope {
  return bootstrapSequence()[index] as Envelope;
}

function conflictingOf(entry: (typeof CONFLICT_CASES)[number]): Envelope {
  const original = originalOf(entry.index);
  return { ...original, payload: entry.conflicting };
}

describe("bootstrap replay proves same bytes — the shared seam", () => {
  it("generates one conflicting case per named kind, and they are distinct", () => {
    expect(CONFLICT_CASES).toHaveLength(3);
    expect(new Set(CONFLICT_CASES.map((entry) => entry.kind)).size).toBe(3);
    for (const entry of CONFLICT_CASES) {
      expect(originalOf(entry.index).kind).toBe(entry.kind);
      expect(JSON.stringify(originalOf(entry.index).payload))
        .not.toBe(JSON.stringify(entry.conflicting));
    }
  });

  it.each(CONFLICT_CASES.map((entry) => [entry.kind, entry] as const))(
    "%s replays a byte-identical resubmit and refuses a conflicting one",
    (kind, entry) => {
      const store = openStore();
      driveThrough(store, kind);
      const original = originalOf(entry.index);

      const first = send(store, original);
      expect(first.ok, first.ok ? "" : first.code).toBe(true);
      if (!first.ok) throw new Error("the accepted control was refused");
      expect(first.disposition).toBe("DECIDED");

      const replayed = send(store, original);
      expect(replayed.ok).toBe(true);
      if (!replayed.ok) throw new Error("the byte-identical replay control was refused");
      expect(replayed.disposition).toBe("REPLAYED");
      expect(decoder.decode(replayed.decision.resultBytes))
        .toBe(decoder.decode(first.decision.resultBytes));

      const before = snapshotDecision(store, original);
      const decisions = decisionCount(store);
      const events = store.readEvents(first.decision.targetAggregateId).length;

      const conflicting = send(store, conflictingOf(entry));

      expect(conflicting.ok).toBe(false);
      if (conflicting.ok) throw new Error("the conflicting resubmit was accepted");
      expect(conflicting.code).toBe("BOOTSTRAP_COMMAND_BYTES_CONFLICT");
      expect(conflicting.refusedBy).toBe("DAEMON_PREREQUISITE");
      expect(conflicting.authority).toBe("NONE");
      expect(conflicting.advisoryOnly).toBe(true);
      expect(snapshotDecision(store, original)).toEqual(before);
      expect(decisionCount(store)).toBe(decisions);
      expect(store.readEvents(first.decision.targetAggregateId).length).toBe(events);
    },
    90_000,
  );
});

describe("bootstrap replay proves same bytes — guard ordering and unprovable rows", () => {
  it("still answers BOOTSTRAP_COMMAND_ID_REUSED when the reused id changes kind", () => {
    const store = openStore();
    const registered = originalOf(0);
    expect(send(store, registered).ok).toBe(true);

    // Same commandId, DIFFERENT kind, and different payload bytes too — so if the byte compare
    // were ordered first it would answer here and the kind guard would go silent.
    const reused = send(store, {
      ...envelope("policy.install", 0, { slice: { rules: [] } }, registered.commandId),
    });

    expect(reused.ok).toBe(false);
    if (reused.ok) throw new Error("the reused command id was accepted");
    expect(reused.code).toBe("BOOTSTRAP_COMMAND_ID_REUSED");
    expect(reused.refusedBy).toBe("DAEMON_PREREQUISITE");
  });

  /**
   * A refused command's decision row carries no same-bytes evidence — its receipt commits the
   * rejection audit payload, not the request. `replayOf` must decline to answer from such a row
   * at all rather than treat "no evidence" as a match. The NO_BUSINESS_EFFECT row here is written
   * by the production commit seam under a stale fence, not forged.
   */
  it("never replays from a decision that carries no same-bytes evidence", () => {
    const store = openStore();
    driveThrough(store, "goal.create");
    const stale = requestOf(envelope("project.register", 0, { owner: "owner-1" }, "cmd-stale"));

    const refused = commitAccepted(store, stale, {
      aggregateId: PROJECT_ID,
      eventPayload: { kind: "ignored" },
      eventType: "project.registered",
      expectedVersion: 0,
      result: { ignored: true },
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("the stale fence was accepted");
    expect(refused.refusedBy).toBe("DURABLE_STORE");
    const stored = store.getCommandDecision(decisionKey(stale));
    expect(stored?.effectDisposition).toBe("NO_BUSINESS_EFFECT");
    expect(stored?.replayRequestSha256).toBeNull();

    expect(replayOf(store, stale)).toBeNull();
    const otherBytes = requestOf(
      envelope("project.register", 0, { owner: "owner-9" }, "cmd-stale"),
    );
    expect(replayOf(store, otherBytes)).toBeNull();
  });
});

/**
 * THE DURABLE READBACK: one digest over everything a store holds, so a refused request can be
 * proved to have changed NOTHING.
 *
 * A hostile request's refusal is only half the claim. The other half — nothing was written —
 * cannot be carried by "no new command decision appeared": an event appended without a
 * decision, a work claim silently opened, or a payload rewritten in place would all leave that
 * assertion green. So the readback digests EVERY event (global position, type, aggregate,
 * sequence and its payload bytes) and EVERY command decision (its own `decisionSha256`), and
 * the hostile arms compare the digest byte for byte across the request.
 *
 * Payload bytes are HASHED, never decoded. A reader that parsed them could disagree with the
 * store about what was stored, and this is precisely the question where a reader's opinion
 * must not be able to stand in for the bytes.
 *
 * `readable` is carried rather than swallowed: a store that could not be opened must never
 * read as "the state is unchanged", which is the fail-open shape of this whole question.
 *
 * NO WALL CLOCK AND NO RANDOM SOURCE — `e2e-harness.test.ts` scans every non-test module in
 * this directory for four needles by plain substring match.
 */
import { createHash } from "node:crypto";

import type { SqliteEventStore } from "@moe/store";

// The claim fold is not on the daemon's barrel, and this task certifies rather than edits
// production: the read model is imported at its own path instead of widening an export list.
import { readWorkClaimLedger } from "../../../apps/daemon/src/work/work-claim-read-model.js";
import { withStore } from "./j1-ledger-view.js";
import type { J1Scratch } from "./j1-loop-harness.js";

const PAGE_SIZE = 200;

export interface DurableReadback {
  readonly claimCount: number;
  readonly decisionCount: number;
  readonly digest: string;
  readonly eventCount: number;
  readonly readable: boolean;
}

/** Every event in the store, in global position order. */
function eventLines(store: SqliteEventStore): readonly string[] {
  const lines: string[] = [];
  let cursor = 0n;
  for (;;) {
    const page = store.readEventsAfter(cursor, PAGE_SIZE);
    for (const event of page.items) {
      lines.push([
        String(event.globalPosition),
        event.aggregateId,
        String(event.aggregateSequence),
        event.eventType,
        event.eventId,
        createHash("sha256").update(event.payload).digest("hex"),
      ].join("|"));
    }
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return lines;
}

/** Every command decision, identified by the digest the store itself computed for it. */
function decisionLines(store: SqliteEventStore): readonly string[] {
  const lines: string[] = [];
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, PAGE_SIZE);
    for (const decision of page.items) {
      lines.push([
        String(decision.decisionPosition),
        decision.key.principalId,
        decision.commandKind,
        decision.decisionId,
        decision.decisionSha256,
        decision.effectDisposition,
      ].join("|"));
    }
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return lines;
}

export interface DurableLines {
  readonly claimCount: number;
  readonly decisions: readonly string[];
  readonly events: readonly string[];
  readonly readable: boolean;
}

/**
 * The durable state as ORDERED LINES rather than a digest.
 *
 * Design line 1101 requires old plans, attempts, receipts and reviews to remain readable
 * after a re-plan. That is a claim about history being APPENDED to, not rewritten, and a
 * digest can only answer "same or different" — so J4 asserts the pre-replan lines are still a
 * prefix of the post-replan lines, which a rewritten row breaks and a digest comparison could
 * not distinguish from an ordinary append.
 */
export function durableLines(scratch: J1Scratch): DurableLines {
  return withStore(scratch, (store) => {
    const claims = readWorkClaimLedger(store, scratch.projectId);
    return {
      claimCount: claims.claims.size,
      decisions: decisionLines(store),
      events: eventLines(store),
      readable: !claims.unreadable,
    };
  });
}

/**
 * The whole durable state as one digest plus the counts that make a zero-row readback
 * self-evident: two digests that agree over an EMPTY store would agree vacuously, so the
 * counts travel with the digest and the arms assert them.
 */
export function durableReadback(scratch: J1Scratch): DurableReadback {
  try {
    const lines = durableLines(scratch);
    return {
      claimCount: lines.claimCount,
      decisionCount: lines.decisions.length,
      digest: createHash("sha256")
        .update([...lines.events, "--", ...lines.decisions].join("\n"), "utf8")
        .digest("hex"),
      eventCount: lines.events.length,
      readable: lines.readable,
    };
  } catch {
    return { claimCount: 0, decisionCount: 0, digest: "", eventCount: 0, readable: false };
  }
}

export interface ClaimOwner {
  readonly claimedBy: string;
  readonly status: string;
  readonly workItemId: string;
}

/**
 * The durable owner record, folded through the DAEMON's own claim read model.
 *
 * DoD 3's "no duplicate authority" is an end-state claim here and a DURING claim in
 * `authorityWatcher`; both are needed. This one answers "after the handoff, who owns it",
 * which a sampler that stopped when the processes died cannot answer.
 */
export function claimOwners(scratch: J1Scratch): readonly ClaimOwner[] {
  return withStore(scratch, (store) => {
    const ledger = readWorkClaimLedger(store, scratch.projectId);
    if (ledger.unreadable) throw new Error("the work claim ledger is unreadable");
    return [...ledger.claims.values()]
      .map((claim) => ({
        claimedBy: claim.claimedBy,
        status: claim.status,
        workItemId: claim.workItemId,
      }))
      .sort((left, right) => left.workItemId.localeCompare(right.workItemId));
  });
}

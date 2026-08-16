import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_STAFFING_LAYER,
  AGENT_STAFFING_REFUSAL_CODES,
  createAgentSessionFence,
} from "./agent-session-fence.js";
import { WORK_CLAIM_SCHEMA_VERSION } from "../work/work-claim-contracts.js";
import { runWorkClaimCommand } from "../work/work-claim-services.js";

/**
 * The fence answers ONE question: may this wrapper staff this work item right now?
 *
 * The defect it closes is not "the claim is held" — the command layer already
 * refuses that with WORK_CLAIM_HELD. It is the opposite case: a claim that has
 * EXPIRED while its agent child is still alive. `activeClaim` nulls an expired
 * claim (work-claim-services.ts:134), the affordance surface therefore projects
 * `claim: null` (affordance-read.ts:74-76), and the wrapper's only remaining
 * guard is a process-local Map (agent-wrapper.ts:343). A second live agent then
 * gets staffed on an item that already has one running.
 *
 * So cases 2 and 3 MUST carry distinct codes. Collapsing them would make this
 * suite pass while the reported class stays open — the expired-but-live case
 * would be indistinguishable from ordinary contention.
 *
 * Every refusal asserts the code AND the layer: two layers can refuse staffing
 * here, and a test asserting only `ok === false` goes vacuous the moment
 * another guard starts answering first. Every refusal also asserts the store's
 * raw event horizon did not move — a gate that refuses but writes has mutated
 * durable state on a path that was supposed to be inert.
 */

const PROJECT = "proj-agent-fence";
const ITEM = "node.deliver@node-live-1";
const CLAIM_AT = "2026-08-09T12:00:00.000Z";
const CLAIM_EXPIRES = "2026-08-09T13:00:00.000Z";
const BEFORE_EXPIRY = "2026-08-09T12:30:00.000Z";
const AFTER_EXPIRY = "2026-08-09T14:00:00.000Z";

const encoder = new TextEncoder();
const roots: string[] = [];
const stores: SqliteEventStore[] = [];
let sequence = 0;

afterEach(() => {
  // A held SQLite handle kills the vitest worker outright, so every handle this
  // file opens is closed here, including the reopened one in the durability case.
  while (stores.length > 0) stores.pop()?.close();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { force: true, maxRetries: 5, recursive: true });
  }
});

/** Opened inside a case, never in a describe body: a held handle kills the worker. */
function scratchPath(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `moe-agent-fence-${label}-`));
  roots.push(root);
  return join(root, "project.db");
}

function openAt(path: string): SqliteEventStore {
  const store = SqliteEventStore.openForProject(path, PROJECT);
  stores.push(store);
  return store;
}

/**
 * Seeds the claim through the PRODUCTION work-claim command rather than writing
 * a store row by hand. A hand-written row could encode a claim shape no real
 * command can produce, and the fence would then be proven against a fiction.
 */
function seedClaim(store: SqliteEventStore, expiresAt: string): void {
  const outcome = runWorkClaimCommand(store, encoder.encode(JSON.stringify({
    commandId: `cmd-fence-claim-${String(sequence += 1)}`,
    correlationId: "corr-fence",
    decidedAt: CLAIM_AT,
    expectedVersion: 0,
    kind: "work.claim",
    payload: { expiresAt, workItemId: ITEM },
    principalId: "agent-first",
    projectId: PROJECT,
    schemaVersion: WORK_CLAIM_SCHEMA_VERSION,
  })));
  expect(outcome).toMatchObject({ ok: true });
}

function fenceOn(store: SqliteEventStore): ReturnType<typeof createAgentSessionFence> {
  return createAgentSessionFence({ projectId: PROJECT, store });
}

function recordChild(store: SqliteEventStore, claimAggregateVersion: number): void {
  fenceOn(store).recordLiveChild({
    claimAggregateVersion,
    sessionId: "sess-wrap-first",
    workItemId: ITEM,
  });
}

describe("agent session fence", () => {
  it("admits an item with no durable claim and no recorded live child", () => {
    const store = openAt(scratchPath("fresh"));

    expect(fenceOn(store).admit(ITEM, BEFORE_EXPIRY)).toMatchObject({ ok: true });
  });

  it("refuses an item whose durable claim is still active", () => {
    const store = openAt(scratchPath("held"));
    seedClaim(store, CLAIM_EXPIRES);
    const horizon = store.readEventHorizon();

    expect(fenceOn(store).admit(ITEM, BEFORE_EXPIRY)).toMatchObject({
      code: "AGENT_STAFFING_CLAIM_HELD",
      layer: AGENT_STAFFING_LAYER,
      ok: false,
    });
    expect(store.readEventHorizon()).toBe(horizon);
  });

  it("refuses an EXPIRED claim whose live child was never retired, with a DISTINCT code", () => {
    const store = openAt(scratchPath("expired-live"));
    seedClaim(store, CLAIM_EXPIRES);
    recordChild(store, 1);
    const horizon = store.readEventHorizon();

    const decision = fenceOn(store).admit(ITEM, AFTER_EXPIRY);

    // The reported class. If this ever equals the held-claim code the suite has
    // gone vacuous: the durable claim says UNCLAIMED here, so only the live-child
    // record can be answering.
    expect(decision).toMatchObject({
      code: "AGENT_STAFFING_CHILD_LIVE",
      layer: AGENT_STAFFING_LAYER,
      ok: false,
    });
    expect(store.readEventHorizon()).toBe(horizon);
  });

  it("keeps the two refusal causes on distinct codes", () => {
    expect(new Set(AGENT_STAFFING_REFUSAL_CODES).size).toBe(AGENT_STAFFING_REFUSAL_CODES.length);
    expect(AGENT_STAFFING_REFUSAL_CODES).toContain("AGENT_STAFFING_CLAIM_HELD");
    expect(AGENT_STAFFING_REFUSAL_CODES).toContain("AGENT_STAFFING_CHILD_LIVE");
  });

  it("admits again once the expired claim's child is durably retired", () => {
    // Task rail 2: a genuinely dead predecessor must still be replaceable, or
    // this fence becomes a permanent wedge — worse than the race it closes.
    const store = openAt(scratchPath("retired"));
    seedClaim(store, CLAIM_EXPIRES);
    const fence = fenceOn(store);
    fence.recordLiveChild({
      claimAggregateVersion: 1,
      sessionId: "sess-wrap-first",
      workItemId: ITEM,
    });
    fence.retireLiveChild(ITEM);

    expect(fence.admit(ITEM, AFTER_EXPIRY)).toMatchObject({ ok: true });
  });

  it("refuses when the staffing record carries an event type it cannot understand", () => {
    // The fail-closed branch, driven by a real committed event rather than by a
    // stubbed reader. A fold that SKIPS what it does not recognise would read
    // this aggregate as empty and admit — which is how a fence quietly stops
    // fencing while every other case in this file stays green.
    const store = openAt(scratchPath("unreadable"));
    const aggregateId = `wrapper-staffing/${createHash("sha256").update(ITEM, "utf8")
      .digest("hex")}`;
    store.commit({
      aggregateId,
      commandBytes: encoder.encode(JSON.stringify({ probe: "unknown-type" })),
      commandId: "stf-unknown-type",
      committedAt: CLAIM_AT,
      events: [{
        eventId: "stf-unknown-type-e1",
        eventType: "AgentStaffingSomethingNobodyWrote",
        payload: encoder.encode(JSON.stringify({ workItemId: ITEM })),
      }],
      expectedVersion: 0,
    });
    const horizon = store.readEventHorizon();

    expect(fenceOn(store).admit(ITEM, AFTER_EXPIRY)).toMatchObject({
      code: "AGENT_STAFFING_RECORD_UNREADABLE",
      layer: AGENT_STAFFING_LAYER,
      ok: false,
    });
    expect(store.readEventHorizon()).toBe(horizon);
  });

  it("still refuses through a REOPENED store handle, proving the record is durable", () => {
    // The whole point of the fix: the existing in-process Map already refuses a
    // second pass inside one process. Only a durable record survives the wrapper
    // restart that actually produced the reported occurrences.
    const path = scratchPath("durable");
    const first = openAt(path);
    seedClaim(first, CLAIM_EXPIRES);
    recordChild(first, 1);
    first.close();
    stores.pop();

    const reopened = openAt(path);
    const horizon = reopened.readEventHorizon();

    expect(fenceOn(reopened).admit(ITEM, AFTER_EXPIRY)).toMatchObject({
      code: "AGENT_STAFFING_CHILD_LIVE",
      layer: AGENT_STAFFING_LAYER,
      ok: false,
    });
    expect(reopened.readEventHorizon()).toBe(horizon);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { WORK_CLAIM_SCHEMA_VERSION } from "./work-claim-contracts.js";
import { runWorkClaimCommand } from "./work-claim-services.js";

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
  decidedAt = "2026-08-09T12:00:00.000Z", commandId?: string,
) {
  return runWorkClaimCommand(store, encoder.encode(JSON.stringify({
    commandId: commandId ?? `cmd-claim-${String(sequence += 1)}`,
    correlationId: "corr-claim",
    decidedAt,
    expectedVersion: 0,
    kind,
    payload,
    principalId,
    projectId: PROJECT,
    schemaVersion: WORK_CLAIM_SCHEMA_VERSION,
  })));
}

const ITEM = "goal.create@goal-live-1";
const LATER = "2026-08-09T13:00:00.000Z";

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
    });
    expect(renewed).toMatchObject({ ok: true });
    const released = run("work.release", "agent-a", { workItemId: ITEM });
    expect(released).toMatchObject({ ok: true });
    const reclaimed = run("work.claim", "agent-b", { expiresAt: LATER, workItemId: ITEM });
    expect(reclaimed).toMatchObject({ disposition: "DECIDED", ok: true });
  });

  it("lets an expired claim be taken over at the daemon's decide time", () => {
    const item = "plan.propose@run-live-1";
    run("work.claim", "agent-a", { expiresAt: "2026-08-09T12:30:00.000Z", workItemId: item });
    const takeover = run(
      "work.claim", "agent-b",
      { expiresAt: "2026-08-09T15:00:00.000Z", workItemId: item },
      "2026-08-09T12:31:00.000Z",
    );
    expect(takeover).toMatchObject({ disposition: "DECIDED", ok: true });
  });

  it("replays an identical command instead of double-claiming", () => {
    const item = "policy.install@proj-policy";
    const first = run(
      "work.claim", "agent-a", { expiresAt: LATER, workItemId: item },
      "2026-08-09T12:00:00.000Z", "cmd-claim-fixed",
    );
    expect(first).toMatchObject({ disposition: "DECIDED", ok: true });
    const replay = run(
      "work.claim", "agent-a", { expiresAt: LATER, workItemId: item },
      "2026-08-09T12:00:00.000Z", "cmd-claim-fixed",
    );
    expect(replay).toMatchObject({ disposition: "REPLAYED", ok: true });
  });

  it("refuses a malformed payload with the ingress code", () => {
    const outcome = run("work.claim", "agent-a", { workItemId: ITEM });
    expect(outcome).toMatchObject({
      code: "WORK_CLAIM_PAYLOAD_INVALID", ok: false, refusedBy: "DAEMON_INGRESS",
    });
  });
});

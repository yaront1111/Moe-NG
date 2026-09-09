import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { createStoreDependencies } from "../daemon-store-dependencies.js";
import type { AffordancePort } from "../http/affordance-contract.js";
import { workItemIdFor } from "../http/affordance-read.js";
import type { CommandAdapterDeps } from "../http/http-contract.js";
import { SESSION_SCHEMA_VERSION } from "../identity/session-contracts.js";
import { readSessionLedger } from "../identity/session-read-model.js";
import { runSessionCommand } from "../identity/session-services.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { WORK_CLAIM_SCHEMA_VERSION } from "../work/work-claim-contracts.js";
import { readWorkClaimLedger, runWorkClaimCommand } from "../work/work-claim-services.js";
import type { AgentSpawnStartResult } from "./agent-spawn-contract.js";
import { createAgentSessionFence } from "./agent-session-fence.js";
import { createAgentWrapper } from "./agent-wrapper.js";
import type { SpawnRequest } from "./agent-wrapper.js";
import { enumerateLiveChildren, runReclaimPass } from "./agent-wrapper-reclaim.js";

/**
 * The boot-time reclaim, over the REAL provider, the REAL command adapter and a
 * REAL sqlite store. Every arm asserts by reading durable facts back out of the
 * store — never by spying on a call — because the defect this closes is that
 * nothing durable released a dead seat's claim before its 30-minute expiry.
 */

const OPERATOR = "reclaim-operator-credential";
const CHILD_PID = 424242;
const NOW = Date.now();
const ITEM = "policy.install@reclaim-item";
const SEAT = "sess-wrap-dead";

const directory = mkdtempSync(join(tmpdir(), "moe-reclaim-"));
const encoder = new TextEncoder();
const stores: SqliteEventStore[] = [];
const providers: { close(): void }[] = [];

afterAll(() => {
  while (stores.length > 0) {
    try {
      stores.pop()?.close();
    } catch { /* cleanup must not mask a failure */ }
  }
  while (providers.length > 0) {
    try {
      providers.pop()?.close();
    } catch { /* cleanup must not mask a failure */ }
  }
  rmSync(directory, { force: true, recursive: true });
});

function staffingAggregateId(workItemId: string): string {
  return `wrapper-staffing/${createHash("sha256").update(workItemId, "utf8").digest("hex")}`;
}

interface Harness {
  readonly deps: CommandAdapterDeps;
  readonly logged: string[];
  readonly port: AffordancePort;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

let sandbox = 0;

function harnessFor(name: string): Harness {
  const projectId = `proj-reclaim-${name}`;
  const storePath = join(directory, `${String(sandbox += 1)}-store.db`);
  const seed = SqliteEventStore.openForProject(storePath, projectId);
  installTestRecoveryBinding(seed);
  seed.close();
  const provider = createStoreDependencies({
    credential: OPERATOR, principalId: "operator-local", projectId, storePath,
  });
  providers.push(provider);
  const store = SqliteEventStore.openForProject(storePath, projectId);
  stores.push(store);
  const port = provider.affordances?.();
  if (port === undefined) throw new Error("provider serves no affordances");
  return { deps: provider.provide(), logged: [], port, projectId, store };
}

function openSeat(
  harness: Harness, sessionId: string, expiresAt: string, principalId = sessionId,
): void {
  const outcome = runSessionCommand(harness.store, encoder.encode(JSON.stringify({
    commandId: `cmd-seed-open-${sessionId}`,
    correlationId: "corr-reclaim-seed",
    decidedAt: new Date(NOW).toISOString(),
    expectedVersion: 0,
    kind: "session.open",
    payload: {
      capabilities: ["work.write"],
      credentialSha256: createHash("sha256").update(sessionId, "utf8").digest("hex"),
      expiresAt,
      sessionId,
    },
    principalId,
    projectId: harness.projectId,
    schemaVersion: SESSION_SCHEMA_VERSION,
  })));
  if (!outcome.ok) throw new Error(`session.open seed failed: ${outcome.code}`);
}

function closeSeat(harness: Harness, sessionId: string): void {
  const version = readSessionLedger(harness.store, harness.projectId)
    .sessions.get(sessionId)?.version;
  if (version === undefined) throw new Error(`no seat ${sessionId} to close`);
  const outcome = runSessionCommand(harness.store, encoder.encode(JSON.stringify({
    commandId: `cmd-seed-close-${sessionId}`,
    correlationId: "corr-reclaim-seed",
    decidedAt: new Date(NOW).toISOString(),
    expectedVersion: version,
    kind: "session.close",
    payload: { sessionId },
    principalId: "operator-local",
    projectId: harness.projectId,
    schemaVersion: SESSION_SCHEMA_VERSION,
  })));
  if (!outcome.ok) throw new Error(`session.close seed failed: ${outcome.code}`);
}

function writeClaim(
  harness: Harness, kind: "work.claim" | "work.release" | "work.renew",
  principalId: string, expectedVersion: number, commandId: string,
  workItemId = ITEM, expiresAtMs = NOW + 1_800_000,
): void {
  const outcome = runWorkClaimCommand(harness.store, encoder.encode(JSON.stringify({
    commandId,
    correlationId: "corr-reclaim-seed",
    decidedAt: new Date(NOW).toISOString(),
    expectedVersion,
    kind,
    payload: kind === "work.release"
      ? { workItemId }
      : { expiresAt: new Date(expiresAtMs).toISOString(), workItemId },
    principalId,
    projectId: harness.projectId,
    schemaVersion: WORK_CLAIM_SCHEMA_VERSION,
  })));
  if (!outcome.ok) throw new Error(`${kind} seed failed: ${outcome.code}`);
}

/**
 * `null` records a PID-LESS admission. It cannot be spelled `undefined` here: an
 * explicit `undefined` argument re-selects the default parameter, which is how a
 * pid-less arm silently becomes a second copy of the ordinary one.
 */
function recordChild(harness: Harness, childPid: number | null, workItemId = ITEM): void {
  const failures = createAgentSessionFence({
    isProcessAlive: () => false, projectId: harness.projectId, store: harness.store,
  }).recordLiveChild({
    childPid: childPid ?? undefined, claimAggregateVersion: 1,
    sessionId: SEAT, workItemId,
  });
  if (failures.length > 0) throw new Error(failures[0]?.message ?? "record failed");
}

/** The full dead-seat state a SIGKILLed wrapper leaves behind. */
function seedDeadSeat(harness: Harness, childPid: number | null = CHILD_PID): void {
  openSeat(harness, SEAT, new Date(NOW + 1_800_000).toISOString());
  writeClaim(harness, "work.claim", SEAT, 0, "cmd-seed-claim");
  recordChild(harness, childPid);
}

function passFor(
  harness: Harness, isProcessAlive: (pid: number) => boolean, deps = harness.deps,
) {
  return runReclaimPass({
    clock: () => NOW,
    deps,
    isProcessAlive,
    log: (line: string) => { harness.logged.push(line); },
    mintSecret: () => "reclaimtestnonce",
    operatorCredential: OPERATOR,
    projectId: harness.projectId,
    store: harness.store,
  });
}

function eventTypes(harness: Harness, aggregateId: string): readonly string[] {
  return harness.store.readEvents(aggregateId).map((event) => event.eventType);
}

/**
 * The honest version race: the claim advances between the pass's ledger read and
 * the store's compare-and-set, driven through the REGISTRY seam so the refusal is
 * the production store's own conflict — with the production `actualVersion=`
 * detail the retry has to parse.
 */
function withClaimRaced(deps: CommandAdapterDeps, race: () => void): CommandAdapterDeps {
  const release = deps.registry.get("work.release");
  if (release === undefined) throw new Error("work.release is not registered");
  let raced = false;
  const registry = new Map(deps.registry);
  registry.set("work.release", {
    ...release,
    handler: (input) => {
      if (!raced) {
        raced = true;
        race();
      }
      return release.handler(input);
    },
  });
  return { ...deps, registry };
}

describe("runReclaimPass", () => {
  it("closes the seat, releases the claim and retires the record for a dead child", () => {
    const harness = harnessFor("dead");
    seedDeadSeat(harness);

    const reports = passFor(harness, () => false);

    expect(reports).toEqual([{
      code: null, outcome: "RECLAIMED", sessionId: SEAT, workItemId: ITEM,
    }]);
    expect(readSessionLedger(harness.store, harness.projectId).sessions.get(SEAT))
      .toMatchObject({ status: "CLOSED" });
    expect(readWorkClaimLedger(harness.store, harness.projectId).claims.get(ITEM))
      .toMatchObject({ claimedBy: SEAT, status: "RELEASED" });
    expect(eventTypes(harness, `session/${SEAT}`))
      .toEqual(["SessionOpened", "SessionClosed"]);
    expect(eventTypes(harness, `work/${ITEM}`)).toEqual(["WorkClaimed", "WorkReleased"]);
    expect(eventTypes(harness, staffingAggregateId(ITEM)))
      .toEqual(["AgentStaffingAdmitted", "AgentStaffingRetired"]);
    expect(harness.logged).toEqual([`[wrapper] reclaimed ${ITEM} from ${SEAT}`]);
  });

  it("keeps a record whose child is still alive and writes nothing", () => {
    const harness = harnessFor("alive");
    seedDeadSeat(harness);
    const before = {
      session: eventTypes(harness, `session/${SEAT}`).length,
      staffing: eventTypes(harness, staffingAggregateId(ITEM)).length,
      work: eventTypes(harness, `work/${ITEM}`).length,
    };

    const reports = passFor(harness, () => true);

    expect(reports).toEqual([{
      code: null, outcome: "KEPT_ALIVE", sessionId: SEAT, workItemId: ITEM,
    }]);
    expect({
      session: eventTypes(harness, `session/${SEAT}`).length,
      staffing: eventTypes(harness, staffingAggregateId(ITEM)).length,
      work: eventTypes(harness, `work/${ITEM}`).length,
    }).toEqual(before);
    expect(harness.logged).toEqual([`[wrapper] kept ${ITEM}: child alive`]);
  });

  it("keeps a record whose child pid was never recorded", () => {
    const harness = harnessFor("pidless");
    seedDeadSeat(harness, null);

    const reports = passFor(harness, () => {
      throw new Error("the probe must never run without a pid");
    });

    expect(reports).toEqual([{
      code: null, outcome: "KEPT_PID_UNKNOWN", sessionId: SEAT, workItemId: ITEM,
    }]);
    expect(eventTypes(harness, `work/${ITEM}`)).toEqual(["WorkClaimed"]);
    expect(eventTypes(harness, staffingAggregateId(ITEM))).toEqual(["AgentStaffingAdmitted"]);
    expect(harness.logged).toEqual([`[wrapper] kept ${ITEM}: pid unknown`]);
  });

  it("reclaims a pid-less record once its recording session has expired", () => {
    // The provisional staffing row lands before the spawn is admitted and is upgraded with the
    // pid in the same process; a wrapper killed between the two writes left a pid-less row that
    // was kept for ever, and the fence then read the item UNREADABLE: wedged with no retire path.
    const harness = harnessFor("pidless-expired");
    // The seat expires in 30 minutes; the claim outlives it, so the release leg must run too.
    openSeat(harness, SEAT, new Date(NOW + 1_800_000).toISOString());
    writeClaim(harness, "work.claim", SEAT, 0, "cmd-seed-claim", ITEM, NOW + 7_200_000);
    recordChild(harness, null);
    const afterExpiry = NOW + 3_600_000;

    const reports = runReclaimPass({
      clock: () => afterExpiry,
      deps: harness.deps,
      isProcessAlive: () => { throw new Error("the probe must never run without a pid"); },
      log: (line: string) => { harness.logged.push(line); },
      mintSecret: () => "reclaimtestnonce",
      operatorCredential: OPERATOR,
      projectId: harness.projectId,
      store: harness.store,
    });

    expect(reports).toEqual([{
      code: null, outcome: "RECLAIMED", sessionId: SEAT, workItemId: ITEM,
    }]);
    expect(eventTypes(harness, `work/${ITEM}`)).toEqual(["WorkClaimed", "WorkReleased"]);
    expect(eventTypes(harness, staffingAggregateId(ITEM)))
      .toEqual(["AgentStaffingAdmitted", "AgentStaffingRetired"]);
    expect(harness.logged).toEqual([`[wrapper] reclaimed ${ITEM} from ${SEAT}`]);
  });

  it("keeps a record whose liveness probe throws", () => {
    const harness = harnessFor("probe-down");
    seedDeadSeat(harness);

    const reports = passFor(harness, () => { throw new Error("probe outage"); });

    expect(reports).toEqual([{
      code: null, outcome: "KEPT_LIVENESS_UNKNOWN", sessionId: SEAT, workItemId: ITEM,
    }]);
    expect(eventTypes(harness, `work/${ITEM}`)).toEqual(["WorkClaimed"]);
    expect(harness.logged).toEqual([`[wrapper] kept ${ITEM}: liveness unknown`]);
  });

  it("only retires the record when the seat and claim are already settled", () => {
    const harness = harnessFor("settled");
    openSeat(harness, SEAT, new Date(NOW + 1_800_000).toISOString());
    writeClaim(harness, "work.claim", SEAT, 0, "cmd-seed-claim");
    writeClaim(harness, "work.release", SEAT, 1, "cmd-seed-release");
    closeSeat(harness, SEAT);
    recordChild(harness, CHILD_PID);

    const reports = passFor(harness, () => false);

    expect(reports).toEqual([{
      code: null, outcome: "RECLAIMED", sessionId: SEAT, workItemId: ITEM,
    }]);
    // Nothing to close and nothing to release: the lost RETIRE is all that runs.
    expect(eventTypes(harness, `session/${SEAT}`))
      .toEqual(["SessionOpened", "SessionClosed"]);
    expect(eventTypes(harness, `work/${ITEM}`)).toEqual(["WorkClaimed", "WorkReleased"]);
    expect(eventTypes(harness, staffingAggregateId(ITEM)))
      .toEqual(["AgentStaffingAdmitted", "AgentStaffingRetired"]);
    expect(harness.logged).toEqual([`[wrapper] reclaimed ${ITEM} from ${SEAT}`]);
  });

  it("retries once at the version the conflict names when the claim races ahead", () => {
    const harness = harnessFor("raced");
    seedDeadSeat(harness);
    const raced = withClaimRaced(harness.deps, () => {
      // A renewal lands under the seat's own principal after the pass read the
      // ledger: the release it already built is now one version stale.
      writeClaim(harness, "work.renew", SEAT, 1, "cmd-seed-race-renew");
    });

    const reports = passFor(harness, () => false, raced);

    expect(reports).toEqual([{
      code: null, outcome: "RECLAIMED", sessionId: SEAT, workItemId: ITEM,
    }]);
    expect(readWorkClaimLedger(harness.store, harness.projectId).claims.get(ITEM))
      .toMatchObject({ status: "RELEASED" });
    expect(eventTypes(harness, `work/${ITEM}`))
      .toEqual(["WorkClaimed", "WorkClaimRenewed", "WorkReleased"]);
    expect(harness.logged).toEqual([`[wrapper] reclaimed ${ITEM} from ${SEAT}`]);
  });

  it("reports the refusing code and keeps the record when the release is refused", () => {
    const harness = harnessFor("refused");
    seedDeadSeat(harness);
    // A SECOND session whose principal is the claimant stays LIVE after the seat
    // is closed, so the daemon rule refuses the release — as it must.
    openSeat(harness, "sess-wrap-peer", new Date(NOW + 1_800_000).toISOString(), SEAT);

    const reports = passFor(harness, () => false);

    expect(reports).toEqual([{
      code: "WORK_CLAIM_NOT_CLAIMANT",
      outcome: "RELEASE_REFUSED",
      sessionId: SEAT,
      workItemId: ITEM,
    }]);
    expect(readWorkClaimLedger(harness.store, harness.projectId).claims.get(ITEM))
      .toMatchObject({ status: "OPEN" });
    // NOT retired: an item still held must stay fenced for the next pass.
    expect(eventTypes(harness, staffingAggregateId(ITEM))).toEqual(["AgentStaffingAdmitted"]);
    expect(harness.logged)
      .toEqual([`[wrapper] kept ${ITEM}: release refused WORK_CLAIM_NOT_CLAIMANT`]);
  });

  it("treats a claim another wrapper already released as settled and still retires", () => {
    // TWO WRAPPERS restarting on one store. This one read the ledger at version 1;
    // the other releases before this release reaches the daemon, so `decide` sees
    // no active claim and answers WORK_CLAIM_NOT_FOUND -- a settled item, not a
    // refusal to report. Without that reading the record would never be retired
    // and the item would stay fenced by a record nobody can clear.
    const harness = harnessFor("raced-release");
    seedDeadSeat(harness);
    const raced = withClaimRaced(harness.deps, () => {
      writeClaim(harness, "work.release", SEAT, 1, "cmd-seed-peer-release");
    });

    const reports = passFor(harness, () => false, raced);

    expect(reports).toEqual([{
      code: null, outcome: "RECLAIMED", sessionId: SEAT, workItemId: ITEM,
    }]);
    // Exactly ONE release landed: the peer's. This pass added no second one.
    expect(eventTypes(harness, `work/${ITEM}`)).toEqual(["WorkClaimed", "WorkReleased"]);
    expect(eventTypes(harness, staffingAggregateId(ITEM)))
      .toEqual(["AgentStaffingAdmitted", "AgentStaffingRetired"]);
    expect(harness.logged).toEqual([`[wrapper] reclaimed ${ITEM} from ${SEAT}`]);
  });

  it("closes a seat whose session outlived its claim and skips the release", () => {
    // The seat TTL is max(claimTtl, agentTimeout) + grace, so a session routinely
    // outlives the claim it minted. Nothing holds the item, so there is nothing to
    // release -- but the dead seat's session must still be closed and the record
    // retired, or the Seats screen keeps showing a LIVE seat that is not running.
    const harness = harnessFor("session-outlives");
    openSeat(harness, SEAT, new Date(NOW + 1_800_000).toISOString());
    writeClaim(harness, "work.claim", SEAT, 0, "cmd-seed-claim", ITEM, NOW - 1_000);
    recordChild(harness, CHILD_PID);

    const reports = passFor(harness, () => false);

    expect(reports).toEqual([{
      code: null, outcome: "RECLAIMED", sessionId: SEAT, workItemId: ITEM,
    }]);
    expect(readSessionLedger(harness.store, harness.projectId).sessions.get(SEAT))
      .toMatchObject({ status: "CLOSED" });
    // No WorkReleased: `activeClaim` is null, so the pass had nothing to release.
    expect(eventTypes(harness, `work/${ITEM}`)).toEqual(["WorkClaimed"]);
    expect(eventTypes(harness, staffingAggregateId(ITEM)))
      .toEqual(["AgentStaffingAdmitted", "AgentStaffingRetired"]);
    expect(harness.logged).toEqual([`[wrapper] reclaimed ${ITEM} from ${SEAT}`]);
  });

  it("answers with no reports and no log when nothing was ever staffed", () => {
    const harness = harnessFor("empty");

    expect(passFor(harness, () => false)).toEqual([]);
    expect(harness.logged).toEqual([]);
  });

  it("runs under the operator credential's real capabilities, not a widened stub", () => {
    // The pass dispatches through the committed adapter under `operatorCredential`.
    // If that credential could not carry work.write and project.admin the arms
    // above would refuse at ingress instead of reaching the rule under test.
    const harness = harnessFor("capabilities");
    seedDeadSeat(harness);

    expect(passFor(harness, () => false)).toEqual([{
      code: null, outcome: "RECLAIMED", sessionId: SEAT, workItemId: ITEM,
    }]);
  });
});

describe("enumerateLiveChildren", () => {
  it("lists an ADMITTED record and drops it once RETIRED", () => {
    const harness = harnessFor("enumerate");
    seedDeadSeat(harness);

    expect(enumerateLiveChildren(harness.store)).toEqual([{
      childPid: CHILD_PID, claimAggregateVersion: 1, sessionId: SEAT, workItemId: ITEM,
    }]);

    const fence = createAgentSessionFence({
      isProcessAlive: () => false, projectId: harness.projectId, store: harness.store,
    });
    expect(fence.retireLiveChild(ITEM)).toEqual([]);
    expect(enumerateLiveChildren(harness.store)).toEqual([]);
  });

  it("reads back a pid-less admission as a record with a null pid", () => {
    const harness = harnessFor("enumerate-pidless");
    seedDeadSeat(harness, null);

    expect(enumerateLiveChildren(harness.store)).toEqual([{
      childPid: null, claimAggregateVersion: 1, sessionId: SEAT, workItemId: ITEM,
    }]);
  });

  it("skips an unreadable staffing record with a log line instead of throwing", () => {
    const harness = harnessFor("enumerate-corrupt");
    seedDeadSeat(harness);
    const aggregateId = staffingAggregateId(ITEM);
    harness.store.commit({
      aggregateId,
      commandBytes: encoder.encode(JSON.stringify({ action: "CORRUPT" })),
      commandId: "cmd-reclaim-corrupt",
      committedAt: new Date(NOW).toISOString(),
      events: [{
        eventId: "cmd-reclaim-corrupt-e1",
        eventType: "AgentStaffingUnknown",
        payload: encoder.encode(JSON.stringify({ workItemId: ITEM })),
      }],
      expectedVersion: harness.store.getAggregateVersion(aggregateId),
    });

    const logged: string[] = [];
    expect(enumerateLiveChildren(harness.store, (line) => { logged.push(line); })).toEqual([]);
    expect(logged).toEqual([`[wrapper] skipped ${aggregateId}: staffing record unreadable`]);
  });
});

/**
 * THE DEFECT THIS ROW CLOSES, end to end over the real staffing loop: after a
 * wrapper restart the first pass must be able to staff the item its own dead
 * child was holding — and must still refuse to touch one whose child is alive.
 */
describe("the first staffing pass after a reclaim", () => {
  /** A READY, unclaimed, staffable step off the REAL surface. */
  function staffableItem(harness: Harness): string {
    const surface = harness.port.readSurface();
    if (surface.outcome !== "SURFACE") throw new Error(surface.code);
    const step = surface.steps.find((candidate) =>
      candidate.status === "READY" && candidate.claim === null
      && !candidate.kind.startsWith("session.")
      && candidate.kind !== "approval.decide" && candidate.kind !== "goal.close");
    if (step === undefined) throw new Error("no staffable step on the surface");
    return workItemIdFor(step.kind, step.aggregateId);
  }

  /** The surface narrowed to one item, so nothing else competes for the seat. */
  function soloPort(harness: Harness, target: string): AffordancePort {
    return {
      boundProjectId: harness.projectId,
      readSurface: () => {
        const surface = harness.port.readSurface();
        if (surface.outcome !== "SURFACE") return surface;
        return {
          ...surface,
          steps: surface.steps.filter((step) =>
            workItemIdFor(step.kind, step.aggregateId) === target),
        };
      },
    };
  }

  function wrapperFor(
    harness: Harness, target: string, childAlive: boolean, spawned: SpawnRequest[],
  ) {
    let suffix = 0;
    return createAgentWrapper({
      affordances: soloPort(harness, target),
      claimTtlMs: 60_000,
      clock: () => NOW,
      deps: harness.deps,
      maxAgents: 1,
      mintSecret: () => `rclm${String(suffix += 1).padStart(4, "0")}${"0".repeat(28)}`,
      operatorCredential: OPERATOR,
      spawnAgent: async (request): Promise<AgentSpawnStartResult> => {
        spawned.push(request);
        return { exit: new Promise<void>(() => undefined), ok: true, pid: CHILD_PID };
      },
      staffingFence: createAgentSessionFence({
        isProcessAlive: () => childAlive,
        projectId: harness.projectId,
        store: harness.store,
      }),
    });
  }

  it("refuses the item BEFORE the reclaim and staffs it after", async () => {
    const harness = harnessFor("staffs");
    const target = staffableItem(harness);
    openSeat(harness, SEAT, new Date(NOW + 1_800_000).toISOString());
    writeClaim(harness, "work.claim", SEAT, 0, "cmd-seed-claim", target);
    recordChild(harness, CHILD_PID, target);

    // THE CONTROL, and the shape of the defect: the dead seat's claim is still
    // on the surface, so `runPass` SKIPS the step outright (agent-wrapper.ts:357
    // `step.claim !== null`) — the fence is never even consulted. The pass
    // reports NOTHING for this item and nothing can be staffed on it until the
    // 30-minute expiry. The surface read below is what makes that non-vacuous.
    const surface = harness.port.readSurface();
    if (surface.outcome !== "SURFACE") throw new Error(surface.code);
    expect(surface.steps.find((step) =>
      workItemIdFor(step.kind, step.aggregateId) === target)).toMatchObject({
      claim: { claimedBy: SEAT }, status: "READY",
    });
    const before: SpawnRequest[] = [];
    const blocked = await wrapperFor(harness, target, false, before).runOnce();
    expect(blocked.spawned).toEqual([]);
    expect(before).toEqual([]);

    expect(passFor(harness, () => false)).toEqual([{
      code: null, outcome: "RECLAIMED", sessionId: SEAT, workItemId: target,
    }]);

    const after: SpawnRequest[] = [];
    const staffed = await wrapperFor(harness, target, false, after).runOnce();
    expect(staffed.spawned).toMatchObject([{ outcome: "SPAWNED", workItemId: target }]);
    expect(after.map((request) => request.workItemId)).toEqual([target]);
    // The NEW seat holds it, not the dead one.
    expect(readWorkClaimLedger(harness.store, harness.projectId).claims.get(target))
      .toMatchObject({ claimedBy: staffed.spawned[0]?.sessionId, status: "OPEN" });
  });

  it("keeps a live child's item and the pass leaves it unstaffable", async () => {
    const harness = harnessFor("staffs-live");
    const target = staffableItem(harness);
    openSeat(harness, SEAT, new Date(NOW + 1_800_000).toISOString());
    // The reported defect's exact shape: the claim has EXPIRED while the child
    // is still writing files. Only the staffing record knows it is alive.
    writeClaim(harness, "work.claim", SEAT, 0, "cmd-seed-claim", target, NOW - 1_000);
    recordChild(harness, CHILD_PID, target);

    expect(passFor(harness, () => true)).toEqual([{
      code: null, outcome: "KEPT_ALIVE", sessionId: SEAT, workItemId: target,
    }]);
    expect(readSessionLedger(harness.store, harness.projectId).sessions.get(SEAT))
      .toMatchObject({ status: "OPEN" });

    const spawned: SpawnRequest[] = [];
    const report = await wrapperFor(harness, target, true, spawned).runOnce();
    expect(report.spawned).toMatchObject([
      { outcome: "AGENT_STAFFING_CHILD_LIVE", workItemId: target },
    ]);
    expect(spawned).toEqual([]);
  });
});

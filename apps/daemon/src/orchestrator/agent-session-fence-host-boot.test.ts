import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { AGENT_STAFFING_LAYER, createAgentSessionFence } from "./agent-session-fence.js";
import {
  hostBootIdNow, hostRebootedSince, readHostBootId, windowsBootIdOf,
} from "./agent-staffing-host-boot.js";
import type { HostBootPorts } from "./agent-staffing-host-boot.js";
import { WORK_CLAIM_SCHEMA_VERSION } from "../work/work-claim-contracts.js";
import { runWorkClaimCommand } from "../work/work-claim-services.js";

/**
 * THE PID-REUSE ESCAPE. A pid names a process only within one boot, and only until the OS
 * hands it out again. SIGKILL the wrapper, or reboot the host, while a seat runs and the
 * ADMITTED row for its item is never retired: the recording process's own exit handler is the
 * only path that retires a row, besides the boot reclaim on a pid that reads DEAD. Once the pid
 * belongs to a stranger — after a reboot, on Windows, routinely a system process that lives as
 * long as the boot — `kill(pid, 0)` answers alive, the fence refuses CHILD_LIVE on every pass,
 * and CHILD_LIVE is a gate refusal that charges no attempt and escalates nothing. The item is
 * unstaffable until the next reboot while the operator is told a seat is running.
 *
 * So a row carries the identity of the boot that wrote it and the host's uptime at that
 * instant, and both readers ask first whether the host has rebooted since. It has when the
 * identity CHANGED, or when the uptime went BACKWARDS — both clock-free. The wall clock is never
 * consulted: a running Windows host STEPS its clock past any tolerance, and a stepped clock must
 * never admit a second agent beside a live orphan. A row written without the facts, or a host
 * that cannot be read, proves nothing and leaves the probe to decide.
 *
 * Every refusal asserts code AND layer and that the event horizon did not move, exactly as
 * agent-session-fence.test.ts does: a boot verdict is a read, never a write.
 */

const PROJECT = "proj-agent-fence-boot";
const ITEM = "node.deliver@node-live-1";
const CLAIM_AT = "2026-08-09T12:00:00.000Z";
const CLAIM_EXPIRES = "2026-08-09T13:00:00.000Z";
/** After the claim's expiry: the only thing the wall clock is still asked about. */
const AFTER_EXPIRY = "2026-08-09T14:00:00.000Z";
const CHILD_PID = 424242;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const BOOT_A = "0x45";
const BOOT_B = "0x46";
/** The listing `reg query ... /v BootId` prints, byte for byte as a Windows 11 host wrote it. */
const REG_LISTING = "\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager"
  + "\\Memory Management\\PrefetchParameters\r\n    BootId    REG_DWORD    0x45\r\n\r\n";

const encoder = new TextEncoder();
const roots: string[] = [];
const stores: SqliteEventStore[] = [];
let sequence = 0;

afterEach(() => {
  // A held SQLite handle kills the vitest worker outright.
  while (stores.length > 0) stores.pop()?.close();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { force: true, maxRetries: 5, recursive: true });
  }
});

function openAt(label: string): SqliteEventStore {
  const root = mkdtempSync(join(tmpdir(), `moe-agent-fence-boot-${label}-`));
  roots.push(root);
  const store = SqliteEventStore.openForProject(join(root, "project.db"), PROJECT);
  stores.push(store);
  return store;
}

/** The reported class needs an EXPIRED claim: the fence must reach the live-child record. */
function seedExpiredClaim(store: SqliteEventStore): void {
  const outcome = runWorkClaimCommand(store, encoder.encode(JSON.stringify({
    commandId: `cmd-fence-boot-claim-${String(sequence += 1)}`,
    correlationId: "corr-fence-boot",
    decidedAt: CLAIM_AT,
    expectedVersion: 0,
    kind: "work.claim",
    payload: { expiresAt: CLAIM_EXPIRES, workItemId: ITEM },
    principalId: "agent-first",
    projectId: PROJECT,
    schemaVersion: WORK_CLAIM_SCHEMA_VERSION,
  })));
  expect(outcome).toMatchObject({ ok: true });
}

/** What the host answers now: a plain value, or a port that may throw. */
interface HostNow {
  readonly bootId: string | null | (() => string | null);
  readonly uptimeMs: number | (() => number);
}

function portsOf(host: HostNow): HostBootPorts {
  const { bootId, uptimeMs } = host;
  return {
    bootId: typeof bootId === "function" ? bootId : () => bootId,
    uptimeMs: typeof uptimeMs === "function" ? uptimeMs : () => uptimeMs,
  };
}

/**
 * Every port injected: the boot identity and the uptime as well as the pid probe, so no case
 * depends on the machine running it. The probe defaults to ALIVE because that is the refusing
 * answer — the only thing that may admit here is the boot verdict.
 */
function fenceOn(
  store: SqliteEventStore, host: HostNow, isProcessAlive: (pid: number) => boolean = () => true,
): ReturnType<typeof createAgentSessionFence> {
  const ports = portsOf(host);
  return createAgentSessionFence({
    hostBootId: ports.bootId, hostUptimeMs: ports.uptimeMs, isProcessAlive,
    projectId: PROJECT, store,
  });
}

/** Records the child while the host reads `host`. */
function recordChild(store: SqliteEventStore, host: HostNow): void {
  expect(fenceOn(store, host).recordLiveChild({
    childPid: CHILD_PID, claimAggregateVersion: 1, sessionId: "sess-wrap-first", workItemId: ITEM,
  })).toEqual([]);
}

function instant(ms: number): string {
  return new Date(ms).toISOString();
}

const throws = (): never => {
  throw new Error("EACCES");
};

const CHILD_LIVE = Object.freeze({
  code: "AGENT_STAFFING_CHILD_LIVE", layer: AGENT_STAFFING_LAYER, ok: false,
});

describe("agent session fence: the host-boot witness", () => {
  it("ADMITS an alive-reading pid once the host uptime shows a reboot since the record", () => {
    // The reported class, on a host that offers no boot identity: the row was written five
    // hours into the previous boot and the host has been up ten minutes, so whatever wears the
    // pid started after that boot. No probe may run — a probe outage must not turn a child the
    // boot already retired into LIVENESS_UNKNOWN.
    const store = openAt("rebooted-uptime");
    seedExpiredClaim(store);
    recordChild(store, { bootId: null, uptimeMs: 5 * HOUR_MS });
    const horizon = store.readEventHorizon();
    let probes = 0;

    const decision = fenceOn(
      store, { bootId: null, uptimeMs: 10 * MINUTE_MS }, () => { probes += 1; return true; },
    ).admit(ITEM, AFTER_EXPIRY);

    expect(decision).toMatchObject({ ok: true });
    expect(probes).toBe(0);
    expect(store.readEventHorizon()).toBe(horizon);
  });

  it("ADMITS when the boot identity changed although the host is up longer than the record was", () => {
    // The case the uptime alone misses — and the one a Windows Shutdown with Fast Startup
    // produces: the kernel session resumes, so the tick count carries on from the previous
    // session, while every user process was killed and every pid reissued. The identity is a
    // different one, and that alone decides: no probe, no clock.
    const store = openAt("rebooted-identity");
    seedExpiredClaim(store);
    recordChild(store, { bootId: BOOT_A, uptimeMs: 30 * MINUTE_MS });
    const horizon = store.readEventHorizon();
    let probes = 0;

    const decision = fenceOn(
      store, { bootId: BOOT_B, uptimeMs: 2 * HOUR_MS }, () => { probes += 1; return true; },
    ).admit(ITEM, AFTER_EXPIRY);

    expect(decision).toMatchObject({ ok: true });
    expect(probes).toBe(0);
    expect(store.readEventHorizon()).toBe(horizon);
  });

  it("still refuses CHILD_LIVE on the same boot however far the wall clock has stepped", () => {
    // The arm that used to fail OPEN. Half an hour of uptime passes on one boot identity while
    // the wall clock jumps an hour, then a day: w32time STEPS a clock whose offset exceeds its
    // phase limit, a VM resumed from a pause re-syncs by the whole pause, and neither may admit
    // a second agent beside the orphan the fence exists to catch. The alive answer is the
    // child's own.
    const store = openAt("same-boot-clock-step");
    seedExpiredClaim(store);
    recordChild(store, { bootId: BOOT_A, uptimeMs: 2 * HOUR_MS });
    const horizon = store.readEventHorizon();
    const later = fenceOn(store, { bootId: BOOT_A, uptimeMs: 2 * HOUR_MS + 30 * MINUTE_MS });

    expect(later.admit(ITEM, instant(Date.now() + HOUR_MS))).toMatchObject(CHILD_LIVE);
    expect(later.admit(ITEM, instant(Date.now() + DAY_MS))).toMatchObject(CHILD_LIVE);
    expect(store.readEventHorizon()).toBe(horizon);
  });

  it("leaves a host without a boot identity to the probe once its uptime outgrows the record", () => {
    // No identity on either side and the uptime went forwards: the same boot for all the
    // witness can tell, whatever the clock says, so the probe decides. Fail closed.
    const store = openAt("no-identity-clock-step");
    seedExpiredClaim(store);
    recordChild(store, { bootId: null, uptimeMs: 2 * HOUR_MS });
    const horizon = store.readEventHorizon();

    const decision = fenceOn(store, { bootId: null, uptimeMs: 2 * HOUR_MS + 30 * MINUTE_MS })
      .admit(ITEM, instant(Date.now() + DAY_MS));

    expect(decision).toMatchObject(CHILD_LIVE);
    expect(store.readEventHorizon()).toBe(horizon);
  });

  it("takes either witness alone and never guesses from an absent one", () => {
    // The verdict matrix on the function itself. A changed identity or a shorter uptime is a
    // reboot even while the other port throws; a matching identity does not veto a shorter
    // uptime (a host whose identity failed to advance still cannot run a process older than its
    // boot); an identity the row lacks, or the host cannot read now, is not compared; an empty
    // answer is no identity; and a row without either fact is never a reboot.
    const recorded = { hostBootId: BOOT_A, hostUptimeMs: HOUR_MS };
    const verdict = (host: HostNow): boolean => hostRebootedSince(recorded, portsOf(host));

    expect(verdict({ bootId: BOOT_B, uptimeMs: throws })).toBe(true);
    expect(verdict({ bootId: throws, uptimeMs: MINUTE_MS })).toBe(true);
    expect(verdict({ bootId: BOOT_A, uptimeMs: MINUTE_MS })).toBe(true);
    expect(verdict({ bootId: BOOT_A, uptimeMs: DAY_MS })).toBe(false);
    expect(verdict({ bootId: null, uptimeMs: DAY_MS })).toBe(false);
    expect(verdict({ bootId: "", uptimeMs: DAY_MS })).toBe(false);
    expect(verdict({ bootId: throws, uptimeMs: throws })).toBe(false);
    expect(hostRebootedSince(
      { hostBootId: null, hostUptimeMs: HOUR_MS }, portsOf({ bootId: BOOT_B, uptimeMs: DAY_MS }),
    )).toBe(false);
    expect(hostRebootedSince(
      { hostBootId: BOOT_A, hostUptimeMs: null }, portsOf({ bootId: BOOT_A, uptimeMs: 1 }),
    )).toBe(false);
    expect(hostRebootedSince(null, portsOf({ bootId: BOOT_B, uptimeMs: 1 }))).toBe(false);
  });

  it("refuses CHILD_LIVE for a row without the host facts, whatever the host says now", () => {
    // A row from before the witness existed carries neither fact. That is "cannot tell", never
    // "rebooted": a host up one millisecond on some other identity proves nothing about it, and
    // the probe's alive answer stands.
    const store = openAt("legacy-row");
    const aggregateId = `wrapper-staffing/${createHash("sha256").update(ITEM, "utf8")
      .digest("hex")}`;
    store.commit({
      aggregateId,
      commandBytes: encoder.encode(JSON.stringify({ probe: "legacy" })),
      commandId: "stf-legacy",
      committedAt: CLAIM_AT,
      events: [{
        eventId: "stf-legacy-e1",
        eventType: "AgentStaffingAdmitted",
        payload: encoder.encode(JSON.stringify({
          childPid: CHILD_PID, claimAggregateVersion: 1, sessionId: "s", workItemId: ITEM,
        })),
      }],
      expectedVersion: 0,
    });
    const horizon = store.readEventHorizon();

    const decision = fenceOn(store, { bootId: BOOT_B, uptimeMs: 1 }).admit(ITEM, AFTER_EXPIRY);

    expect(decision).toMatchObject(CHILD_LIVE);
    expect(store.readEventHorizon()).toBe(horizon);
  });

  it("refuses CHILD_LIVE when neither host fact can be read at admission", () => {
    // Fail closed on the witness exactly as on the probe: ports that throw are not a reboot.
    const store = openAt("ports-throw-admit");
    seedExpiredClaim(store);
    recordChild(store, { bootId: BOOT_A, uptimeMs: 5 * HOUR_MS });
    const horizon = store.readEventHorizon();

    const decision = fenceOn(store, { bootId: throws, uptimeMs: throws }).admit(ITEM, AFTER_EXPIRY);

    expect(decision).toMatchObject(CHILD_LIVE);
    expect(store.readEventHorizon()).toBe(horizon);
  });

  it("writes no host fact it could not measure, so that row stays with the probe", () => {
    // The record side of the same posture: ports that throw at record time leave the row
    // without the facts rather than with guessed ones, and a later rebooted-looking host cannot
    // read a reboot into it.
    const store = openAt("ports-throw-record");
    seedExpiredClaim(store);
    recordChild(store, { bootId: throws, uptimeMs: throws });
    const horizon = store.readEventHorizon();

    const decision = fenceOn(store, { bootId: BOOT_B, uptimeMs: 1 }).admit(ITEM, AFTER_EXPIRY);

    expect(decision).toMatchObject(CHILD_LIVE);
    expect(store.readEventHorizon()).toBe(horizon);
  });

  it("reads the Windows BootId out of a reg listing and nothing out of anything else", () => {
    expect(windowsBootIdOf(REG_LISTING)).toBe("0x45");
    expect(windowsBootIdOf(REG_LISTING.replace("BootId", "BaseTime"))).toBeNull();
    expect(windowsBootIdOf("ERROR: The system was unable to find the specified registry key or value.\r\n"))
      .toBeNull();
    expect(windowsBootIdOf("")).toBeNull();
  });

  it("answers this host's own boot identity, once per process, in the platform's shape", () => {
    // Read for real, so the production port runs on every platform the suite runs on: one
    // non-empty token on Linux and Windows, none elsewhere, and the cached port keeps answering
    // the same thing. A platform this module does not know never touches the host.
    const expected = process.platform === "linux" || process.platform === "win32"
      ? expect.stringMatching(/^\S+$/)
      : null;

    expect(readHostBootId()).toEqual(expected);
    expect(readHostBootId("freebsd")).toBeNull();
    expect(hostBootIdNow()).toEqual(expected);
    expect(hostBootIdNow()).toBe(hostBootIdNow());
  });
});

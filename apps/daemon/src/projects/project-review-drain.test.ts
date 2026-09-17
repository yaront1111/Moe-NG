import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createProjectReviewDrainPort, decodeProjectReviewDrainFrame } from "./project-review-drain.js";

describe("trusted project review drain admission", () => {
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER])("refuses invalid controller identity %s before observer launch", async (controllerPid) => {
    expect(await createProjectReviewDrainPort().drain({ controllerPid, notStartedAfter: new Date().toISOString(), workspace: "C:\\project" }))
      .toMatchObject({ ok: false, code: "RUNTIME_REVIEW_DRAIN_IDENTITY_MISMATCH" });
  });
  it("refuses a malformed seat boundary before observer launch", async () => {
    expect(await createProjectReviewDrainPort().drain({ controllerPid: 1, notStartedAfter: "not-a-time", workspace: "C:\\project" }))
      .toMatchObject({ ok: false, code: "RUNTIME_REVIEW_DRAIN_IDENTITY_MISMATCH" });
  });
});

const input = { controllerPid: 44, notStartedAfter: "2026-09-14T09:00:00.000Z" };
const evidence = { controllerPid: 44, controllerStartedAt: "2026-09-14T08:00:00.000Z", brokerPid: 22,
  brokerStartedAt: "2026-09-14T07:59:58.000Z", cliPid: 11, daemonPid: 33, observedAt: "2026-09-14T10:00:00.000Z", jobEmpty: true };
describe("drain observer result contract", () => {
  it("accepts exact bound positive observations", () => {
    expect(decodeProjectReviewDrainFrame({ ok: true, evidence }, input)).toEqual({ ok: true, evidence });
  });
  it.each(["RUNTIME_REVIEW_DRAIN_ACCESS_DENIED", "RUNTIME_REVIEW_DRAIN_UNPROVEN", "RUNTIME_REVIEW_DRAIN_IDENTITY_MISMATCH"])("preserves stable refusal %s", (code) => {
    expect(decodeProjectReviewDrainFrame({ ok: false, code }, input)).toMatchObject({ ok: false, code });
  });
  // The grain the observer's own birth check shares (addendum 2026-09-17): the cutoff's millisecond, no wider.
  it("bounds the controller's birth at the millisecond the cutoff carries", () => {
    expect(decodeProjectReviewDrainFrame({ ok: true, evidence: { ...evidence, controllerStartedAt: input.notStartedAfter } }, input)).toMatchObject({ ok: true });
    expect(decodeProjectReviewDrainFrame({ ok: true, evidence: { ...evidence, controllerStartedAt: "2026-09-14T09:00:00.001Z" } }, input)).toBeNull();
  });
  it.each([null, {}, { ok: true, evidence: { ...evidence, jobEmpty: false } }, { ok: true, evidence: { ...evidence, controllerPid: 45 } },
    { ok: true, evidence: { ...evidence, controllerStartedAt: "2026-09-14T09:00:01.000Z" } },
    { ok: true, evidence: { ...evidence, daemonPid: 44 } }, { ok: true, evidence: { ...evidence, brokerStartedAt: evidence.observedAt } },
    { ok: true, evidence: { ...evidence, observedAt: "wrong" } }, { ok: true, evidence, fabricated: true },
    { ok: false, code: "UNTRUSTED", detail: "secret" },
    { ok: false, code: "RUNTIME_REVIEW_DRAIN_UNPROVEN", reason: "INVENTED_REASON" }])("refuses incomplete or contradictory observer frame %#", (value) => {
    expect(decodeProjectReviewDrainFrame(value, input)).toBeNull();
  });
});

/**
 * Which proof failed (addendum 2026-09-15). "The original runtime Job was not proven empty" said
 * nothing about what stayed alive, so neither an operator nor a CI log could tell a slow broker
 * from a live seat.
 */
describe("naming what the drain could not prove", () => {
  it.each([
    ["JOB_ACTIVE", "still reported active processes"],
    ["CLI_ALIVE", "moe command"],
    ["BROKER_ALIVE", "job broker"],
    ["DAEMON_ALIVE", "project daemon"],
    ["CONTROLLER_ALIVE", "agent wrapper"],
    ["INPUT_CLOSED", "closed the observer"],
  ])("describes %s", (reason, words) => {
    const decoded = decodeProjectReviewDrainFrame({ ok: false, code: "RUNTIME_REVIEW_DRAIN_UNPROVEN", reason }, input);
    expect(decoded).toMatchObject({ ok: false, code: "RUNTIME_REVIEW_DRAIN_UNPROVEN" });
    expect(decoded !== null && !decoded.ok ? decoded.detail : "").toContain(words);
  });
});

/** The port's side of the observer wire, with no PowerShell: records every stdin line it receives. */
class FakeObserver extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: string[] = [];
  killed = false;
  constructor(private readonly onDrain?: (observer: FakeObserver) => void) {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter((entry) => entry !== "")) {
        this.received.push(line);
        if (line === "DRAIN") this.onDrain?.(this);
        if (line === "CLOSE") { this.line({ closed: true }); this.exit(); }
      }
    });
  }
  line(value: unknown): void { this.stdout.write(`${JSON.stringify(value)}\n`); }
  exit(): void { if (!this.stdout.writableEnded) { this.stdout.end(); setImmediate(() => this.emit("close", 0)); } }
  kill(): boolean { this.killed = true; this.exit(); return true; }
}
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until(predicate: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400 && !predicate(); tries += 1) await wait(5);
  expect(predicate()).toBe(true);
}

/**
 * Starting the observer has its own budget, and nothing is stopped before an explicit go
 * (addendum 2026-09-15). Measured on windows-latest: starting Windows PowerShell and compiling the
 * observer took 10 s to over 35 s under the daemon suite's load, so one 35 s budget for start AND
 * drain refused every native arm RUNTIME_REVIEW_DRAIN_UNPROVEN while the same arms took ~1 s here.
 */
describe("drain observer start budget", () => {
  const request = { ...input, workspace: "C:\\project" };

  it("waits for a slow observer to start, then drains under its own budget", async () => {
    const observer = new FakeObserver((self) => { self.line({ ok: true, evidence }); });
    const pending = createProjectReviewDrainPort({ drainTimeoutMs: 200, readyTimeoutMs: 5_000,
      launchObserver: () => observer as never }).drain(request);
    await wait(400);
    expect(observer.received).toHaveLength(1); // the wire only: nothing may be stopped before ready
    observer.line({ ready: true });
    const result = await pending;

    expect(result).toMatchObject({ ok: true, evidence });
    expect(observer.received.slice(1)).toEqual(["DRAIN"]);
    if (result.ok) await result.close();
    expect(observer.received.at(-1)).toBe("CLOSE");
  });

  it("refuses a start that never completes as unavailable, and never sends DRAIN", async () => {
    const observer = new FakeObserver();

    const result = await createProjectReviewDrainPort({ drainTimeoutMs: 200, readyTimeoutMs: 150,
      launchObserver: () => observer as never }).drain(request);

    expect(result).toMatchObject({ ok: false, code: "RUNTIME_REVIEW_DRAIN_UNAVAILABLE" });
    expect(result.ok ? "" : result.detail).toContain("nothing was stopped");
    expect(observer.received).not.toContain("DRAIN");
  });

  it("still bounds the drain itself once the observer started", async () => {
    const observer = new FakeObserver();
    const pending = createProjectReviewDrainPort({ drainTimeoutMs: 150, readyTimeoutMs: 5_000,
      launchObserver: () => observer as never }).drain(request);
    observer.line({ ready: true });
    await until(() => observer.received.includes("DRAIN"));

    expect(await pending).toMatchObject({ ok: false, code: "RUNTIME_REVIEW_DRAIN_UNPROVEN" });
  });

  it("passes a named refusal through from a started observer", async () => {
    const observer = new FakeObserver((self) => { self.line({ ok: false, code: "RUNTIME_REVIEW_DRAIN_UNPROVEN", reason: "BROKER_ALIVE" }); });
    const pending = createProjectReviewDrainPort({ drainTimeoutMs: 2_000, readyTimeoutMs: 5_000,
      launchObserver: () => observer as never }).drain(request);
    observer.line({ ready: true });

    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: "RUNTIME_REVIEW_DRAIN_UNPROVEN" });
    expect(result.ok ? "" : result.detail).toContain("job broker");
  });
});

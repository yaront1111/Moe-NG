import { afterEach, describe, expect, it } from "vitest";

import { closeStores } from "../review/review-test-fixtures.js";
import { recoveryEvidenceFixture } from "../repository/repository-recovery-test-fixtures.js";
import { readRepositoryLandingEvidence } from "../repository/repository-landing-intent.js";
import { LANDING_FAULT_POINTS, createLandingFaultInjector } from "./landing-fault-injection.js";
import type { LandingFaultPoint } from "./landing-fault-injection.js";
import { commitJournaledLanding } from "./node-lander-journal.js";

/**
 * WHERE THE CRASH WINDOW ACTUALLY IS, measured rather than described.
 *
 * A crash is only interesting if the process dies with durable state half-written. These
 * arms drive the real journal against a real store and record what was durable AT THE
 * INSTANT the knob fired — the kill callback runs exactly where a SIGKILL would land, so
 * the snapshot it takes is the state a restarted daemon would find.
 *
 * The roster arm asserts SET EQUALITY in both directions. Iterating the roster alone can
 * only prove that every advertised point is a string; deleting a `trip` call would shrink
 * the served set and leave a roster-only test green while a window went unreachable.
 */

afterEach(closeStores);

interface Fired {
  readonly committed: number;
  readonly evidence: ReturnType<typeof readRepositoryLandingEvidence>;
  readonly point: LandingFaultPoint;
}

/** Drives one landing with the knob armed at `point`; returns every point it tripped. */
async function driveWith(point: LandingFaultPoint | "unarmed") {
  const fixture = recoveryEvidenceFixture();
  const tripped: LandingFaultPoint[] = [];
  const fired: Fired[] = [];
  let committed = 0;
  const fault = {
    armedPoint: null,
    refusal: null,
    trip: (name: LandingFaultPoint): void => {
      tripped.push(name);
      if (name !== point) return;
      fired.push({
        committed,
        evidence: readRepositoryLandingEvidence(fixture.store, fixture.handle),
        point: name,
      });
      // A real trip never returns; throwing is what stops the rest of the write here.
      throw new Error(`FAULT_INJECTED:${name}`);
    },
  };
  const run = async () => commitJournaledLanding({
    binding: fixture.binding,
    fault,
    handle: fixture.handle,
    message: fixture.commit.message,
    paths: fixture.commit.files,
    port: {
      capture: async () => ({ ok: true as const, binding: fixture.binding }),
      commit: async () => {
        committed += 1;
        return { ok: true as const, receipt: fixture.commit };
      },
    },
    store: fixture.store,
    verifierReceiptId: fixture.verified.receipt.receiptId,
    workspace: fixture.binding.root,
  });
  let threw: string | null = null;
  try { await run(); } catch (error) { threw = (error as Error).message; }
  return { committed, fired, fixture, threw, tripped };
}

describe("the landing write's fault points", () => {
  it("trips exactly the points the roster advertises — set equality, both directions", async () => {
    const { tripped } = await driveWith("unarmed");
    const served = new Set(tripped);
    // Direction 1: every advertised point is reachable in a real landing write.
    for (const point of LANDING_FAULT_POINTS) expect(served).toContain(point);
    // Direction 2: the write trips nothing the roster does not advertise.
    for (const point of served) expect(LANDING_FAULT_POINTS).toContain(point);
    expect(served.size).toBe(LANDING_FAULT_POINTS.length);
    // Order is part of the contract: the windows are sequential, not a bag.
    expect(tripped).toEqual([...LANDING_FAULT_POINTS]);
  });

  it("before-intent: dies with nothing journaled and no git effect", async () => {
    const { committed, fired } = await driveWith("before-intent");
    expect(fired).toHaveLength(1);
    expect(fired[0]?.committed).toBe(0);
    expect(committed).toBe(0);
    expect(fired[0]?.evidence).toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_EVIDENCE_MISSING" });
  });

  it("after-intent: the intent is durable and git has still not been touched", async () => {
    const { committed, fired } = await driveWith("after-intent");
    expect(fired).toHaveLength(1);
    expect(fired[0]?.committed).toBe(0);
    expect(committed).toBe(0);
    expect(fired[0]?.evidence).toMatchObject({ ok: true, completion: null });
  });

  it("after-commit: THE WINDOW — git committed once, completion not journaled", async () => {
    const { committed, fired } = await driveWith("after-commit");
    expect(fired).toHaveLength(1);
    // This is the whole point of the knob: a durable git effect with no record of it.
    expect(fired[0]?.committed).toBe(1);
    expect(committed).toBe(1);
    expect(fired[0]?.evidence).toMatchObject({ ok: true, completion: null });
  });

  it("after-completion: the commit is journaled before the caller writes its receipt", async () => {
    const { committed, fired, fixture } = await driveWith("after-completion");
    expect(fired).toHaveLength(1);
    expect(committed).toBe(1);
    expect(fired[0]?.evidence).toMatchObject({
      completion: { commit: { sha: fixture.commit.sha } },
      ok: true,
    });
  });

  it("stops the write where it fired, so nothing downstream of the point runs", async () => {
    const { threw, tripped } = await driveWith("after-intent");
    expect(threw).toBe("FAULT_INJECTED:after-intent");
    expect(tripped).toEqual(["before-intent", "after-intent"]);
  });

  it("a disarmed injector reaches the end of the write and changes nothing", async () => {
    const fixture = recoveryEvidenceFixture();
    const disarmed = createLandingFaultInjector({ env: {} });
    expect(disarmed.refusal).toBe("FAULT_INJECTION_DISARMED");
    const result = await commitJournaledLanding({
      binding: fixture.binding,
      fault: disarmed,
      handle: fixture.handle,
      message: fixture.commit.message,
      paths: fixture.commit.files,
      port: {
        capture: async () => ({ ok: true as const, binding: fixture.binding }),
        commit: async () => ({ ok: true as const, receipt: fixture.commit }),
      },
      store: fixture.store,
      verifierReceiptId: fixture.verified.receipt.receiptId,
      workspace: fixture.binding.root,
    });
    expect(result).toMatchObject({ ok: true, receipt: { sha: fixture.commit.sha } });
    expect(readRepositoryLandingEvidence(fixture.store, fixture.handle)).toMatchObject({
      completion: { commit: { sha: fixture.commit.sha } },
      ok: true,
    });
  });
});

import { fenceMirroredLease, parseEffectIntent, parseMirroredLease } from "@moe/runner";
import { fenceAuthority, parseLeaseRecord } from "@moe/scheduler";
import { describe, expect, it } from "vitest";

import { countByKind, runSchedule, runStratifiedSweep } from "./work-race-schedule.js";
import { RACE_TAMPERS } from "./work-race-tampers.js";
import {
  RACE_COMMANDS,
  RACE_SEEDS,
  RACE_STEPS,
  STATE_POOL,
  legalStatesFor,
} from "./work-race-world.js";
import type { RaceStep } from "./work-race-schedule.js";
import type { WorkResult } from "./work-kernel.js";

/**
 * Claim/activate/cancel/release/duplicate-delivery orderings driven across BOTH
 * packages: `work-claim.ts` and `work-lifecycle.ts` route their lease leg into
 * `@moe/scheduler`'s `fenceAuthority` and their intent leg into `@moe/runner`'s
 * `applyEffectCommand`, so every step below crosses the daemon/scheduler and
 * daemon/runner seams at once.
 *
 * The expected outcome-kind list is HAND-WRITTEN from the closed vocabularies in
 * `work-kernel.ts` and asserted for SET EQUALITY: an unexpected kind and a
 * missing kind both fail. Per-kind counts are asserted above one, so a kind
 * reached exactly once by seed luck is a coverage failure rather than a pass.
 */
const EXPECTED_KINDS: readonly string[] = [
  "NO:AUTHORITY:WORK_AUTHORITY_SUPERSEDED:lease",
  "NO:AUTHORITY:WORK_BUDGET_REFUSED:budgetReservation",
  "NO:AUTHORITY:WORK_INTENT_REFUSED:effectIntent",
  "NO:AUTHORITY:WORK_LEASE_NOT_CURRENT:lease",
  "NO:AUTHORITY:WORK_PAYLOAD_MALFORMED:-",
  "NO:AUTHORITY:WORK_PAYLOAD_MALFORMED:lease",
  "NO:AUTHORITY:WORK_PAYLOAD_MALFORMED:slotCeiling",
  "NO:AUTHORITY:WORK_SLOT_EXHAUSTED:slotCeiling",
  "NO:AUTHORITY:WORK_SLOT_RESOURCE_INACTIVE:providerSlot",
  "NO:AUTHORITY:WORK_STALE_EPOCH:lease",
  "NO:AUTHORITY:WORK_STALE_TOKEN:lease",
  "NO:AUTHORITY:WORK_STATE_CONFLICT:effectIntent",
  "NO:INGRESS:WORK_REQUEST_INVALID:-",
  "OK:cancel:CLAIM_CANCELLED",
  "OK:claim:CLAIM_GRANTED",
  "OK:get_context:CONTEXT_VIEW",
  "OK:release:CLAIM_RELEASED",
  "OK:renew:CLAIM_RENEWED",
  "OK:resume:CLAIM_RESUMED",
];

/** Hand-written from `work-lifecycle.ts`; a successor may land nowhere else. */
const SUCCESSOR_STATE: Readonly<Record<string, string | null>> = Object.freeze({
  cancel: "DRAINING",
  release: "RELEASED",
  renew: null,
  resume: "ACTIVE",
});

const MIRROR_TO_AUTHORITY: Readonly<Record<string, string>> = Object.freeze({
  LEASE_MIRROR_MALFORMED: "AUTHORITY_MALFORMED_INPUT",
  LEASE_MIRROR_STALE: "AUTHORITY_STALE_LEASE",
  LEASE_MIRROR_STALE_EPOCH: "AUTHORITY_STALE_EPOCH",
  LEASE_MIRROR_SUPERSEDED_AUTHORITY: "AUTHORITY_SUPERSEDED_AUTHORITY",
});

const TRACES = RACE_SEEDS.map((seed) => runSchedule(seed));
const WALK_STEPS: readonly RaceStep[] = TRACES.flat();
const SWEEP_STEPS: readonly RaceStep[] = runStratifiedSweep();
const ALL_STEPS: readonly RaceStep[] = [...WALK_STEPS, ...SWEEP_STEPS];

function refusalOf(result: WorkResult): { readonly code: string; readonly upstream: string | null } {
  if (result.ok || !("failure" in result)) throw new Error("expected a refusal");
  return { code: result.failure.code, upstream: result.failure.upstreamCode };
}

describe("the state pool is asserted good before any schedule runs", () => {
  it("parses every pool member on both packages' parsers", () => {
    expect(STATE_POOL.length).toBeGreaterThanOrEqual(5);
    for (const member of STATE_POOL) {
      expect(parseLeaseRecord(member.record)).not.toBeNull();
      expect(parseMirroredLease(member.record)).not.toBeNull();
      expect(parseEffectIntent(member.intent)).not.toBeNull();
    }
    expect(new Set(STATE_POOL.map((member) => String(member.record["state"]))).size).toBe(5);
  });
});

describe("the schedule is deterministic and actually explores", () => {
  it("reproduces an identical trace from the same seed", () => {
    const seed = RACE_SEEDS[0];
    if (seed === undefined) throw new Error("seed array is empty");
    const left = runSchedule(seed).map((step) => `${step.command}/${step.tamper}/${step.label}`);
    const right = runSchedule(seed).map((step) => `${step.command}/${step.tamper}/${step.label}`);
    expect(left).toEqual(right);
  });

  it("produces a different trace from a different seed", () => {
    const [first, second] = RACE_SEEDS;
    if (first === undefined || second === undefined) throw new Error("need two seeds");
    expect(runSchedule(first).map((step) => step.label)).not.toEqual(
      runSchedule(second).map((step) => step.label),
    );
  });

  it("runs the requested seeds and steps without short-circuiting", () => {
    expect(RACE_SEEDS.length).toBeGreaterThanOrEqual(5);
    expect(RACE_STEPS).toBeGreaterThanOrEqual(200);
    expect(WALK_STEPS).toHaveLength(RACE_SEEDS.length * RACE_STEPS);
    for (const trace of TRACES) {
      expect(trace.map((step) => step.index)).toEqual(trace.map((_step, index) => index));
    }
  });

  it("draws every command and both bias arms, at the documented 70/30 split", () => {
    const drawn = new Set(WALK_STEPS.map((step) => step.command));
    expect([...drawn].sort()).toEqual([...RACE_COMMANDS].sort());
    const honest = WALK_STEPS.filter((step) => step.tamper === "honest").length;
    const tampered = WALK_STEPS.length - honest;
    expect(honest).toBeGreaterThan(0);
    expect(tampered).toBeGreaterThan(0);
    expect(honest / WALK_STEPS.length).toBeGreaterThan(0.6);
    expect(honest / WALK_STEPS.length).toBeLessThan(0.8);
    expect(new Set(WALK_STEPS.map((step) => step.tamper)).size).toBe(RACE_TAMPERS.length);
  });

  it("generates one stratified case per command, tamper arm and pool member", () => {
    // Epic rail 6: a sweep that silently produces zero cases passes while
    // testing nothing, so the generated count is asserted, not assumed.
    const expected = RACE_COMMANDS.length * RACE_TAMPERS.length * STATE_POOL.length;
    expect(expected).toBeGreaterThan(0);
    expect(SWEEP_STEPS).toHaveLength(expected);
    const pairs = new Set(SWEEP_STEPS.map((step) => `${step.command}/${step.tamper}`));
    expect(pairs.size).toBe(RACE_COMMANDS.length * RACE_TAMPERS.length);
  });
});

describe("outcome coverage", () => {
  it("observes exactly the hand-written kind set, each kind more than once", () => {
    const counts = countByKind(ALL_STEPS);
    const table = [...counts.entries()].sort(([left], [right]) => (left < right ? -1 : 1));
    // eslint-disable-next-line no-console -- the per-kind table is the gate's non-vacuity evidence
    console.log(table.map(([kind, count]) => `${kind} ${String(count)}`).join("\n"));
    expect([...counts.keys()].sort()).toEqual([...EXPECTED_KINDS].sort());
    for (const [kind, count] of counts) {
      expect(count, `outcome kind ${kind} is under-covered`).toBeGreaterThan(1);
    }
  });
});

describe("cross-package lease agreement holds on every step", () => {
  it("routes the same verdict through daemon, scheduler and runner", () => {
    let examined = 0;
    const drift: string[] = [];
    for (const step of ALL_STEPS) {
      const legal = legalStatesFor(step.command);
      if (!step.delivered.present || legal === null) continue;
      examined += 1;
      const kind = `work.${step.command}`;
      const fenced = fenceAuthority(step.delivered.record, step.delivered.proof, kind, legal as never);
      const mirror = fenceMirroredLease(
        step.delivered.record,
        step.delivered.proof,
        kind,
        legal as never,
      );
      if (fenced.ok !== (mirror.kind === "FENCED")) {
        drift.push(`${String(step.index)} mirror/authority disagree on ${step.tamper}`);
        continue;
      }
      if (fenced.ok) {
        if (!step.result.ok && "failure" in step.result && step.result.failure.leg === "lease") {
          drift.push(`${String(step.index)} daemon refused a lease the authority fenced`);
        }
        continue;
      }
      const upstream = fenced.rejection.issues[0]?.code ?? null;
      const refusal = refusalOf(step.result);
      if (refusal.upstream !== upstream) {
        drift.push(`${String(step.index)} upstream ${String(refusal.upstream)} vs ${String(upstream)}`);
      }
      const mirrored = mirror.kind === "REFUSED" ? MIRROR_TO_AUTHORITY[mirror.failure.code] : null;
      if (mirrored !== upstream) {
        drift.push(`${String(step.index)} mirror ${String(mirrored)} vs ${String(upstream)}`);
      }
    }
    // Asserted so a schedule that skipped every step still fails: epic rail 6
    // treats a sweep that silently generates zero cases as vacuous.
    expect(examined).toBeGreaterThan(RACE_STEPS);
    expect(drift).toEqual([]);
  });
});

describe("every race ends in exactly one legal state", () => {
  it("publishes successors only on an accepted result and never alongside a refusal", () => {
    for (const step of ALL_STEPS) {
      const result = step.result;
      if (result.ok) {
        expect("failure" in result).toBe(false);
        const carriers = ["successors", "successor", "view"].filter((key) => key in result);
        expect(carriers).toHaveLength(1);
        continue;
      }
      expect("successors" in result).toBe(false);
      expect("successor" in result).toBe(false);
      expect(result.authority).toBe("NONE");
    }
  });

  it("advances the lease version by exactly one, into the declared successor state", () => {
    let applied = 0;
    for (const step of ALL_STEPS) {
      if (!step.result.ok || step.result.outcome !== "WORK_APPLIED") continue;
      applied += 1;
      const before = step.before.record;
      const after = step.after.record;
      expect(after["version"]).toBe((before["version"] as number) + 1);
      const declared = SUCCESSOR_STATE[step.command];
      expect(after["state"]).toBe(declared ?? before["state"]);
    }
    expect(applied).toBeGreaterThan(0);
  });

  it("leaves no residue behind a refusal", () => {
    const refused = ALL_STEPS.filter((step) => !step.result.ok);
    expect(refused.length).toBeGreaterThan(0);
    for (const step of refused) expect(step.after).toBe(step.before);
  });
});

describe("duplicate delivery never grants twice", () => {
  it("refuses a replayed mutation and confers nothing on a replayed read", () => {
    const observed = new Map<string, number>();
    for (const step of ALL_STEPS) {
      if (step.duplicate === null) continue;
      observed.set(step.command, (observed.get(step.command) ?? 0) + 1);
      const replay = step.duplicate.result;
      if (step.command === "get_context") {
        expect(replay.ok).toBe(true);
        expect(replay.authority).toBe("NONE");
        continue;
      }
      expect(replay.ok, `${step.command} re-granted on duplicate delivery`).toBe(false);
      expect(replay.authority).toBe("NONE");
      const refusal = refusalOf(replay);
      if (step.command === "claim") {
        // The lease proof is still current, so the intent leg is what stops a
        // second claim — a runner refusal surfacing through the daemon.
        expect(refusal.code).toBe("WORK_INTENT_REFUSED");
        expect(refusal.upstream).toBe("EFFECT_TRANSITION_NOT_ADMITTED");
      } else {
        expect(refusal.code).toBe("WORK_LEASE_NOT_CURRENT");
        expect(refusal.upstream).toBe("AUTHORITY_STALE_LEASE");
      }
    }
    // Every mutating command must actually have been replayed at least once,
    // or this invariant would pass while covering nothing.
    for (const command of ["claim", "renew", "release", "resume", "cancel", "get_context"]) {
      expect(observed.get(command) ?? 0, `${command} was never duplicated`).toBeGreaterThan(0);
    }
  });
});

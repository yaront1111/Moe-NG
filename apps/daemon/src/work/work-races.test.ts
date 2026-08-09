import { fenceMirroredLease } from "@moe/runner";
import { fenceAuthority } from "@moe/scheduler";
import { describe, expect, it } from "vitest";

import { DRIFT_CASES } from "./work-race-drift-table.js";
import {
  LEASE_KIND_PARITY,
  LEASE_STATE_PARITY,
  leaseProof,
  leaseRecord,
} from "./work-race-fixtures.js";
import type { DriftCase } from "./work-race-fixtures.js";
import type { MirrorVerdict } from "@moe/runner";
import type { Fenced, LeaseState } from "@moe/scheduler";

/**
 * The cross-package drift gate.
 *
 * `packages/runner` cannot import `@moe/scheduler`, so `lease-mirror.ts` is a
 * hand-maintained clone of `fenceAuthority`. `apps/daemon` is the only package
 * that depends on both, which is why this test lives here rather than beside
 * the module it guards.
 *
 * It asserts VERDICT EQUALITY, not "both refuse": same accept/refuse decision,
 * same reason code through a hand-written mapping, and the same message — the
 * message is what pins the CHECK ORDER, since four distinct causes share
 * `AUTHORITY_STALE_LEASE` and a reordered clone would still answer that code.
 */

/**
 * Hand-written from the two closed vocabularies. An unmapped mirror code
 * becomes `UNMAPPED:<code>`, so a new code added to the mirror fails this gate
 * loudly instead of silently comparing equal to nothing.
 */
const MIRROR_TO_AUTHORITY: Readonly<Record<string, string>> = Object.freeze({
  LEASE_MIRROR_MALFORMED: "AUTHORITY_MALFORMED_INPUT",
  LEASE_MIRROR_STALE: "AUTHORITY_STALE_LEASE",
  LEASE_MIRROR_STALE_EPOCH: "AUTHORITY_STALE_EPOCH",
  LEASE_MIRROR_SUPERSEDED_AUTHORITY: "AUTHORITY_SUPERSEDED_AUTHORITY",
});

/** Every authority verdict this table must exercise; hand-written, not observed. */
const EXPECTED_AUTHORITY_VERDICTS: readonly string[] = [
  "AUTHORITY_MALFORMED_INPUT",
  "AUTHORITY_STALE_EPOCH",
  "AUTHORITY_STALE_LEASE",
  "AUTHORITY_SUPERSEDED_AUTHORITY",
  "FENCED",
];

interface Verdict {
  readonly accepted: boolean;
  readonly code: string;
  readonly message: string | null;
}

function mirrorVerdict(verdict: MirrorVerdict): Verdict {
  if (verdict.kind === "FENCED") return { accepted: true, code: "FENCED", message: null };
  const mapped = Object.hasOwn(MIRROR_TO_AUTHORITY, verdict.failure.code)
    ? MIRROR_TO_AUTHORITY[verdict.failure.code]
    : undefined;
  return {
    accepted: false,
    code: mapped ?? `UNMAPPED:${verdict.failure.code}`,
    message: verdict.failure.message,
  };
}

function authorityVerdict(fenced: Fenced): Verdict {
  if (fenced.ok) return { accepted: true, code: "FENCED", message: null };
  const issue = fenced.rejection.issues[0];
  return { accepted: false, code: issue?.code ?? "NO_ISSUE", message: issue?.message ?? null };
}

/** Returns one reason per divergence; `[]` means the two verdicts are identical. */
function compareVerdicts(mirror: Verdict, authority: Verdict): readonly string[] {
  const reasons: string[] = [];
  if (mirror.accepted !== authority.accepted) {
    reasons.push(`accepted ${String(mirror.accepted)} vs ${String(authority.accepted)}`);
  }
  if (mirror.code !== authority.code) reasons.push(`code ${mirror.code} vs ${authority.code}`);
  if (mirror.message !== authority.message) {
    reasons.push(`message ${String(mirror.message)} vs ${String(authority.message)}`);
  }
  return reasons;
}

function runCase(testCase: DriftCase): { readonly mirror: Verdict; readonly authority: Verdict } {
  return {
    authority: authorityVerdict(
      fenceAuthority(
        testCase.record,
        testCase.proof,
        testCase.commandKind,
        testCase.legalStates as never,
      ),
    ),
    mirror: mirrorVerdict(
      fenceMirroredLease(
        testCase.record,
        testCase.proof,
        testCase.commandKind,
        testCase.legalStates as never,
      ),
    ),
  };
}

const EQUAL_CASES = DRIFT_CASES.filter((entry) => entry.parity === "EQUAL");
const STRICTER_CASES = DRIFT_CASES.filter((entry) => entry.parity === "MIRROR_STRICTER");

describe("drift table shape", () => {
  it("is non-empty and covers both verdict directions", () => {
    expect(DRIFT_CASES.length).toBeGreaterThanOrEqual(35);
    expect(EQUAL_CASES.length).toBeGreaterThanOrEqual(32);
    expect(STRICTER_CASES.length).toBeGreaterThanOrEqual(3);
    const accepted = EQUAL_CASES.filter((entry) => entry.authorityCode === "FENCED");
    const refused = EQUAL_CASES.filter((entry) => entry.authorityCode !== "FENCED");
    expect(accepted.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
  });

  it("exercises every declared authority verdict exactly once as a set", () => {
    const observed = [...new Set(EQUAL_CASES.map((entry) => entry.authorityCode))].sort();
    expect(observed).toEqual([...EXPECTED_AUTHORITY_VERDICTS].sort());
  });

  it("names every case uniquely, so a duplicated row cannot inflate coverage", () => {
    expect(new Set(DRIFT_CASES.map((entry) => entry.name)).size).toBe(DRIFT_CASES.length);
  });
});

describe("compareVerdicts fires on a deliberately broken input", () => {
  const fenced: Verdict = { accepted: true, code: "FENCED", message: null };
  const stale: Verdict = {
    accepted: false,
    code: "AUTHORITY_STALE_LEASE",
    message: "lease token is not current",
  };

  it("reports nothing for identical verdicts", () => {
    expect(compareVerdicts(stale, stale)).toEqual([]);
  });

  it("reports a divergent decision", () => {
    expect(compareVerdicts(fenced, stale)).toContain("accepted true vs false");
  });

  it("reports a divergent code at the same decision", () => {
    const epoch: Verdict = { ...stale, code: "AUTHORITY_STALE_EPOCH" };
    expect(compareVerdicts(epoch, stale)).toContain(
      "code AUTHORITY_STALE_EPOCH vs AUTHORITY_STALE_LEASE",
    );
  });

  it("reports a divergent message at the same code, which is how check order drifts", () => {
    const reordered: Verdict = { ...stale, message: "session does not own this lease" };
    expect(compareVerdicts(reordered, stale)).toHaveLength(1);
  });

  it("refuses to map an unknown mirror code instead of treating it as agreement", () => {
    const verdict = mirrorVerdict({
      failure: {
        code: "LEASE_MIRROR_INVENTED" as never,
        detail: null as never,
        layer: "LEASE_MIRROR",
        message: "invented",
        ok: false,
      } as never,
      kind: "REFUSED",
    });
    expect(verdict.code).toBe("UNMAPPED:LEASE_MIRROR_INVENTED");
  });
});

describe("mirror and authority return the same verdict", () => {
  it.each(EQUAL_CASES.map((entry) => [entry.name, entry] as const))(
    "%s",
    (_name, testCase) => {
      const { authority, mirror } = runCase(testCase);
      // The hand-written expectation is checked first: if the authority itself
      // moved, this fails here rather than reporting a false agreement.
      expect(authority.code).toBe(testCase.authorityCode);
      expect(authority.message).toBe(testCase.message);
      expect(compareVerdicts(mirror, authority)).toEqual([]);
    },
  );
});

describe("the mirror is stricter only in the fail-closed direction", () => {
  it.each(STRICTER_CASES.map((entry) => [entry.name, entry] as const))(
    "%s",
    (_name, testCase) => {
      const { authority, mirror } = runCase(testCase);
      expect(authority.accepted).toBe(true);
      expect(mirror.accepted).toBe(false);
      expect(mirror.code).toBe("AUTHORITY_MALFORMED_INPUT");
    },
  );

  it("never accepts a lease the authority refused, across every case", () => {
    let examined = 0;
    const bypasses: string[] = [];
    for (const testCase of DRIFT_CASES) {
      const { authority, mirror } = runCase(testCase);
      examined += 1;
      if (!authority.accepted && mirror.accepted) bypasses.push(testCase.name);
    }
    // The counter is asserted so a table that silently produced no case — the
    // vacuous sweep epic rail 6 names — cannot pass this invariant.
    expect(examined).toBe(DRIFT_CASES.length);
    expect(bypasses).toEqual([]);
  });
});

describe("lease vocabulary parity", () => {
  it("maps every scheduler lease state and kind to the identically named mirror member", () => {
    for (const [state, mirrored] of Object.entries(LEASE_STATE_PARITY)) {
      expect(mirrored).toBe(state);
    }
    for (const [kind, mirrored] of Object.entries(LEASE_KIND_PARITY)) {
      expect(mirrored).toBe(kind);
    }
    expect(Object.keys(LEASE_STATE_PARITY)).toHaveLength(5);
    expect(Object.keys(LEASE_KIND_PARITY)).toHaveLength(3);
  });

  it("agrees on which states are parseable and which command they may accept", () => {
    const states = Object.keys(LEASE_STATE_PARITY) as readonly LeaseState[];
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) {
      const record = leaseRecord({ state });
      const { authority, mirror } = runCase({
        authorityCode: "FENCED",
        commandKind: "work.claim",
        legalStates: ["ACTIVE"],
        message: null,
        name: state,
        parity: "EQUAL",
        proof: leaseProof(),
        record,
      });
      expect(compareVerdicts(mirror, authority)).toEqual([]);
      expect(authority.accepted).toBe(state === "ACTIVE");
    }
  });

  it("agrees that an undeclared state is malformed on both surfaces", () => {
    const { authority, mirror } = runCase({
      authorityCode: "AUTHORITY_MALFORMED_INPUT",
      commandKind: "work.claim",
      legalStates: ["ACTIVE"],
      message: null,
      name: "undeclared",
      parity: "EQUAL",
      proof: leaseProof(),
      record: leaseRecord({ state: "PAUSED" }),
    });
    expect(authority.code).toBe("AUTHORITY_MALFORMED_INPUT");
    expect(compareVerdicts(mirror, authority)).toEqual([]);
  });
});

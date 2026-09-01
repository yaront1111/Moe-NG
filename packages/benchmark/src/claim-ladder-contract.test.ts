import { describe, expect, it } from "vitest";

import {
  CLAIM_LADDER,
  PERMANENTLY_FORBIDDEN,
  PINNED_SPEC_SHA256,
} from "./claim-ladder-contract.js";

const EXPECTED_RUNG_IDS = Object.freeze(["L1", "L2", "L3", "L4", "L5"] as const);
const EXPECTED_GATE_IDS = Object.freeze(["G-L1", "G-L2", "G-L3", "G-L4", "G-L5"] as const);
const EXPECTED_SUB_GATES = Object.freeze([
  Object.freeze([]),
  Object.freeze([]),
  Object.freeze(["G-L3-speed", "G-L3-budget", "G-L3-accept", "G-L3-cost"]),
  Object.freeze([
    "G-L4-quality[m]",
    "G-L4-accept[m]",
    "G-L4-effort[m]",
    "G-J1",
    "G-overhead",
    "G-UI",
    "G-L4-userstudy",
  ]),
  Object.freeze([
    "G-L4-quality[m]",
    "G-L5-accept[m]",
    "G-L5-cost[m]",
    "G-L5-effort[m]",
  ]),
]);
const EXPECTED_SCOPE_SLOTS = Object.freeze([
  Object.freeze(["ver", "date"]),
  Object.freeze(["ver", "n", "K", "model", "date"]),
  Object.freeze(["X", "a", "b", "Γ_cost", "date"]),
  Object.freeze(["ver", "effort", "comparator", "endpoint", "date", "corpus"]),
  Object.freeze([
    "cohort freeze date",
    "corpus version",
    "target user",
    "ver",
    "named model-matched cohort at pinned versions",
    "≥1 superiority-gated dimension",
  ]),
]);
const EXPECTED_FORBIDDEN = Object.freeze([
  "unscoped or undated superlatives",
  "any \"best\" lacking the four-part scope (date, corpus, target user, named cohort)",
  "production-ready for all users",
  "equals",
  "matching",
  "on par",
  "parity",
  "same as",
  "cheaper",
  "lower cost",
  "any number not linked to raw evidence",
  "any exact ratio across incompatible price bases",
  "safest",
  "more reliable",
  "higher quality",
  "production-ready",
] as const);

const L4_TEMPLATE =
  "For a solo developer delegating autonomous coding work under local constraints, "
  + "Moe v{ver} (at {effort} to match {comparator}) is no worse in reviewed quality "
  + "and requires fewer {endpoint} than {comparator} on decomposable work "
  + "(as of {date}, {corpus}).";

function slotsIn(template: string): readonly string[] {
  return [...new Set(
    [...template.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? ""),
  )];
}

describe("claim ladder transcription", () => {
  it("pins the source bytes that authorize the transcription", () => {
    expect(PINNED_SPEC_SHA256).toBe(
      "a62b90436cc0b911fb28526af7b7e0f2d1370f6f93db91c26077f6e2956a589c",
    );
  });

  it("carries exactly the five frozen rungs and their gates in order", () => {
    const actualRungIds = CLAIM_LADDER.map(({ rungId }) => rungId);
    expect(Object.isFrozen(CLAIM_LADDER)).toBe(true);
    expect(Object.isFrozen(EXPECTED_RUNG_IDS)).toBe(true);
    expect(CLAIM_LADDER).toHaveLength(5);
    expect(actualRungIds).toEqual(EXPECTED_RUNG_IDS);
    expect(new Set(actualRungIds)).toEqual(new Set(EXPECTED_RUNG_IDS));
    expect(new Set(EXPECTED_RUNG_IDS)).toEqual(new Set(actualRungIds));
    expect(CLAIM_LADDER.map(({ gateId }) => gateId)).toEqual(EXPECTED_GATE_IDS);
    for (const rung of CLAIM_LADDER) {
      expect(Object.isFrozen(rung)).toBe(true);
      expect(Object.isFrozen(rung.subGateIds)).toBe(true);
      expect(Object.isFrozen(rung.scopeSlots)).toBe(true);
      expect(rung.template.length).toBeGreaterThan(0);
    }
  });

  it("transcribes every named sub-gate and mandatory template slot", () => {
    expect(CLAIM_LADDER.map(({ subGateIds }) => subGateIds)).toEqual(EXPECTED_SUB_GATES);
    expect(CLAIM_LADDER.map(({ scopeSlots }) => scopeSlots)).toEqual(EXPECTED_SCOPE_SLOTS);
    for (const rung of CLAIM_LADDER) {
      expect(rung.scopeSlots).toEqual(slotsIn(rung.template));
    }
  });

  it("keeps the L4 public sentence byte-for-byte verbatim", () => {
    expect(CLAIM_LADDER[3]?.template).toBe(L4_TEMPLATE);
  });

  it("freezes the exact nonempty permanently-forbidden roster", () => {
    expect(Object.isFrozen(PERMANENTLY_FORBIDDEN)).toBe(true);
    expect(PERMANENTLY_FORBIDDEN).toHaveLength(16);
    expect(PERMANENTLY_FORBIDDEN).toEqual(EXPECTED_FORBIDDEN);
  });
});

import { describe, expect, it } from "vitest";

import {
  PRE_FREEZE_AUDIT_CODES, PRE_FREEZE_AUDIT_LAYER, preFreezeAuditRefusal,
} from "./pre-freeze-audit-vocabulary.js";
import {
  FROZEN_COMPARATOR_GATE_IDS, FROZEN_CONSTANT_SYMBOL_COUNT, FROZEN_GATE_IDS,
  FROZEN_GATE_THRESHOLD_SYMBOLS, FROZEN_NI_TAIL_DIRECTIONS, FROZEN_OUT_OF_LADDER_GATE_IDS,
  FROZEN_REFERENCE_CARDINALITY, FROZEN_RUNG_GATE_INVENTORY, FROZEN_RUNG_IDS,
  FROZEN_SYMBOL_ASCII_ALIASES, FROZEN_UMBRELLA_GATE_IDS,
} from "./pre-freeze-audit-rosters.js";

/**
 * The rosters are asserted against an INDEPENDENT hand transcription made here from the
 * same pinned spec bytes. Two transcriptions that must agree is the falsifiable form: if
 * the production roster is ever rewritten to derive itself from the scan it audits, this
 * literal list stops agreeing the moment the document moves. A test that iterated the
 * production roster could not see that.
 */
const TRANSCRIBED_GATE_IDS = [
  "G-J1", "G-L1", "G-L2", "G-L3", "G-L3-accept", "G-L3-budget", "G-L3-cost", "G-L3-speed",
  "G-L4", "G-L4-accept", "G-L4-effort", "G-L4-quality", "G-L4-userstudy", "G-L5",
  "G-L5-accept", "G-L5-cost", "G-L5-effort", "G-UI", "G-expand", "G-overhead",
];

describe("pre-freeze audit vocabulary (task-71a4fac5d15044c08f6617f50a561e39)", () => {
  it("names the one layer rail 2 fixes for this audit", () => {
    expect(PRE_FREEZE_AUDIT_LAYER).toBe("PRE_FREEZE_AUDIT");
  });

  it("closes the code roster over seventeen distinct repairs", () => {
    expect(new Set(PRE_FREEZE_AUDIT_CODES).size).toBe(PRE_FREEZE_AUDIT_CODES.length);
    expect([...PRE_FREEZE_AUDIT_CODES].sort()).toEqual([
      "CI_TAIL_DIRECTION_WRONG", "COMPARATOR_INDEX_MISSING", "CONSTANT_UNRESOLVED",
      "CORPUS_ROOT_DIRTY", "CORPUS_ROOT_MOVED", "CORPUS_ROOT_UNREADABLE",
      "CORPUS_ROOT_UNSET", "CORPUS_ROOT_UNVERSIONED", "GATE_INVENTORY_MISMATCH",
      "REFERENCE_AMBIGUOUS", "REFERENCE_DUPLICATE", "REFERENCE_UNRESOLVED",
      "SPEC_BYTES_UNPINNED", "SPEC_UNPARSEABLE", "SWEEP_ZERO_CASES",
      "TOKEN_SET_MISMATCH", "TRIVALENT_INCOMPLETE",
    ]);
    expect(Object.isFrozen(PRE_FREEZE_AUDIT_CODES)).toBe(true);
  });

  /**
   * The five corpus-authority codes are asserted as a DISTINCT SUBSET, not merely as roster
   * members. A single catch-all would satisfy the set-equality arm above just as well once
   * the transcription was updated to match it; only pinning that the five spell five
   * different repairs keeps "unset environment variable" distinguishable from "dirty
   * corpus", which is the whole of DoD 3's "exact stable code" clause.
   */
  it("spells the five corpus-authority repairs as five distinct codes", () => {
    const corpus = PRE_FREEZE_AUDIT_CODES.filter((code) => code.startsWith("CORPUS_ROOT_"));
    expect(corpus.length).toBe(5);
    expect(new Set(corpus).size).toBe(5);
    for (const code of corpus) expect(preFreezeAuditRefusal(code, 0, "").layer)
      .toBe(PRE_FREEZE_AUDIT_LAYER);
  });

  it("carries code, layer and exact source location on every refusal, frozen", () => {
    const refusal = preFreezeAuditRefusal("REFERENCE_AMBIGUOUS", 407, "S3");
    expect(refusal).toEqual({
      code: "REFERENCE_AMBIGUOUS", layer: "PRE_FREEZE_AUDIT", line: 407, ok: false, token: "S3",
    });
    expect(Object.isFrozen(refusal)).toBe(true);
    expect(() => {
      (refusal as { code: string }).code = "SPEC_UNPARSEABLE";
    }).toThrow(TypeError);
  });

  it("hands out a fresh refusal per call so no caller can poison another's copy", () => {
    const a = preFreezeAuditRefusal("SWEEP_ZERO_CASES", 0, "");
    const b = preFreezeAuditRefusal("SWEEP_ZERO_CASES", 0, "");
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("pre-freeze audit frozen rosters (task-71a4fac5d15044c08f6617f50a561e39)", () => {
  it("transcribes exactly the twenty gate IDs measured in the pinned spec", () => {
    expect([...FROZEN_GATE_IDS].sort()).toEqual([...TRANSCRIBED_GATE_IDS].sort());
    expect(FROZEN_GATE_IDS.length).toBe(20);
  });

  it("separates the three umbrella IDs and the one out-of-ladder gate", () => {
    expect([...FROZEN_UMBRELLA_GATE_IDS]).toEqual(["G-L3", "G-L4", "G-L5"]);
    expect([...FROZEN_OUT_OF_LADDER_GATE_IDS]).toEqual(["G-expand"]);
    for (const id of [...FROZEN_UMBRELLA_GATE_IDS, ...FROZEN_OUT_OF_LADDER_GATE_IDS]) {
      expect(FROZEN_GATE_IDS).toContain(id);
    }
  });

  it("transcribes the six comparator-indexed gates spec 12.1 item 2 enumerates", () => {
    expect([...FROZEN_COMPARATOR_GATE_IDS].sort()).toEqual([
      "G-L4-accept", "G-L4-effort", "G-L4-quality", "G-L5-accept", "G-L5-cost", "G-L5-effort",
    ]);
  });

  it("pins the five rungs and the 22 / 14 / 14 reference cardinalities", () => {
    expect([...FROZEN_RUNG_IDS]).toEqual(["L1", "L2", "L3", "L4", "L5"]);
    expect(FROZEN_REFERENCE_CARDINALITY).toEqual({ "BENCH-S": 14, "CORE-I": 22, "CORE-S": 14 });
  });

  it("transcribes the cumulative rung inventory, monotone and umbrella-free", () => {
    expect([...FROZEN_RUNG_GATE_INVENTORY.L1]).toEqual(["G-L1"]);
    expect([...FROZEN_RUNG_GATE_INVENTORY.L2]).toEqual(["G-L1", "G-L2"]);
    let previous: readonly string[] = [];
    for (const rung of FROZEN_RUNG_IDS) {
      const listed = FROZEN_RUNG_GATE_INVENTORY[rung];
      expect(new Set(listed).size).toBe(listed.length);
      for (const id of listed) expect(FROZEN_GATE_IDS).toContain(id);
      for (const id of listed) expect(FROZEN_UMBRELLA_GATE_IDS).not.toContain(id);
      for (const id of previous) expect(listed).toContain(id);
      previous = listed;
    }
    expect(previous.length).toBe(16);
  });

  it("pins which margin symbol each acceptance gate resolves (the M_accept fan-out trap)", () => {
    expect(FROZEN_GATE_THRESHOLD_SYMBOLS["G-L3-accept"]).toContain("M_accept");
    expect(FROZEN_GATE_THRESHOLD_SYMBOLS["G-L3-accept"]).not.toContain("M_accept_x");
    for (const gate of ["G-L4-accept", "G-L5-accept"] as const) {
      expect(FROZEN_GATE_THRESHOLD_SYMBOLS[gate]).toContain("M_accept_x");
      expect(FROZEN_GATE_THRESHOLD_SYMBOLS[gate]).not.toContain("M_accept");
    }
  });

  it("pins the seven non-inferiority tails to their endpoint worse-direction", () => {
    const entries = Object.entries(FROZEN_NI_TAIL_DIRECTIONS);
    expect(entries.length).toBe(7);
    for (const [, spec] of entries) {
      expect(spec.tail).toBe(spec.endpoint === "HIGHER_IS_BETTER" ? "LOWER" : "UPPER");
    }
    expect(FROZEN_NI_TAIL_DIRECTIONS["G-L4-accept"]).toEqual({
      endpoint: "HIGHER_IS_BETTER", tail: "LOWER",
    });
    expect(FROZEN_NI_TAIL_DIRECTIONS["G-L5-cost"]).toEqual({
      endpoint: "WORSE_IS_HIGHER", tail: "UPPER",
    });
  });

  it("pins the Section 0 table size and the ASCII spellings of its Greek symbols", () => {
    expect(FROZEN_CONSTANT_SYMBOL_COUNT).toBe(38);
    expect(FROZEN_SYMBOL_ASCII_ALIASES["Gamma_cost"]).toBe("Γ_cost");
    expect(FROZEN_SYMBOL_ASCII_ALIASES["beta_blind"]).toBe("β_blind");
    expect(FROZEN_SYMBOL_ASCII_ALIASES["alpha_test"]).toBe("α_test");
    expect(Object.keys(FROZEN_SYMBOL_ASCII_ALIASES).length).toBe(12);
  });
});

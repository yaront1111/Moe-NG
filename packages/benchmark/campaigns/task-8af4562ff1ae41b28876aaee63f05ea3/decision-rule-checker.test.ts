import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", { spy: true });

import {
  FROZEN_GATE_IDS, FROZEN_OUT_OF_LADDER_GATE_IDS, FROZEN_RUNG_GATE_INVENTORY, FROZEN_RUNG_IDS,
  FROZEN_UMBRELLA_GATE_IDS, TRIVALENT_VERDICTS, admitConfirmatoryFreezeManifest,
  decodeConfirmatoryFreezeManifest, resolveRungVerdict, type GateVerdict,
} from "@moe/benchmark";

/**
 * DoD 3 — THE INDEPENDENT DECISION-RULE CHECKER for task-8af4562ff1ae41b28876aaee63f05ea3.
 *
 * WHAT MAKES IT INDEPENDENT, and it is the whole point of the clause. It re-derives every
 * verdict from the RECORDED UNITS and the frozen rules, then compares the derivation with
 * what the campaign printed. It never reads `gateReports` to decide what a gate should say.
 * A checker that consumed the campaign's own verdicts would certify nothing: it would agree
 * with the report by construction. Mutate any printed verdict and this file reddens.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM. This campaign completed ZERO units, so the checker's
 * derivation rests on the absence-of-evidence rule alone (spec :85, "Absence-of-evidence =>
 * UNKNOWN"), applied through the production resolver's empty-set case. It therefore DECLARES
 * ITS OWN APPLICABILITY BOUND: if a future record reports any completed unit, the checker
 * THROWS instead of certifying, because per-gate evidence linkage would then be required and
 * this file does not model it. A checker that silently kept passing over data it cannot grade
 * is the failure mode the clause exists to prevent.
 *
 * THE VERDICT RULE IS NOT REIMPLEMENTED HERE. `resolveRungVerdict` (FAIL dominates; empty or
 * any UNKNOWN is UNKNOWN) is the landed production surface and is called, never copied — a
 * campaign that re-derived a softer rule of its own would be a competing authority over the
 * exact question it exists to answer. The roster is the hand-transcribed production constant
 * `FROZEN_GATE_IDS`, and gate exemption comes from `FROZEN_OUT_OF_LADDER_GATE_IDS`, so neither
 * side of the coverage check is computed from the campaign's own output.
 */

const RECORD_PATH = join(import.meta.dirname, "campaign-record.json");
const FREEZE_PATH = join(
  import.meta.dirname, "..", "task-3a34adcabd03489e84f8dfbec913633a", "freeze-record.json",
);
const EXEMPT_STATUS = "N/A (gate-exempt)";
const EXEMPT: readonly string[] = FROZEN_OUT_OF_LADDER_GATE_IDS;
const LADDER: readonly string[] = FROZEN_GATE_IDS;
const UMBRELLAS: readonly string[] = FROZEN_UMBRELLA_GATE_IDS;

/**
 * Forbidden at L0, which licenses no comparative sentence at all. Spec :81 bans synonyms too,
 * so the superlatives and the softened forms are listed beside the plain ones.
 */
const FORBIDDEN_CLAIM_TOKENS = [
  "faster", "fastest", "cheaper", "cheapest", "better", "best", "safer", "safest",
  "more reliable", "higher quality", "production-ready", "leading", "superior",
  "outperform", "non-inferior", "noninferior", "wins", "beats", "matches", "matching",
];

type UnitFamilyReport = {
  readonly family: string;
  readonly requiredCount: string;
  readonly instantiatedCount: number;
  readonly completeCount: number;
  readonly disposition: string;
  readonly censoringRuleApplied: string | null;
  readonly agentFailureCensoredCount: number;
  readonly reason: string;
};

type GateReport = {
  readonly gateId: string;
  readonly status: string;
  readonly basis: string;
  readonly reason: string;
};

type CampaignRecord = {
  readonly schemaVersion: string;
  readonly campaignRow: string;
  readonly freeze: {
    readonly manifestSha256: string;
    readonly campaignId: string;
    readonly implementationSha: string;
    readonly attestation: string;
  };
  readonly units: readonly UnitFamilyReport[];
  readonly gateReports: readonly GateReport[];
  readonly rungReports: readonly { readonly rung: string; readonly verdict: string; readonly basis: string }[];
  readonly highestAllPassRung: string;
  readonly statementFamilies: readonly {
    readonly family: string; readonly status: string; readonly sentence: string | null;
  }[];
  readonly permittedStatement: string;
  readonly scopeNotEstablished: readonly string[];
};

const readRecord = (): CampaignRecord =>
  JSON.parse(readFileSync(RECORD_PATH, "utf8")) as CampaignRecord;

const freezeBytes = (): Uint8Array => new Uint8Array(readFileSync(FREEZE_PATH));

const freezeSha256 = (): string =>
  createHash("sha256").update(readFileSync(FREEZE_PATH, "utf8")).digest("hex");

/** Members of an umbrella gate, derived from the roster by prefix rather than hand-listed. */
const umbrellaMembers = (umbrella: string): readonly string[] =>
  LADDER.filter((gateId) => gateId.startsWith(`${umbrella}-`));

/**
 * THE RE-DERIVATION. Input is `record.units` and the frozen rules; `record.gateReports` is not
 * consulted. Zero complete units means every gate's evidence set is empty, and the production
 * resolver answers UNKNOWN for an empty set.
 */
const deriveVerdicts = (record: CampaignRecord): ReadonlyMap<string, GateVerdict> => {
  const completed = record.units.reduce((total, unit) => total + unit.completeCount, 0);
  if (completed > 0) {
    throw new Error(
      `this checker only certifies a zero-evidence campaign; ${completed} complete units need per-gate linkage`,
    );
  }
  const derived = new Map<string, GateVerdict>();
  for (const gateId of LADDER) {
    if (EXEMPT.includes(gateId)) continue;
    if (UMBRELLAS.includes(gateId)) continue;
    derived.set(gateId, resolveRungVerdict([]));
  }
  for (const umbrella of UMBRELLAS) {
    const members = umbrellaMembers(umbrella);
    const memberVerdicts = members.map((member) => {
      const verdict = derived.get(member);
      if (!verdict) throw new Error(`umbrella ${umbrella} names an underived member ${member}`);
      return verdict;
    });
    derived.set(umbrella, resolveRungVerdict(memberVerdicts));
  }
  return derived;
};

const deriveRungVerdict = (
  rung: string, verdicts: ReadonlyMap<string, GateVerdict>,
): GateVerdict => {
  const inventory = (FROZEN_RUNG_GATE_INVENTORY as Record<string, readonly string[]>)[rung];
  if (!inventory) throw new Error(`no frozen inventory for rung ${rung}`);
  return resolveRungVerdict(inventory.filter((gateId) => !EXEMPT.includes(gateId))
    .map((gateId) => {
      const verdict = verdicts.get(gateId);
      if (!verdict) throw new Error(`rung ${rung} names an underived gate ${gateId}`);
      return verdict;
    }));
};

const deriveHighestAllPassRung = (verdicts: ReadonlyMap<string, GateVerdict>): string => {
  let highest = "L0";
  for (const rung of FROZEN_RUNG_IDS) {
    if (deriveRungVerdict(rung, verdicts) !== "PASS") break;
    highest = rung;
  }
  return highest;
};

const stubHorizon = (head: string, pairs = 2): void => {
  const git = vi.mocked(execFileSync);
  git.mockClear();
  for (let index = 0; index < pairs; index += 1) {
    git.mockImplementationOnce(() => Buffer.from(`${head}\n`) as never)
      .mockImplementationOnce(() => Buffer.alloc(0) as never);
  }
};

afterEach(() => {
  vi.mocked(execFileSync).mockReset();
  vi.restoreAllMocks();
});

describe("comparative campaign decision-rule checker (task-8af4562ff1ae41b28876aaee63f05ea3)", () => {
  it("decides every advertised gate and advertises every decided gate, as set equality", () => {
    const record = readRecord();
    const reported = record.gateReports.map(({ gateId }) => gateId);
    expect(reported).toHaveLength(LADDER.length);
    expect(new Set(reported).size).toBe(reported.length);
    expect([...LADDER].filter((gateId) => !reported.includes(gateId))).toEqual([]);
    expect(reported.filter((gateId) => !LADDER.includes(gateId))).toEqual([]);
    expect(new Set(reported)).toEqual(new Set(LADDER));
  });

  it("re-derives each verdict from the recorded units and matches what the campaign printed", () => {
    const record = readRecord();
    const derived = deriveVerdicts(record);
    for (const report of record.gateReports) {
      if (EXEMPT.includes(report.gateId)) {
        expect(report.status).toBe(EXEMPT_STATUS);
        expect(report.basis).toBe("DECLARED_EXEMPT");
        expect(TRIVALENT_VERDICTS).not.toContain(report.status);
        continue;
      }
      const expected = derived.get(report.gateId);
      expect(`${report.gateId}=${report.status}`).toBe(`${report.gateId}=${expected}`);
      expect(TRIVALENT_VERDICTS).toContain(report.status);
      expect(report.basis)
        .toBe(UMBRELLAS.includes(report.gateId) ? "INHERITED" : "EVIDENCE_ABSENT");
    }
    expect(derived.size).toBe(LADDER.length - EXEMPT.length);
    expect([...derived.values()].filter((verdict) => verdict !== "UNKNOWN")).toEqual([]);
    console.log(`DERIVED GATE VERDICTS: ${[...derived.entries()]
      .map(([gateId, verdict]) => `${gateId}=${verdict}`).join(" ")}`);
  });

  it("re-derives every rung and the highest all-PASS rung as L0", () => {
    const record = readRecord();
    const derived = deriveVerdicts(record);
    expect(record.rungReports.map(({ rung }) => rung)).toEqual([...FROZEN_RUNG_IDS]);
    for (const report of record.rungReports) {
      expect(`${report.rung}=${report.verdict}`)
        .toBe(`${report.rung}=${deriveRungVerdict(report.rung, derived)}`);
      expect(report.verdict).toBe("UNKNOWN");
      expect(report.basis).toBe("INHERITED");
    }
    expect(record.highestAllPassRung).toBe(deriveHighestAllPassRung(derived));
    expect(record.highestAllPassRung).toBe("L0");
  });

  it("records a disposition for every unit family and never censors absence", () => {
    const record = readRecord();
    const families = record.units.map(({ family }) => family);
    expect(families).toEqual([
      "arms", "repetitions", "oracles", "receipts", "raters", "user-study-cases",
    ]);
    for (const unit of record.units) {
      expect(unit.disposition).toBe("NOT_INSTANTIATED");
      expect(unit.requiredCount).toBe("UNKNOWN");
      expect(unit.instantiatedCount).toBe(0);
      expect(unit.completeCount).toBe(0);
      // Censoring classifies a unit that started; it cannot classify one that never existed.
      // Spec :306 rule 4 additionally puts agent failure outside administrative censoring.
      expect(unit.censoringRuleApplied).toBeNull();
      expect(unit.agentFailureCensoredCount).toBe(0);
      expect(unit.reason.length).toBeGreaterThan(0);
    }
  });

  it("emits the L0 statement and licenses no sentence in any of the seven families", () => {
    const record = readRecord();
    expect(record.statementFamilies.map(({ family }) => family)).toEqual([
      "cost", "acceptance", "effort", "speed", "quality", "overhead", "safety",
    ]);
    for (const family of record.statementFamilies) {
      expect(family.sentence).toBeNull();
      expect(family.status).toBe("UNKNOWN");
    }
    const lowered = record.permittedStatement.toLowerCase();
    expect(lowered).toContain("l0");
    for (const token of FORBIDDEN_CLAIM_TOKENS) expect(lowered).not.toContain(token);
    expect(record.scopeNotEstablished.length).toBeGreaterThan(0);
  });

  it("binds to the one frozen implementation SHA, re-read from the freeze record itself", () => {
    const record = readRecord();
    const decoded = decodeConfirmatoryFreezeManifest(freezeBytes());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(record.freeze.manifestSha256).toBe(freezeSha256());
    expect(record.freeze.campaignId).toBe(decoded.manifest.campaignId);
    expect(record.freeze.implementationSha).toBe(decoded.manifest.implementationSha);
    expect(record.freeze.attestation).toBe(decoded.manifest.attestation.status);
    expect(record.freeze.attestation).toBe("UNATTESTED");
  });

  it("refuses mechanically when the repository selects a different implementation SHA", () => {
    const record = readRecord();
    const movedHead = "c".repeat(40);
    expect(movedHead).toMatch(/^[a-f0-9]{40}$/);
    expect(movedHead).not.toBe(record.freeze.implementationSha);
    stubHorizon(movedHead);
    const admission = admitConfirmatoryFreezeManifest(freezeBytes());
    expect(admission.ok).toBe(false);
    if (admission.ok) return;
    expect(admission.code).toBe("CONFIRMATORY_FREEZE_MANIFEST_IMPLEMENTATION_SHA_MISMATCH");
    expect(admission.layer).toBe("CONFIRMATORY_FREEZE_MANIFEST_ADMISSION");
    expect(admission.sourceCode).toBe("CONFIRMATORY_FREEZE_GIT_IMPLEMENTATION_MISMATCH");
    expect(admission.sourceLayer).toBe("CONFIRMATORY_FREEZE_GIT");
    expect(freezeSha256()).toBe(record.freeze.manifestSha256);
  });

  it("admits the campaign's own freeze for the SHA it is bound to", () => {
    const record = readRecord();
    stubHorizon(record.freeze.implementationSha);
    const admission = admitConfirmatoryFreezeManifest(freezeBytes());
    if (!admission.ok) throw new Error(`${admission.code}/${admission.sourceCode}`);
    expect(admission.manifestSha256).toBe(record.freeze.manifestSha256);
    expect(admission.custody).toEqual({ status: "UNATTESTED", attestedCustody: "UNKNOWN" });
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(4);
  });
});

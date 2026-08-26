import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", { spy: true });

import {
  CONFIRMATORY_FREEZE_AUTHORITY_CODE, CONFIRMATORY_FREEZE_AUTHORITY_LAYER,
  CONFIRMATORY_FREEZE_BINDING_KINDS, FREEZE_MANIFEST_SCHEMA_VERSION,
  FROZEN_COMPARABLE_COHORT_FLOOR, FROZEN_COMPARATOR_GATE_IDS, FROZEN_CONSTANT_SYMBOL_COUNT,
  FROZEN_GATE_IDS, FROZEN_GATE_THRESHOLD_SYMBOLS, FROZEN_NI_TAIL_DIRECTIONS,
  FROZEN_OUT_OF_LADDER_GATE_IDS, FROZEN_REFERENCE_CARDINALITY, FROZEN_RUNG_GATE_INVENTORY,
  FROZEN_RUNG_IDS, FROZEN_SCHEDULE_COVERAGE_FLOOR, FROZEN_SYMBOL_ASCII_ALIASES,
  FROZEN_UMBRELLA_GATE_IDS, PINNED_BENCHMARK_SPEC_SHA256, PINNED_REBUILD_DESIGN_SHA256,
  TRIVALENT_VERDICTS,
  admitConfirmatoryFreezeManifest, canonicalizeConfirmatoryFreezeManifest,
  decodeConfirmatoryFreezeManifest, deriveConfirmatoryFreezeCampaignId,
  deriveConfirmatoryFreezeManifestRegistryRef, isPinnedDocument, readConfirmatoryFreezeAuthority,
  readPinnedBenchmarkSpec, readPinnedRebuildDesign, runPreFreezeAudit,
  type ConfirmatoryFreezeManifest,
} from "@moe/benchmark";

/**
 * The campaign-owned proof for task-3a34adcabd03489e84f8dfbec913633a.
 *
 * WHAT THE SIBLING JSON IS. It is the canonical confirmatory freeze manifest itself — the exact
 * ten-key shape `decodeConfirmatoryFreezeManifest` admits — not a wrapper carrying extra
 * "sections". The producer refuses an extra key rather than trimming it, so every fact that is
 * not one of those ten keys lives either inside a binding's digest preimage (declared verbatim
 * below) or in the row's durable comment.
 *
 * WHY THE UNKNOWN DECLARATIONS EXIST. Seven of the twelve binding kinds have no artifact: no
 * corpus, prompts, scripts, cohort, analysis, configuration or reference-hardware identity was
 * ever supplied to this row. A binding slot cannot be omitted and cannot hold the word UNKNOWN,
 * so each of those slots commits to an explicit UNKNOWN DECLARATION whose bytes are written out
 * below. The digest is therefore a truthful commitment to "this artifact does not exist", never
 * an invented commitment to artifacts that do. A reader recreates any of them from this file.
 *
 * WHY THE GIT HORIZON IS STUBBED ON THE ACCEPTED ARM. `admitConfirmatoryFreezeManifest` refuses
 * unless real `git` reports the frozen SHA at HEAD over a totally clean tree. This is a shared
 * worktree with foreign work in it and HEAD advances hourly, so the accepted path is reachable
 * only with the horizon supplied — exactly as the producer's own accepted control does it. Every
 * other check runs for real: the pinned documents are read from disk, the campaign identity is
 * re-derived by the production functions, and the refusal arms are production refusals.
 *
 * WHAT THIS FREEZE WAS SEALED WITHOUT — read this before citing the campaign for anything.
 * Governor ruling comment-fd14351d requires the record to state its own evidential strength, so
 * a reader never has to reconstruct the thread that produced it.
 *  - NO CUSTODY ATTESTATION. `readConfirmatoryFreezeAuthority()` still refuses with
 *    CONFIRMATORY_FREEZE_AUTHORITY_UNASSIGNED. There is no independent author, signer key,
 *    trusted key distribution or public registry entry, and none was invented (comment-c4e2e84f).
 *  - NO ANNOTATOR, RATER OR ADJUDICATOR FACTS. The seal was authorized without them; inventing
 *    them would have invented research provenance.
 *  - NO CORPUS, PROMPTS, SCRIPTS, CONFIGURATION, ANALYSIS, COHORT OR REFERENCE-HARDWARE ARTIFACT.
 *  - EVERY GATE IS UNKNOWN FOR THIS CAMPAIGN. The ruling names 18 affected gates; rather than
 *    guess which two of production's twenty are exempt, all twenty read UNKNOWN here. That is a
 *    superset of the ruling and never upgrades a gate, which is the direction the permit-list
 *    rail allows. No gate is PASS and none is omitted.
 *  - A62 (the pinned benchmark spec) is Revision 4, USABLE_NOT_NORMATIVE, awaiting human
 *    ratification. Its SHA-256 matching the rail is byte identity, NOT ratification.
 *  - GO_QUIESCE is recorded (comment-14cf36f3 on task-e60b874b: principal the human board
 *    operator, moment 2026-08-24T10:26Z). GO_ACTIVATE is a STANDING authorization
 *    (comment-c34269c9) whose binding is deferred to activation time; this campaign does not
 *    bind it and takes no activation decision.
 */

const RECORD_PATH = join(import.meta.dirname, "freeze-record.json");
const IMPLEMENTATION_SHA = "e98b231ca7b5c250240452f89d123217bc3a3f6a";
const MANIFEST_SHA256 = "16ac110540ed68c7c42dbac5c307e73f4ccb8770ac907ef8a1a976a4c5ff1b93";
const ABSENT_CODE = "CONFIRMATORY_FREEZE_CAMPAIGN_FACT_ABSENT";
const ABSENT_LAYER = "CONFIRMATORY_FREEZE_CAMPAIGN";
const MANIFEST_KEYS = [
  "attestation", "bindings", "campaignId", "campaignLabel", "implementationFrozenAt",
  "implementationSha", "manifestRegistryRef", "projectId", "schemaVersion", "sealedAt",
];

const ABSENT_REASONS: Readonly<Record<string, string>> = {
  HARDWARE_RUNTIME_IDENTITY: "no reference machine, OS, tool, container, or provider-adapter identity was supplied through a non-developer channel; naming this host would claim a reference machine that was never designated",
  CORPUS: "no confirmatory corpus was authored, generated, or viewed by this row; this binding commits to this declaration and never to corpus bytes",
  CONFIGURATION: "no confirmatory corpus configuration was supplied; the campaign has no generator seed, fixture set, or sealed-defect roster to commit to",
  ANALYSIS: "no frozen analysis script and no separate pilot dry-run identity were supplied",
  PROMPTS: "no verbatim prompts and no human-assistance script were supplied; committing a digest over absent prompt text would invent the evidence it names",
  SCRIPTS: "no corpus generator or campaign execution scripts were supplied",
  COHORT: "no executed-cohort run/no-run roster, product-by-scenario COMPARABLE/ADAPTED/ABSENT matrix, adapter design, or action-equivalence taxonomy was supplied; annotator, rater, and adjudicator facts are absent by governor ruling comment-fd14351d",
};

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const absentDeclaration = (kind: string): Record<string, unknown> => ({
  kind, status: "UNKNOWN", code: ABSENT_CODE, layer: ABSENT_LAYER, reason: ABSENT_REASONS[kind],
});

const frozenConstantsDeclaration = (): Record<string, unknown> => ({
  kind: "FROZEN_CONSTANTS", status: "FROZEN", source: "@moe/benchmark#pre-freeze-audit-rosters",
  constantSymbolCount: FROZEN_CONSTANT_SYMBOL_COUNT,
  gateThresholdSymbols: FROZEN_GATE_THRESHOLD_SYMBOLS,
  symbolAsciiAliases: FROZEN_SYMBOL_ASCII_ALIASES,
  referenceCardinality: FROZEN_REFERENCE_CARDINALITY,
  scheduleCoverageFloor: FROZEN_SCHEDULE_COVERAGE_FLOOR,
  comparableCohortFloor: FROZEN_COMPARABLE_COHORT_FLOOR,
  niTailDirections: FROZEN_NI_TAIL_DIRECTIONS,
});

const campaignGateVerdicts = (): Record<string, string> =>
  Object.fromEntries(FROZEN_GATE_IDS.map((gateId) => [gateId, "UNKNOWN"]));

const gateInventoryDeclaration = (): Record<string, unknown> => ({
  kind: "GATE_INVENTORY", status: "FROZEN", source: "@moe/benchmark#pre-freeze-audit-rosters",
  gateIds: FROZEN_GATE_IDS, rungIds: FROZEN_RUNG_IDS,
  rungGateInventory: FROZEN_RUNG_GATE_INVENTORY,
  umbrellaGateIds: FROZEN_UMBRELLA_GATE_IDS,
  outOfLadderGateIds: FROZEN_OUT_OF_LADDER_GATE_IDS,
  campaignGateVerdicts: campaignGateVerdicts(),
  campaignGateVerdictReason: "this campaign was sealed without annotator, rater, adjudicator, custody, corpus, prompt, script, cohort, configuration, analysis or reference-hardware facts, so no gate is decidable; governor ruling comment-fd14351d names 18 affected gates and this campaign marks all 20 production gate ids UNKNOWN rather than guess which are exempt",
});

const comparatorDeclaration = (): Record<string, unknown> => ({
  kind: "COMPARATOR_MODEL_MATCH_MATRIX", status: "UNKNOWN", code: ABSENT_CODE, layer: ABSENT_LAYER,
  comparatorGateIds: FROZEN_COMPARATOR_GATE_IDS,
  comparatorProducts: "UNKNOWN", comparatorVersionConfigIdentities: "UNKNOWN",
  modelIdSnapshotEffortTriple: "UNKNOWN",
  reason: "the comparator gate ids are frozen from production, but no comparator product, version/config identity, or model-ID + snapshot + reasoning-effort triple was supplied",
});

const expectedBinding = (kind: string): string => {
  if (kind === "DESIGN") return PINNED_REBUILD_DESIGN_SHA256;
  if (kind === "BENCHMARK") return PINNED_BENCHMARK_SPEC_SHA256;
  if (kind === "FROZEN_CONSTANTS") return digest(frozenConstantsDeclaration());
  if (kind === "GATE_INVENTORY") return digest(gateInventoryDeclaration());
  if (kind === "COMPARATOR_MODEL_MATCH_MATRIX") return digest(comparatorDeclaration());
  return digest(absentDeclaration(kind));
};

const recordBytes = (): Uint8Array => new Uint8Array(readFileSync(RECORD_PATH));
const recordText = (): string => readFileSync(RECORD_PATH, "utf8");
const recordSha256 = (): string => createHash("sha256").update(recordText()).digest("hex");

const decodedManifest = (): ConfirmatoryFreezeManifest => {
  const decoded = decodeConfirmatoryFreezeManifest(recordBytes());
  if (!decoded.ok) throw new Error(`${decoded.code}/${decoded.message}`);
  return decoded.manifest;
};

/** Supply one clean `{rev-parse, status}` horizon pair per `captureGitHorizon` call (two per admission). */
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

describe("confirmatory corpus freeze record (task-3a34adcabd03489e84f8dfbec913633a)", () => {
  it("is the exact-key production-decoded manifest and prints its frozen identity set", () => {
    const parsed = JSON.parse(recordText()) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(MANIFEST_KEYS);
    const manifest = decodedManifest();
    expect(recordText()).toBe(canonicalizeConfirmatoryFreezeManifest(manifest));
    expect(recordSha256()).toBe(MANIFEST_SHA256);
    expect(manifest.schemaVersion).toBe(FREEZE_MANIFEST_SCHEMA_VERSION);
    expect(manifest.projectId).toBe("moe-next");
    expect(manifest.implementationSha).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.implementationSha).toBe(IMPLEMENTATION_SHA);
    expect(manifest.attestation)
      .toEqual({ status: "UNATTESTED", signerKeyId: null, publicRegistryReference: null });
    expect(manifest.campaignLabel).toContain("UNATTESTED");
    expect(manifest.campaignLabel).toContain("UNKNOWN declarations");

    const campaignId = deriveConfirmatoryFreezeCampaignId({
      schemaVersion: FREEZE_MANIFEST_SCHEMA_VERSION,
      campaignLabel: manifest.campaignLabel,
      implementationSha: manifest.implementationSha,
      designSha256: PINNED_REBUILD_DESIGN_SHA256,
      benchmarkSha256: PINNED_BENCHMARK_SPEC_SHA256,
    });
    expect(manifest.campaignId).toBe(campaignId);
    expect(manifest.manifestRegistryRef)
      .toBe(deriveConfirmatoryFreezeManifestRegistryRef(campaignId));

    // DoD 1: the frozen identity set, printed from the production-decoded value.
    const printed = [
      `implementationSha=${manifest.implementationSha}`,
      `implementationFrozenAt=${manifest.implementationFrozenAt}`,
      `sealedAt=${manifest.sealedAt}`,
      `campaignId=${manifest.campaignId}`,
      `manifestRegistryRef=${manifest.manifestRegistryRef}`,
      `attestation=${manifest.attestation.status}`,
      ...manifest.bindings.map(({ kind, sha256 }) => `${kind}=${sha256}`),
    ].join("\n");
    console.log(`FROZEN IDENTITY SET\n${printed}`);
    expect(printed).toContain(`implementationSha=${IMPLEMENTATION_SHA}`);
  });

  it("carries every binding kind in both directions with a reproducible digest each", () => {
    const manifest = decodedManifest();
    const kinds = manifest.bindings.map(({ kind }) => kind);
    expect(kinds).toEqual([...CONFIRMATORY_FREEZE_BINDING_KINDS]);
    expect([...CONFIRMATORY_FREEZE_BINDING_KINDS].filter((kind) => !kinds.includes(kind)))
      .toEqual([]);
    expect(kinds.filter((kind) => !CONFIRMATORY_FREEZE_BINDING_KINDS.includes(kind))).toEqual([]);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const { kind, sha256 } of manifest.bindings) {
      expect(sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(`${kind}=${sha256}`).toBe(`${kind}=${expectedBinding(kind)}`);
    }
  });

  it("binds the design and benchmark documents actually read from disk", () => {
    const design = readPinnedRebuildDesign();
    const benchmark = readPinnedBenchmarkSpec();
    expect(isPinnedDocument(design)).toBe(true);
    expect(isPinnedDocument(benchmark)).toBe(true);
    if (!isPinnedDocument(design) || !isPinnedDocument(benchmark)) return;
    const manifest = decodedManifest();
    const bound = (kind: string): string | undefined =>
      manifest.bindings.find((binding) => binding.kind === kind)?.sha256;
    expect(bound("DESIGN")).toBe(design.source.sha256);
    expect(bound("BENCHMARK")).toBe(benchmark.source.sha256);
    expect(design.source.sha256).toBe(PINNED_REBUILD_DESIGN_SHA256);
    expect(benchmark.source.sha256).toBe(PINNED_BENCHMARK_SPEC_SHA256);
  });

  it("commits the seven absent facts as explicit UNKNOWN declarations, not as invented digests", () => {
    const manifest = decodedManifest();
    const absentKinds = Object.keys(ABSENT_REASONS);
    expect(absentKinds).toHaveLength(7);
    for (const kind of absentKinds) {
      const declaration = absentDeclaration(kind);
      expect(declaration.status).toBe("UNKNOWN");
      expect(declaration.code).toBe(ABSENT_CODE);
      expect(declaration.layer).toBe(ABSENT_LAYER);
      expect(String(declaration.reason ?? "").length).toBeGreaterThan(0);
      expect(manifest.bindings.find((binding) => binding.kind === kind)?.sha256)
        .toBe(digest(declaration));
    }
    expect(comparatorDeclaration().modelIdSnapshotEffortTriple).toBe("UNKNOWN");
    expect(comparatorDeclaration().comparatorGateIds).toEqual([...FROZEN_COMPARATOR_GATE_IDS]);
  });

  it("marks every production gate UNKNOWN for this campaign, both directions, never PASS", () => {
    const verdicts = campaignGateVerdicts();
    const gateIds = Object.keys(verdicts);
    const production: readonly string[] = FROZEN_GATE_IDS;
    expect(gateIds).toHaveLength(production.length);
    expect(production.filter((gateId) => !(gateId in verdicts))).toEqual([]);
    expect(gateIds.filter((gateId) => !production.includes(gateId))).toEqual([]);
    expect(Object.values(verdicts).filter((verdict) => verdict !== "UNKNOWN")).toEqual([]);
    expect(Object.values(verdicts)).not.toContain("PASS");
    expect(TRIVALENT_VERDICTS).toContain("UNKNOWN");
    // The verdict table lives inside the GATE_INVENTORY binding preimage, so it cannot drift
    // away from the sealed record without the digest — and this arm — going red.
    expect(decodedManifest().bindings.find(({ kind }) => kind === "GATE_INVENTORY")?.sha256)
      .toBe(digest(gateInventoryDeclaration()));
    console.log(`CAMPAIGN GATE VERDICTS, all UNKNOWN (${gateIds.length}): ${gateIds.join(" ")}`);
  });

  it("seals strictly after the implementation freeze, at the pinned commit's own instant", () => {
    const manifest = decodedManifest();
    expect(Date.parse(manifest.sealedAt))
      .toBeGreaterThan(Date.parse(manifest.implementationFrozenAt));
    const committed = execFileSync("git", ["show", "-s", "--format=%ct", manifest.implementationSha],
      { encoding: "utf8", windowsHide: true }).trim();
    expect(committed).toMatch(/^[0-9]+$/);
    expect(Date.parse(manifest.implementationFrozenAt)).toBe(Number(committed) * 1000);
  });

  it("exposes digest commitments only — no corpus, prompt, oracle, key or path bytes", () => {
    const text = recordText();
    expect(text.length).toBeLessThan(8 * 1024);
    for (const forbidden of ["BEGIN ", "PRIVATE KEY", "signature", "signerKey:", '"ATTESTED"']) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(text).not.toMatch(/\.(md|json|txt|jsonl)\b/);
    const manifest = decodedManifest();
    expect(manifest.attestation.signerKeyId).toBeNull();
    expect(manifest.attestation.publicRegistryReference).toBeNull();
  });

  it("leaves the authority reader refusing with its exact unassigned code and layer", () => {
    const authority = readConfirmatoryFreezeAuthority();
    expect(authority.ok).toBe(false);
    if (authority.ok) throw new Error("the authority reader returned a grant");
    expect(authority).toEqual({
      ok: false, authority: "NONE",
      code: CONFIRMATORY_FREEZE_AUTHORITY_CODE, layer: CONFIRMATORY_FREEZE_AUTHORITY_LAYER,
    });
    expect(authority.code).toBe("CONFIRMATORY_FREEZE_AUTHORITY_UNASSIGNED");
    expect(authority.layer).toBe("CONFIRMATORY_FREEZE_AUTHORITY");
    expect("record" in authority).toBe(false);
  });

  it("passes a non-vacuous pre-freeze audit with zero unresolved errors", () => {
    const audit = runPreFreezeAudit();
    expect(audit.refusals).toEqual([]);
    expect(audit.ok).toBe(true);
    const { gateInventory, references, thresholds } = audit;
    if (!gateInventory || !references || !thresholds) {
      throw new Error("a pre-freeze audit sub-report is absent");
    }
    expect(gateInventory.generatedCases).toBeGreaterThan(0);
    expect(references.generatedCases).toBeGreaterThan(0);
    expect(thresholds.generatedCases).toBeGreaterThan(0);
    expect(audit.generatedCases).toBe(
      gateInventory.generatedCases + references.generatedCases + thresholds.generatedCases,
    );
    expect(audit.generatedCases).toBeGreaterThan(0);
    console.log(`PRE-FREEZE AUDIT generatedCases=${audit.generatedCases} refusals=0`);
  });

  it("is admitted by production for the frozen SHA as UNATTESTED with custody UNKNOWN", () => {
    stubHorizon(IMPLEMENTATION_SHA);
    const admission = admitConfirmatoryFreezeManifest(recordBytes());
    if (!admission.ok) throw new Error(`${admission.code}/${admission.sourceCode}`);
    expect(admission.manifest).toEqual(decodedManifest());
    expect(admission.manifestSha256).toBe(MANIFEST_SHA256);
    expect(admission.custody).toEqual({ status: "UNATTESTED", attestedCustody: "UNKNOWN" });
    expect(Object.isFrozen(admission)).toBe(true);
    expect(Object.isFrozen(admission.manifest)).toBe(true);
    expect(Object.isFrozen(admission.manifest.bindings)).toBe(true);
    expect(JSON.stringify(admission)).not.toContain('"status":"ATTESTED"');
    expect(JSON.stringify(admission)).not.toContain("signature");
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(4);
  });

  it("refuses this campaign mechanically once the repository selects another implementation SHA", () => {
    const movedHead = "f".repeat(40);
    expect(movedHead).toMatch(/^[a-f0-9]{40}$/);
    expect(movedHead).not.toBe(IMPLEMENTATION_SHA);
    const before = recordSha256();
    stubHorizon(movedHead);
    const admission = admitConfirmatoryFreezeManifest(recordBytes());
    expect(admission.ok).toBe(false);
    if (admission.ok) return;
    expect(admission.code).toBe("CONFIRMATORY_FREEZE_MANIFEST_IMPLEMENTATION_SHA_MISMATCH");
    expect(admission.layer).toBe("CONFIRMATORY_FREEZE_MANIFEST_ADMISSION");
    expect(admission.sourceCode).toBe("CONFIRMATORY_FREEZE_GIT_IMPLEMENTATION_MISMATCH");
    expect(admission.sourceLayer).toBe("CONFIRMATORY_FREEZE_GIT");
    expect(recordSha256()).toBe(before);
    expect(recordSha256()).toBe(MANIFEST_SHA256);
  });

  it("treats a different implementation SHA as a new campaign it can neither extend nor mutate", () => {
    const otherSha = "0123456789abcdef0123456789abcdef01234567";
    const frozen = decodedManifest();
    const campaignId = deriveConfirmatoryFreezeCampaignId({
      schemaVersion: FREEZE_MANIFEST_SCHEMA_VERSION,
      campaignLabel: frozen.campaignLabel,
      implementationSha: otherSha,
      designSha256: PINNED_REBUILD_DESIGN_SHA256,
      benchmarkSha256: PINNED_BENCHMARK_SPEC_SHA256,
    });
    const candidate: ConfirmatoryFreezeManifest = {
      ...frozen,
      implementationSha: otherSha,
      campaignId,
      manifestRegistryRef: deriveConfirmatoryFreezeManifestRegistryRef(campaignId),
    };
    const bytes = new TextEncoder().encode(canonicalizeConfirmatoryFreezeManifest(candidate));
    const generated = decodeConfirmatoryFreezeManifest(bytes);
    expect(generated.ok).toBe(true);
    expect(campaignId).not.toBe(frozen.campaignId);
    expect(candidate.manifestRegistryRef).not.toBe(frozen.manifestRegistryRef);

    stubHorizon(IMPLEMENTATION_SHA);
    const admission = admitConfirmatoryFreezeManifest(bytes);
    expect(admission.ok).toBe(false);
    if (admission.ok) return;
    expect(admission.code).toBe("CONFIRMATORY_FREEZE_MANIFEST_IMPLEMENTATION_SHA_MISMATCH");
    expect(admission.layer).toBe("CONFIRMATORY_FREEZE_MANIFEST_ADMISSION");
    expect(admission.sourceCode).toBe("CONFIRMATORY_FREEZE_GIT_IMPLEMENTATION_MISMATCH");
    expect(admission.sourceLayer).toBe("CONFIRMATORY_FREEZE_GIT");
    expect(recordSha256()).toBe(MANIFEST_SHA256);
  });
});

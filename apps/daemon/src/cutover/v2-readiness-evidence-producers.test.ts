import { createHash } from "node:crypto";
import { join } from "node:path";

import { GENERATED_CONTRACT_DIGEST } from "@moe/control-room-client/contract-pins";
import { deriveContractDigest } from "@moe/control-room-client/contract-digest";
import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "./v2-readiness-evidence-contract.js";
import {
  SECURITY_RECEIPTS_DIRNAME, SECURITY_REPORT_FILENAME, SECURITY_ROSTER_PATH, SECURITY_RUN_FILENAME,
  produceAcceptanceEvidence, produceContractSchema, produceSecurityEvidence,
  produceWindowsPackagingEvidence, refuseAbsentProducers,
} from "./v2-readiness-evidence-producers.js";
import type { V2EvidenceFilePorts } from "./v2-readiness-evidence-producers.js";

/**
 * Every producer here reads FILES and PROCESSES through injected ports, so each arm holds the
 * whole world in a map and varies exactly one fact. The rules under test are the producers'
 * own: nothing in a fixture re-implements canonicalisation, digesting or grading.
 */
const COMMIT = "c".repeat(40);
const OTHER_COMMIT = "d".repeat(40);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface WorldOptions {
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
  readonly gates?: Readonly<Record<string, Readonly<{ exitCode: number; output: string }>>>;
  readonly git?: Readonly<Record<string, string>>;
}

function world(options: WorldOptions = {}): V2EvidenceFilePorts & { readonly ran: string[] } {
  const files = new Map<string, Uint8Array>();
  for (const [path, body] of Object.entries(options.files ?? {})) {
    files.set(path, typeof body === "string" ? encoder.encode(body) : body);
  }
  const ran: string[] = [];
  return {
    git: (args) => {
      const answer = options.git?.[args.join(" ")];
      if (answer === undefined) throw new Error(`git ${args.join(" ")} failed`);
      return answer;
    },
    ran,
    readDirectory: (path) => {
      const prefix = `${path}/`;
      const names = [...files.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
      if (names.length === 0) throw new Error(`ENOENT ${path}`);
      return names;
    },
    readFile: (path) => {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`ENOENT ${path}`);
      return bytes;
    },
    runGate: (script) => {
      ran.push(script);
      return options.gates?.[script] ?? { exitCode: 1, output: "" };
    },
  };
}

const parse = (bytes: Uint8Array): Record<string, unknown> =>
  JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;

describe("contractSchema", () => {
  it("emits the exact canonical surface bytes, whose sha256 IS the generated pin", () => {
    const outcome = produceContractSchema({ contractDigest: GENERATED_CONTRACT_DIGEST });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.sha256).toBe(deriveContractDigest());
    expect(outcome.sha256).toBe(GENERATED_CONTRACT_DIGEST);
    expect(decoder.decode(outcome.bytes).endsWith("\n")).toBe(false);
  });

  it("refuses a stale generated client rather than pinning a surface nothing shipped", () => {
    expect(produceContractSchema({ contractDigest: "0".repeat(64) })).toMatchObject({
      code: "V2_EVIDENCE_CONTRACT_DIGEST_STALE", kind: "contractSchema", ok: false,
    });
  });
});

const RELEASE_EVIDENCE = {
  audit: { advisoryCount: 0, dependencyCount: 1, digest: "a".repeat(64) },
  operation: "RECORDED",
  os: [{ platform: "win32", status: "PASS" }, { platform: "linux", status: "UNKNOWN" }],
  publicationAuthorized: false,
  releaseVerdict: "UNKNOWN",
  source: { objectFormat: "sha1", sourceSha: COMMIT },
};
const RELEASE_PATH = "dist/release/evidence.json";
const OBSERVATION_PATH = "dist/moe-windows.zip.provenance.json";

function observationFor(evidenceText: string, overrides: Record<string, unknown> = {}): string {
  const body = {
    artifact: { byteLength: 1, name: "moe-windows.zip", sha256: "b".repeat(64) },
    releaseEvidenceDigest: sha256Hex(evidenceText),
    schemaVersion: "moe-pack-observation/1",
    sourceSha: COMMIT,
    ...overrides,
  };
  return canonicalJson({ ...body, receiptDigest: sha256Hex(canonicalJson(body)) });
}

describe("windowsPackagingEvidence", () => {
  const evidenceText = canonicalJson(RELEASE_EVIDENCE);

  it("embeds the verified release evidence and its digest, plus a bound observation receipt", () => {
    const ports = world({ files: { [OBSERVATION_PATH]: observationFor(evidenceText), [RELEASE_PATH]: evidenceText } });
    const outcome = produceWindowsPackagingEvidence(ports,
      { observationPath: OBSERVATION_PATH, releaseEvidencePath: RELEASE_PATH }, COMMIT);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const record = parse(outcome.bytes);
    expect(record).toMatchObject({
      releaseEvidence: RELEASE_EVIDENCE, releaseEvidenceSha256: sha256Hex(evidenceText),
      schemaVersion: "moe-windows-packaging-evidence/1", sourceCommit: COMMIT,
    });
    expect(record["observation"]).toMatchObject({ sourceSha: COMMIT });
    // Canonical bytes: the file is exactly its own canonical re-serialisation.
    expect(decoder.decode(outcome.bytes)).toBe(canonicalJson(record));
  });

  it("refuses evidence sealed for another commit", () => {
    const foreign = canonicalJson({ ...RELEASE_EVIDENCE, source: { objectFormat: "sha1", sourceSha: OTHER_COMMIT } });
    expect(produceWindowsPackagingEvidence(world({ files: { [RELEASE_PATH]: foreign } }),
      { releaseEvidencePath: RELEASE_PATH }, COMMIT))
      .toMatchObject({ code: "V2_EVIDENCE_SOURCE_COMMIT_MISMATCH", ok: false });
  });

  it("refuses re-serialised (non-canonical) evidence, whose digest is not the sealed one", () => {
    const pretty = JSON.stringify(RELEASE_EVIDENCE, null, 2);
    expect(produceWindowsPackagingEvidence(world({ files: { [RELEASE_PATH]: pretty } }),
      { releaseEvidencePath: RELEASE_PATH }, COMMIT))
      .toMatchObject({ code: "V2_EVIDENCE_INPUT_UNREADABLE", ok: false });
  });

  it("refuses a published or non-RECORDED record, and an observation that binds other bytes", () => {
    const published = canonicalJson({ ...RELEASE_EVIDENCE, publicationAuthorized: true });
    expect(produceWindowsPackagingEvidence(world({ files: { [RELEASE_PATH]: published } }),
      { releaseEvidencePath: RELEASE_PATH }, COMMIT))
      .toMatchObject({ code: "V2_EVIDENCE_INPUT_INVALID", ok: false });
    const foreignObservation = observationFor(evidenceText, { releaseEvidenceDigest: "e".repeat(64) });
    expect(produceWindowsPackagingEvidence(
      world({ files: { [OBSERVATION_PATH]: foreignObservation, [RELEASE_PATH]: evidenceText } }),
      { observationPath: OBSERVATION_PATH, releaseEvidencePath: RELEASE_PATH }, COMMIT))
      .toMatchObject({ code: "V2_EVIDENCE_INPUT_INVALID", ok: false });
  });
});

const OUT = "security-out";
const ROOT = "checkout";
const RUN_ID = "run-1";
const ROSTER_SOURCE = [
  '  { constant: "ALPHA_LAYER", file: "apps/daemon/src/a.ts", axis: "transport" },',
  '  { constant: "BETA_LAYER", file: "apps/daemon/src/b.ts", axis: "integrity" },',
].join("\n");
const REPORT = { numFailedTests: 0, numPassedTests: 9, numTotalTestSuites: 2, numTotalTests: 9, success: true };

function receipt(sliceFile: string, boundary: string, runId = RUN_ID): string {
  return JSON.stringify({
    entries: ["AFTER", "BEFORE", "RACE"].map((arm) => ({ arm, boundary, caseId: `${boundary}-${arm}` })),
    runId, sliceFile,
  });
}

function securityFiles(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    [join(OUT, SECURITY_RECEIPTS_DIRNAME, "a.security.ts.json").replaceAll("\\", "/")]: receipt("a.security.ts", "ALPHA_LAYER"),
    [join(OUT, SECURITY_RECEIPTS_DIRNAME, "b.security.ts.json").replaceAll("\\", "/")]: receipt("b.security.ts", "BETA_LAYER"),
    [join(OUT, SECURITY_REPORT_FILENAME).replaceAll("\\", "/")]: JSON.stringify(REPORT),
    [join(OUT, SECURITY_RUN_FILENAME).replaceAll("\\", "/")]: JSON.stringify({ runId: RUN_ID }),
    [join(ROOT, SECURITY_ROSTER_PATH).replaceAll("\\", "/")]: ROSTER_SOURCE,
    ...overrides,
  };
}

/** The producer joins with the platform separator; the map is keyed with forward slashes. */
function slashPorts(files: Record<string, string>): V2EvidenceFilePorts {
  const base = world({ files });
  return {
    ...base,
    readDirectory: (path) => base.readDirectory(path.replaceAll("\\", "/")),
    readFile: (path) => base.readFile(path.replaceAll("\\", "/")),
  };
}

describe("securityEvidence", () => {
  it("binds the run's receipts, the green report and the roster digest into one record", () => {
    const outcome = produceSecurityEvidence(slashPorts(securityFiles()), { securityOut: OUT, sourceRoot: ROOT }, COMMIT);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const record = parse(outcome.bytes);
    expect(record).toMatchObject({
      report: REPORT, rosterRowCount: 2, rosterSha256: sha256Hex(ROSTER_SOURCE),
      schemaVersion: "moe-security-evidence/1", securityRunId: RUN_ID, sourceCommit: COMMIT,
    });
    expect((record["executedPairs"] as unknown[]).length).toBe(6);
    expect((record["sliceReceipts"] as { sliceFile: string }[]).map((slice) => slice.sliceFile))
      .toEqual(["a.security.ts", "b.security.ts"]);
  });

  it("refuses a receipt from another run, a red report, and a boundary off the roster", () => {
    const input = { securityOut: OUT, sourceRoot: ROOT };
    const foreignRun = securityFiles({
      [join(OUT, SECURITY_RECEIPTS_DIRNAME, "b.security.ts.json").replaceAll("\\", "/")]: receipt("b.security.ts", "BETA_LAYER", "run-2"),
    });
    expect(produceSecurityEvidence(slashPorts(foreignRun), input, COMMIT))
      .toMatchObject({ code: "V2_EVIDENCE_INPUT_INVALID", ok: false });
    const red = securityFiles({
      [join(OUT, SECURITY_REPORT_FILENAME).replaceAll("\\", "/")]: JSON.stringify({ ...REPORT, numFailedTests: 1, success: false }),
    });
    expect(produceSecurityEvidence(slashPorts(red), input, COMMIT))
      .toMatchObject({ code: "V2_EVIDENCE_GATE_RED", ok: false });
    const offRoster = securityFiles({
      [join(OUT, SECURITY_RECEIPTS_DIRNAME, "b.security.ts.json").replaceAll("\\", "/")]: receipt("b.security.ts", "GAMMA_LAYER"),
    });
    expect(produceSecurityEvidence(slashPorts(offRoster), input, COMMIT))
      .toMatchObject({ code: "V2_EVIDENCE_INPUT_INVALID", ok: false });
    expect(produceSecurityEvidence(slashPorts({}), input, COMMIT))
      .toMatchObject({ code: "V2_EVIDENCE_INPUT_UNREADABLE", ok: false });
  });
});

const CLEAN_GIT = { "rev-parse HEAD^{commit}": COMMIT, "status --porcelain=v2 --untracked-files=all": "" };
const GREEN_GATES = {
  "test:e2e": { exitCode: 0, output: "\n Test Files  3 passed (3)\n      Tests  12 passed (12)\n" },
  "test:e2e:browser": { exitCode: 0, output: "Running 2 tests\n  2 passed (30.1s)\n" },
};

describe("acceptanceEvidence", () => {
  it("runs both e2e legs at the commit on a clean tree and grades PASS with the benchmark resolver", () => {
    const ports = world({ gates: GREEN_GATES, git: CLEAN_GIT });
    const outcome = produceAcceptanceEvidence(ports, { sourceRoot: ROOT }, COMMIT);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(ports.ran).toEqual(["test:e2e", "test:e2e:browser"]);
    const record = parse(outcome.bytes);
    expect(record).toMatchObject({
      familyVerdict: { familyId: "e2e", verdict: "PASS" },
      gates: [
        { command: "test:e2e", countLine: "      Tests  12 passed (12)", exitCode: 0,
          outputSha256: createHash("sha256").update(GREEN_GATES["test:e2e"].output).digest("hex") },
        { command: "test:e2e:browser", countLine: "  2 passed (30.1s)", exitCode: 0 },
      ],
      schemaVersion: "moe-acceptance-evidence/1", sourceCommit: COMMIT, treeClean: true,
    });
  });

  it("refuses before running anything when HEAD is another commit or the tree is dirty", () => {
    const wrongHead = world({ gates: GREEN_GATES, git: { ...CLEAN_GIT, "rev-parse HEAD^{commit}": OTHER_COMMIT } });
    expect(produceAcceptanceEvidence(wrongHead, { sourceRoot: ROOT }, COMMIT))
      .toMatchObject({ code: "V2_EVIDENCE_SOURCE_COMMIT_MISMATCH", ok: false });
    const dirty = world({ gates: GREEN_GATES, git: { ...CLEAN_GIT, "status --porcelain=v2 --untracked-files=all": "1 .M N... 100644 100644 100644 0 0 a.ts" } });
    expect(produceAcceptanceEvidence(dirty, { sourceRoot: ROOT }, COMMIT))
      .toMatchObject({ code: "V2_EVIDENCE_INPUT_INVALID", ok: false });
    expect(wrongHead.ran).toEqual([]);
    expect(dirty.ran).toEqual([]);
  });

  it("refuses a red leg, an exit-0 leg with no count line, and a red browser leg", () => {
    const redVitest = world({ gates: { ...GREEN_GATES, "test:e2e": { exitCode: 1, output: "Tests  1 failed | 11 passed (12)" } }, git: CLEAN_GIT });
    expect(produceAcceptanceEvidence(redVitest, { sourceRoot: ROOT }, COMMIT))
      .toMatchObject({ code: "V2_EVIDENCE_GATE_RED", ok: false });
    const silent = world({ gates: { ...GREEN_GATES, "test:e2e": { exitCode: 0, output: "No test files found" } }, git: CLEAN_GIT });
    expect(produceAcceptanceEvidence(silent, { sourceRoot: ROOT }, COMMIT))
      .toMatchObject({ code: "V2_EVIDENCE_GATE_RED", ok: false });
    const redBrowser = world({ gates: { ...GREEN_GATES, "test:e2e:browser": { exitCode: 1, output: "  1 failed\n  1 passed (30s)\n" } }, git: CLEAN_GIT });
    expect(produceAcceptanceEvidence(redBrowser, { sourceRoot: ROOT }, COMMIT))
      .toMatchObject({ code: "V2_EVIDENCE_GATE_RED", ok: false });
  });
});

describe("the kinds with no producer", () => {
  it("are refused BY NAME, never filled", () => {
    expect(refuseAbsentProducers().map((outcome) => ({ code: outcome.ok ? "PRODUCED" : outcome.code, kind: outcome.kind })))
      .toEqual([
        { code: "V2_EVIDENCE_PRODUCER_ABSENT", kind: "restoreDrill" },
        { code: "V2_EVIDENCE_PRODUCER_ABSENT", kind: "deliveryProfileQualificationEvidence" },
      ]);
  });
});

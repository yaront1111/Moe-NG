import { join } from "node:path";

import { resolveAll } from "@moe/benchmark";
import type { GateFamilyEvidence } from "@moe/benchmark";
import { canonicalContractSurface } from "@moe/control-room-client/contract-digest";

import {
  canonicalJson, isRecord, parseJsonObject, producedBytes, producedRecord, refusedEvidence,
  sha256Hex,
} from "./v2-readiness-evidence-contract.js";
import type { V2EvidenceOutcome } from "./v2-readiness-evidence-contract.js";

/**
 * The producers whose inputs are FILES and PROCESSES: the runtime contract surface, the
 * Windows packaging evidence the release pipeline already publishes, the security lane's
 * persisted receipts, and the acceptance lanes run at the release commit. Every one of
 * them re-derives or re-checks what it embeds; none copies a claim it did not verify.
 * The store-backed producers live in v2-readiness-evidence-store-producers.ts.
 */

export interface V2EvidenceFilePorts {
  /** Throws when the path cannot be read; the producer names the path in its refusal. */
  readonly readFile: (path: string) => Uint8Array;
  readonly readDirectory: (path: string) => readonly string[];
  /** Trimmed stdout of one git invocation under `cwd`; throws on a non-zero exit. */
  readonly git: (args: readonly string[], cwd: string) => string;
  /** Runs one package.json script under `cwd` and captures its exit code and combined output. */
  readonly runGate: (script: string, cwd: string) => Readonly<{ exitCode: number; output: string }>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---- contractSchema -------------------------------------------------------------------

/**
 * The exact UTF-8 bytes of `canonicalContractSurface()`, so the file's sha256 IS
 * `deriveContractDigest()` and therefore equals the generated client's pin and every
 * distribution manifest's `contractSchemaHash` — one hashing rule, three committed copies.
 * A surface whose digest is not the pin means the generated client is stale: refused.
 */
export function produceContractSchema(pins: Readonly<{ contractDigest: string }>): V2EvidenceOutcome {
  const bytes = encoder.encode(canonicalContractSurface());
  const digest = sha256Hex(bytes);
  if (digest !== pins.contractDigest) {
    return refusedEvidence("contractSchema", "V2_EVIDENCE_CONTRACT_DIGEST_STALE",
      `surface ${digest} != generated pin ${pins.contractDigest}`);
  }
  return producedBytes("contractSchema", bytes);
}

// ---- windowsPackagingEvidence ---------------------------------------------------------

export interface WindowsPackagingInput {
  /** `scripts/release/supply-chain.mjs` output: `dist/release/<sha>/<digest>/evidence.json`. */
  readonly releaseEvidencePath: string;
  /** `scripts/release/windows-pack-observation.mjs` receipt: `moe-windows.zip.provenance.json`. */
  readonly observationPath?: string | undefined;
}

const WINDOWS_PACK_OBSERVATION_SCHEMA_VERSION = "moe-pack-observation/1";

function readCanonicalJson(
  ports: V2EvidenceFilePorts, path: string,
): Readonly<{ bytes: Uint8Array; record: Readonly<Record<string, unknown>> }> | string {
  let bytes: Uint8Array;
  try {
    bytes = ports.readFile(path);
  } catch {
    return `unreadable: ${path}`;
  }
  const record = parseJsonObject(bytes);
  if (record === null) return `not a JSON object: ${path}`;
  // Canonical BYTES, not merely parseable: a re-serialized copy carries a different digest
  // from the one the release pipeline sealed, and this file must name that sealed one.
  if (canonicalJson(record) !== decoder.decode(bytes)) return `not canonical JSON: ${path}`;
  return { bytes, record };
}

export function produceWindowsPackagingEvidence(
  ports: V2EvidenceFilePorts, input: WindowsPackagingInput, sourceCommit: string,
): V2EvidenceOutcome {
  const kind = "windowsPackagingEvidence";
  const evidence = readCanonicalJson(ports, input.releaseEvidencePath);
  if (typeof evidence === "string") return refusedEvidence(kind, "V2_EVIDENCE_INPUT_UNREADABLE", evidence);
  const source = evidence.record["source"];
  if (!isRecord(source) || source["sourceSha"] !== sourceCommit) {
    return refusedEvidence(kind, "V2_EVIDENCE_SOURCE_COMMIT_MISMATCH",
      `release evidence names ${String(isRecord(source) ? source["sourceSha"] : "no source")}`);
  }
  const os = evidence.record["os"];
  const windowsPassed = Array.isArray(os) && os.some((entry) =>
    isRecord(entry) && entry["platform"] === "win32" && entry["status"] === "PASS");
  if (evidence.record["operation"] !== "RECORDED" || evidence.record["publicationAuthorized"] !== false
    || evidence.record["releaseVerdict"] !== "UNKNOWN" || !windowsPassed) {
    return refusedEvidence(kind, "V2_EVIDENCE_INPUT_INVALID",
      "release evidence is not a RECORDED, unpublished, UNKNOWN-verdict record with a win32 PASS");
  }
  const releaseEvidenceSha256 = sha256Hex(evidence.bytes);

  let observation: Readonly<Record<string, unknown>> | null = null;
  let observationSha256: string | null = null;
  if (input.observationPath !== undefined) {
    const receipt = readCanonicalJson(ports, input.observationPath);
    if (typeof receipt === "string") return refusedEvidence(kind, "V2_EVIDENCE_INPUT_UNREADABLE", receipt);
    const { receiptDigest, ...body } = receipt.record;
    const resealed = sha256Hex(canonicalJson(body));
    if (receipt.record["schemaVersion"] !== WINDOWS_PACK_OBSERVATION_SCHEMA_VERSION
      || receipt.record["sourceSha"] !== sourceCommit
      || receipt.record["releaseEvidenceDigest"] !== releaseEvidenceSha256
      || receiptDigest !== resealed) {
      return refusedEvidence(kind, "V2_EVIDENCE_INPUT_INVALID",
        "observation receipt does not bind this commit and this release evidence under its own digest");
    }
    observation = receipt.record;
    observationSha256 = sha256Hex(receipt.bytes);
  }
  return producedRecord(kind, {
    observation, observationSha256, releaseEvidence: evidence.record, releaseEvidenceSha256,
    schemaVersion: "moe-windows-packaging-evidence/1", sourceCommit,
  });
}

// ---- securityEvidence -----------------------------------------------------------------

export interface SecurityEvidenceInput {
  /** The directory `MOE_SECURITY_EVIDENCE_OUT` named for the lane run (see lane-global-setup). */
  readonly securityOut: string;
  /** The checkout the lane ran in; its roster is the coverage denominator. */
  readonly sourceRoot: string;
}

export const SECURITY_RUN_FILENAME = "security-run.json";
export const SECURITY_RECEIPTS_DIRNAME = "receipts";
export const SECURITY_REPORT_FILENAME = "vitest-security.json";
export const SECURITY_ROSTER_PATH = "tests/security/boundary-roster.security.ts";
const ROSTER_ROW =
  /\{\s*constant:\s*"([A-Za-z0-9_]+)",\s*file:\s*"([^"]+)",\s*axis:\s*"([a-z-]+)"\s*\}/gu;
const ARMS: readonly string[] = Object.freeze(["AFTER", "BEFORE", "RACE"]);

interface SliceReceipt {
  readonly entries: readonly Readonly<{ arm: string; boundary: string; caseId: string }>[];
  readonly runId: string;
  readonly sliceFile: string;
}

function readReceipt(record: Readonly<Record<string, unknown>>): SliceReceipt | null {
  const entries = record["entries"];
  if (typeof record["runId"] !== "string" || typeof record["sliceFile"] !== "string"
    || !Array.isArray(entries)) return null;
  const admitted: Readonly<{ arm: string; boundary: string; caseId: string }>[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry["arm"] !== "string" || !ARMS.includes(entry["arm"])
      || typeof entry["boundary"] !== "string" || typeof entry["caseId"] !== "string"
      || entry["caseId"].length === 0) return null;
    admitted.push({ arm: entry["arm"], boundary: entry["boundary"], caseId: entry["caseId"] });
  }
  return { entries: admitted, runId: record["runId"], sliceFile: record["sliceFile"] };
}

export function produceSecurityEvidence(
  ports: V2EvidenceFilePorts, input: SecurityEvidenceInput, sourceCommit: string,
): V2EvidenceOutcome {
  const kind = "securityEvidence";
  const read = (path: string): Readonly<Record<string, unknown>> | string => {
    try {
      return parseJsonObject(ports.readFile(path)) ?? `not a JSON object: ${path}`;
    } catch {
      return `unreadable: ${path}`;
    }
  };
  const run = read(join(input.securityOut, SECURITY_RUN_FILENAME));
  if (typeof run === "string") return refusedEvidence(kind, "V2_EVIDENCE_INPUT_UNREADABLE", run);
  const runId = run["runId"];
  if (typeof runId !== "string" || runId.length === 0) {
    return refusedEvidence(kind, "V2_EVIDENCE_INPUT_INVALID", "security-run.json names no runId");
  }

  const receiptsDirectory = join(input.securityOut, SECURITY_RECEIPTS_DIRNAME);
  let names: readonly string[];
  try {
    names = [...ports.readDirectory(receiptsDirectory)].filter((name) => name.endsWith(".json")).sort();
  } catch {
    return refusedEvidence(kind, "V2_EVIDENCE_INPUT_UNREADABLE", `unreadable: ${receiptsDirectory}`);
  }
  if (names.length === 0) {
    return refusedEvidence(kind, "V2_EVIDENCE_INPUT_INVALID", "the lane wrote no slice receipts");
  }
  const receipts: SliceReceipt[] = [];
  for (const name of names) {
    const record = read(join(receiptsDirectory, name));
    if (typeof record === "string") return refusedEvidence(kind, "V2_EVIDENCE_INPUT_UNREADABLE", record);
    const receipt = readReceipt(record);
    if (receipt === null) return refusedEvidence(kind, "V2_EVIDENCE_INPUT_INVALID", `malformed receipt ${name}`);
    if (receipt.runId !== runId) {
      return refusedEvidence(kind, "V2_EVIDENCE_INPUT_INVALID",
        `${receipt.sliceFile} belongs to run ${receipt.runId}, not ${runId}`);
    }
    receipts.push(receipt);
  }

  const reportPath = join(input.securityOut, SECURITY_REPORT_FILENAME);
  let reportBytes: Uint8Array;
  try {
    reportBytes = ports.readFile(reportPath);
  } catch {
    return refusedEvidence(kind, "V2_EVIDENCE_INPUT_UNREADABLE", `unreadable: ${reportPath}`);
  }
  const report = parseJsonObject(reportBytes);
  const counts = ["numTotalTestSuites", "numPassedTests", "numFailedTests", "numTotalTests"] as const;
  if (report === null || typeof report["success"] !== "boolean"
    || counts.some((key) => typeof report[key] !== "number")) {
    return refusedEvidence(kind, "V2_EVIDENCE_INPUT_INVALID", "vitest JSON report is malformed");
  }
  if (report["success"] !== true || report["numFailedTests"] !== 0
    || (report["numTotalTests"] as number) <= 0) {
    return refusedEvidence(kind, "V2_EVIDENCE_GATE_RED",
      `security lane: success=${String(report["success"])} failed=${String(report["numFailedTests"])}`);
  }

  const rosterPath = join(input.sourceRoot, SECURITY_ROSTER_PATH);
  let rosterBytes: Uint8Array;
  try {
    rosterBytes = ports.readFile(rosterPath);
  } catch {
    return refusedEvidence(kind, "V2_EVIDENCE_INPUT_UNREADABLE", `unreadable: ${rosterPath}`);
  }
  const roster = new Set([...decoder.decode(rosterBytes).matchAll(ROSTER_ROW)].map((match) => match[1] ?? ""));
  if (roster.size === 0) {
    return refusedEvidence(kind, "V2_EVIDENCE_INPUT_INVALID", "the boundary roster parsed to zero rows");
  }
  const pairs = new Map<string, Readonly<{ arm: string; boundary: string }>>();
  for (const receipt of receipts) {
    for (const entry of receipt.entries) {
      if (!roster.has(entry.boundary)) {
        return refusedEvidence(kind, "V2_EVIDENCE_INPUT_INVALID",
          `${receipt.sliceFile} claims ${entry.boundary}, which is not on the roster`);
      }
      pairs.set(`${entry.boundary}#${entry.arm}`, { arm: entry.arm, boundary: entry.boundary });
    }
  }
  const executedPairs = [...pairs.values()].sort((left, right) =>
    left.boundary.localeCompare(right.boundary, "en") || left.arm.localeCompare(right.arm, "en"));
  return producedRecord(kind, {
    executedPairs,
    report: Object.fromEntries([...counts, "success"].map((key) => [key, report[key]])),
    reportSha256: sha256Hex(reportBytes),
    rosterRowCount: roster.size,
    rosterSha256: sha256Hex(rosterBytes),
    schemaVersion: "moe-security-evidence/1",
    securityRunId: runId,
    sliceReceipts: [...receipts].sort((left, right) => left.sliceFile.localeCompare(right.sliceFile, "en")),
    sourceCommit,
  });
}

// ---- acceptanceEvidence ---------------------------------------------------------------

/** The two e2e legs of the benchmark's `e2e` gate family, run in this order. */
export const ACCEPTANCE_GATE_SCRIPTS = Object.freeze(["test:e2e", "test:e2e:browser"] as const);
const VITEST_COUNT_LINE = /^\s*(?:Test Files|Tests)\s+[1-9]\d*\s+passed\b.*$/mu;
const PLAYWRIGHT_COUNT_LINE = /^\s*[1-9]\d*\s+passed\b.*$/mu;

function lastMatch(output: string, pattern: RegExp): string | null {
  const matches = [...output.matchAll(new RegExp(pattern.source, "gmu"))];
  const last = matches.at(-1)?.[0];
  return last === undefined ? null : last.trimEnd();
}

/**
 * Runs the acceptance lanes AT THE NAMED COMMIT, on a clean tree, and grades them with the
 * benchmark's own gate-family resolver. Nothing is graded from a log somebody else wrote:
 * the exit code and the count line come from the child process this producer started.
 */
export function produceAcceptanceEvidence(
  ports: V2EvidenceFilePorts, input: Readonly<{ sourceRoot: string }>, sourceCommit: string,
): V2EvidenceOutcome {
  const kind = "acceptanceEvidence";
  let head: string;
  let status: string;
  try {
    head = ports.git(["rev-parse", "HEAD^{commit}"], input.sourceRoot);
    status = ports.git(["status", "--porcelain=v2", "--untracked-files=all"], input.sourceRoot);
  } catch (error) {
    return refusedEvidence(kind, "V2_EVIDENCE_INPUT_UNREADABLE",
      `git under ${input.sourceRoot}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (head !== sourceCommit) {
    return refusedEvidence(kind, "V2_EVIDENCE_SOURCE_COMMIT_MISMATCH", `HEAD is ${head}`);
  }
  if (status !== "") {
    return refusedEvidence(kind, "V2_EVIDENCE_INPUT_INVALID", "the working tree is not clean");
  }
  const gates = ACCEPTANCE_GATE_SCRIPTS.map((script) => {
    const run = ports.runGate(script, input.sourceRoot);
    const countLine = lastMatch(run.output, script === "test:e2e" ? VITEST_COUNT_LINE : PLAYWRIGHT_COUNT_LINE);
    return { command: script, countLine, exitCode: run.exitCode, outputSha256: sha256Hex(run.output) };
  });
  const vitestLeg = gates[0];
  const browserLeg = gates[1];
  if (vitestLeg === undefined || browserLeg === undefined) throw new Error("unreachable: two legs");
  const evidence: GateFamilyEvidence = {
    countLine: vitestLeg.countLine,
    exitCode: Math.max(vitestLeg.exitCode, browserLeg.exitCode),
    familyId: "e2e",
  };
  const table = resolveAll([evidence]);
  if (!table.ok) return refusedEvidence(kind, "V2_EVIDENCE_GATE_RED", table.code, table);
  const verdict = table.verdicts.find((row) => row.familyId === "e2e");
  if (verdict?.verdict !== "PASS" || browserLeg.exitCode !== 0 || browserLeg.countLine === null) {
    return refusedEvidence(kind, "V2_EVIDENCE_GATE_RED",
      `e2e ${verdict?.verdict ?? "UNRESOLVED"}; ${gates.map((gate) => `${gate.command}=${String(gate.exitCode)}`).join(" ")}`);
  }
  return producedRecord(kind, {
    familyVerdict: { familyId: verdict.familyId, verdict: verdict.verdict },
    gates,
    schemaVersion: "moe-acceptance-evidence/1",
    sourceCommit,
    treeClean: true,
  });
}

// ---- the two kinds with no producer in this tree --------------------------------------

/**
 * Refused BY NAME rather than filled. A restore drill needs a backup generation produced by
 * a production path and anchored keys to verify it against; a delivery-profile
 * qualification needs a durably committed qualification with operator, builder and
 * verifier attestations. Neither writer is wired into any production path at this commit
 * (see docs/release-provenance.md), so the honest answer is that the evidence does not
 * exist, which the readiness writer then reports as the missing file it is.
 */
export function refuseAbsentProducers(): readonly V2EvidenceOutcome[] {
  return Object.freeze([
    refusedEvidence("restoreDrill", "V2_EVIDENCE_PRODUCER_ABSENT",
      "no production path publishes a backup generation to rehearse a restore against"),
    refusedEvidence("deliveryProfileQualificationEvidence", "V2_EVIDENCE_PRODUCER_ABSENT",
      "no production path commits a delivery-profile qualification or its attestations"),
  ]);
}

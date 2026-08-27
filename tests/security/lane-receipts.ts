import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

declare module "vitest" {
  export interface ProvidedContext {
    securityReceiptsDir: string;
    securityRunId: string;
  }
}

export const SECURITY_COVERAGE_DIAGNOSTICS = Object.freeze([
  "SECURITY_COVERAGE_UNEXECUTED_REGISTRATION",
  "SECURITY_COVERAGE_DUPLICATE_SLICE_RECEIPT",
  "SECURITY_COVERAGE_DUPLICATE_BOUNDARY_CLAIM",
  "SECURITY_COVERAGE_FOREIGN_BOUNDARY",
  "SECURITY_COVERAGE_FOREIGN_RUN",
  "SECURITY_COVERAGE_MISSING_SLICE_RECEIPT",
  "SECURITY_COVERAGE_MISSING_ARM",
] as const);

export type CoverageDiagnosticCode = (typeof SECURITY_COVERAGE_DIAGNOSTICS)[number];
export type CoverageArm = "AFTER" | "BEFORE" | "RACE";

export interface ReceiptEntry {
  readonly arm: CoverageArm;
  readonly boundary: string;
  readonly caseId: string;
}

export interface SliceReceipt {
  entries: ReceiptEntry[];
  readonly runId: string;
  readonly sliceFile: string;
}

export interface ExecutedCoveragePair {
  readonly arm: CoverageArm;
  readonly boundary: string;
}

export class CoverageDiagnostic extends Error {
  constructor(
    readonly code: CoverageDiagnosticCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "CoverageDiagnostic";
  }
}

const ARMS = ["AFTER", "BEFORE", "RACE"] as const;

function diagnostic(code: CoverageDiagnosticCode, detail: string): CoverageDiagnostic {
  return new CoverageDiagnostic(code, detail);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isAlreadyExists(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "EEXIST" || error.code === "EPERM";
}

function receiptPath(directory: string, sliceFile: string): string {
  return join(directory, `${sliceFile}.json`);
}

export function writeSliceReceipt(directory: string, receipt: SliceReceipt): void {
  const unexecuted = receipt.entries.find(({ caseId }) => caseId.length === 0);
  if (unexecuted !== undefined) {
    throw diagnostic("SECURITY_COVERAGE_UNEXECUTED_REGISTRATION", unexecuted.boundary);
  }
  const destination = receiptPath(directory, receipt.sliceFile);
  const temporary = `${destination}.tmp`;
  if (existsSync(destination)) {
    throw diagnostic("SECURITY_COVERAGE_DUPLICATE_SLICE_RECEIPT", receipt.sliceFile);
  }
  let ownsTemporary = false;
  try {
    writeFileSync(temporary, JSON.stringify(receipt), { encoding: "utf8", flag: "wx" });
    ownsTemporary = true;
    if (existsSync(destination)) {
      throw diagnostic("SECURITY_COVERAGE_DUPLICATE_SLICE_RECEIPT", receipt.sliceFile);
    }
    renameSync(temporary, destination);
    ownsTemporary = false;
  } catch (error: unknown) {
    if (ownsTemporary) rmSync(temporary, { force: true });
    if (error instanceof CoverageDiagnostic) throw error;
    if (isAlreadyExists(error) || existsSync(destination)) {
      throw diagnostic("SECURITY_COVERAGE_DUPLICATE_SLICE_RECEIPT", receipt.sliceFile);
    }
    throw error;
  }
}

function isReceipt(value: unknown): value is SliceReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  return typeof candidate["runId"] === "string"
    && typeof candidate["sliceFile"] === "string"
    && Array.isArray(candidate["entries"]);
}

export function readSliceReceipts(directory: string, runId: string): readonly SliceReceipt[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort(compareText)
    .map((name) => {
      const parsed: unknown = JSON.parse(readFileSync(join(directory, name), "utf8"));
      if (!isReceipt(parsed)) throw new Error(`invalid security slice receipt: ${name}`);
      if (parsed.runId !== runId) {
        throw diagnostic(
          "SECURITY_COVERAGE_FOREIGN_RUN",
          `${parsed.sliceFile}: expected ${runId}, observed ${parsed.runId}`,
        );
      }
      return parsed;
    });
}

export interface CoverageResolution {
  readonly diagnostics: readonly CoverageDiagnostic[];
  readonly pairs: readonly ExecutedCoveragePair[];
}

export function resolveExecutedCoverage(input: Readonly<{
  receipts: readonly SliceReceipt[];
  roster: readonly string[];
  sliceFiles: readonly string[];
}>): CoverageResolution {
  const diagnostics: CoverageDiagnostic[] = [];
  const roster = new Set(input.roster);
  const receiptSlices = new Set(input.receipts.map(({ sliceFile }) => sliceFile));
  for (const sliceFile of input.sliceFiles.filter((name) => !receiptSlices.has(name)).sort(compareText)) {
    diagnostics.push(diagnostic("SECURITY_COVERAGE_MISSING_SLICE_RECEIPT", sliceFile));
  }

  const slicesByBoundary = new Map<string, Set<string>>();
  const armsByBoundary = new Map<string, Set<CoverageArm>>();
  const pairs = new Map<string, ExecutedCoveragePair>();
  for (const receipt of input.receipts) {
    for (const entry of receipt.entries) {
      const slices = slicesByBoundary.get(entry.boundary) ?? new Set<string>();
      slices.add(receipt.sliceFile);
      slicesByBoundary.set(entry.boundary, slices);
      const arms = armsByBoundary.get(entry.boundary) ?? new Set<CoverageArm>();
      arms.add(entry.arm);
      armsByBoundary.set(entry.boundary, arms);
      pairs.set(`${entry.boundary}#${entry.arm}`, { arm: entry.arm, boundary: entry.boundary });
    }
  }

  for (const boundary of [...slicesByBoundary.keys()].sort(compareText)) {
    if (!roster.has(boundary)) {
      diagnostics.push(diagnostic("SECURITY_COVERAGE_FOREIGN_BOUNDARY", boundary));
    }
    const slices = [...(slicesByBoundary.get(boundary) ?? [])].sort(compareText);
    if (slices.length > 1) {
      diagnostics.push(diagnostic(
        "SECURITY_COVERAGE_DUPLICATE_BOUNDARY_CLAIM",
        `${boundary}: ${slices.join(", ")}`,
      ));
    }
  }

  for (const boundary of [...roster].sort(compareText)) {
    const arms = armsByBoundary.get(boundary) ?? new Set<CoverageArm>();
    for (const arm of ARMS) {
      if (!arms.has(arm)) diagnostics.push(diagnostic("SECURITY_COVERAGE_MISSING_ARM", `${boundary}#${arm}`));
    }
  }

  const executedPairs = [...pairs.values()].sort((left, right) =>
    compareText(left.boundary, right.boundary) || compareText(left.arm, right.arm));
  return {
    diagnostics,
    pairs: diagnostics.length === 0 ? executedPairs : [],
  };
}

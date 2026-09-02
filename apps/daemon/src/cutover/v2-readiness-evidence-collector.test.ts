import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { DIGEST, recordOf, seedImport } from "../projections/import-shadow-test-fixtures.js";
import { runRestoreQuiesce } from "../recovery/restore-controller.js";
import {
  PROJECT_ID, anchoredIncarnation, cleanupRestoreHarnesses, restoreHarness, restoreRequest,
} from "../recovery/restore-test-harness.js";
import { writeLiveQuiesceEvidence } from "./cutover-activate-test-fixtures.js";
import { canonicalJson, sha256Hex } from "./v2-readiness-evidence-contract.js";
import { collectV2ReadinessEvidence, createSystemEvidencePorts }
  from "./v2-readiness-evidence-collector.js";
import type { V2ReadinessEvidencePorts } from "./v2-readiness-evidence-collector.js";
import {
  SECURITY_RECEIPTS_DIRNAME, SECURITY_REPORT_FILENAME, SECURITY_ROSTER_PATH, SECURITY_RUN_FILENAME,
} from "./v2-readiness-evidence-producers.js";
import { V2_READINESS_EVIDENCE_FILENAMES, V2_READINESS_EVIDENCE_KINDS }
  from "./v2-readiness-manifest-writer.js";

/**
 * The whole collector over REAL files and a REAL restored store, with only the two process
 * ports (git, the gate runner) answered by the test: the acceptance lanes are not run here.
 * The expected receipt is the honest one for this commit — six kinds produced, two refused
 * by name — and every produced file's bytes hash to what the receipt says.
 */
const COMMIT = "f".repeat(40);
const directories: string[] = [];
afterAll(() => {
  cleanupRestoreHarnesses();
  for (const directory of directories) rmSync(directory, { force: true, recursive: true });
});

function scratch(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `moe-evidence-collector-${label}-`));
  directories.push(directory);
  return directory;
}

interface World {
  readonly evidenceRoot: string;
  readonly ports: V2ReadinessEvidencePorts;
  readonly securityOut: string;
  readonly sourceRoot: string;
  readonly storePath: string;
  readonly storeRoot: string;
  readonly windowsEvidence: string;
}

async function world(label: string): Promise<World> {
  const harness = await restoreHarness(`collector-${label}`);
  const binding = await anchoredIncarnation(harness, "restore-cmd-collector");
  const quiesced = runRestoreQuiesce(harness.store, restoreRequest(harness, binding));
  if (!quiesced.ok) throw new Error(`restore refused: ${quiesced.code}`);
  seedImport(harness.store, DIGEST, [recordOf()]);
  harness.store.close();

  const root = scratch(label);
  const storeRoot = join(root, "store-root");
  mkdirSync(storeRoot);
  writeLiveQuiesceEvidence(storeRoot);
  const evidenceRoot = join(root, "evidence");
  mkdirSync(evidenceRoot);

  const windowsEvidence = join(root, "evidence.json");
  writeFileSync(windowsEvidence, canonicalJson({
    operation: "RECORDED", os: [{ platform: "win32", status: "PASS" }], publicationAuthorized: false,
    releaseVerdict: "UNKNOWN", source: { objectFormat: "sha1", sourceSha: COMMIT },
  }));

  const securityOut = join(root, "security-out");
  mkdirSync(join(securityOut, SECURITY_RECEIPTS_DIRNAME), { recursive: true });
  writeFileSync(join(securityOut, SECURITY_RUN_FILENAME), JSON.stringify({ runId: "run-collector" }));
  writeFileSync(join(securityOut, SECURITY_RECEIPTS_DIRNAME, "slice.security.ts.json"), JSON.stringify({
    entries: ["AFTER", "BEFORE", "RACE"].map((arm) => ({ arm, boundary: "ONE_LAYER", caseId: `c-${arm}` })),
    runId: "run-collector", sliceFile: "slice.security.ts",
  }));
  writeFileSync(join(securityOut, SECURITY_REPORT_FILENAME), JSON.stringify({
    numFailedTests: 0, numPassedTests: 3, numTotalTestSuites: 1, numTotalTests: 3, success: true,
  }));
  const sourceRoot = join(root, "checkout");
  mkdirSync(dirname(join(sourceRoot, SECURITY_ROSTER_PATH)), { recursive: true });
  writeFileSync(join(sourceRoot, SECURITY_ROSTER_PATH),
    '  { constant: "ONE_LAYER", file: "apps/daemon/src/one.ts", axis: "transport" },\n');

  const ports: V2ReadinessEvidencePorts = {
    ...createSystemEvidencePorts(),
    git: (args) => args[0] === "rev-parse" ? COMMIT : "",
    runGate: (script) => script === "test:e2e"
      ? { exitCode: 0, output: " Test Files  1 passed (1)\n      Tests  4 passed (4)\n" }
      : { exitCode: 0, output: "  2 passed (10s)\n" },
  };
  return { evidenceRoot, ports, securityOut, sourceRoot, storePath: harness.storePath, storeRoot, windowsEvidence };
}

function collect(opened: World, sourceCommit = COMMIT) {
  return collectV2ReadinessEvidence(opened.ports, {
    evidenceRoot: opened.evidenceRoot,
    projectId: PROJECT_ID,
    security: { securityOut: opened.securityOut, sourceRoot: opened.sourceRoot },
    sourceCommit,
    sourceRoot: opened.sourceRoot,
    storePath: opened.storePath,
    storeRoot: opened.storeRoot,
    windows: { releaseEvidencePath: opened.windowsEvidence },
  });
}

describe("collectV2ReadinessEvidence", () => {
  it("produces the six kinds that have a source and refuses the two that do not, by name", async () => {
    const opened = await world("honest");
    const receipt = collect(opened);
    expect(receipt.ok).toBe(false);
    expect(Object.keys(receipt.produced).sort()).toEqual([
      "acceptanceEvidence", "backupEvidence", "contractSchema", "securityEvidence",
      "storeMigrationEvidence", "windowsPackagingEvidence",
    ]);
    expect(receipt.refused).toEqual({
      deliveryProfileQualificationEvidence: expect.objectContaining({ code: "V2_EVIDENCE_PRODUCER_ABSENT" }),
      restoreDrill: expect.objectContaining({ code: "V2_EVIDENCE_PRODUCER_ABSENT" }),
    });
    // Every produced file is on disk under the writer's pinned name, and its bytes hash to
    // the receipt's digest: the readiness writer will bind exactly these bytes.
    for (const [kind, entry] of Object.entries(receipt.produced)) {
      const filename = V2_READINESS_EVIDENCE_FILENAMES[kind as keyof typeof V2_READINESS_EVIDENCE_FILENAMES];
      expect(entry.file).toBe(join(opened.evidenceRoot, filename));
      expect(sha256Hex(new Uint8Array(readFileSync(entry.file)))).toBe(entry.sha256);
    }
    expect(Object.keys(receipt.produced).length + Object.keys(receipt.refused).length)
      .toBe(V2_READINESS_EVIDENCE_KINDS.length);

    // A second run never overwrites: each produced kind is refused as an output conflict.
    const again = collect(opened);
    expect(Object.keys(again.produced)).toEqual([]);
    for (const kind of Object.keys(receipt.produced)) {
      expect(again.refused[kind as keyof typeof again.refused])
        .toMatchObject({ code: "V2_EVIDENCE_OUTPUT_CONFLICT" });
    }
  }, 60_000);

  it("refuses every kind on a malformed source commit and writes nothing", async () => {
    const opened = await world("bad-commit");
    const receipt = collect(opened, "not-a-commit");
    expect(receipt.ok).toBe(false);
    expect(receipt.produced).toEqual({});
    expect(Object.keys(receipt.refused).sort()).toEqual([...V2_READINESS_EVIDENCE_KINDS].sort());
    for (const refusal of Object.values(receipt.refused)) {
      expect(refusal.code).toBe("V2_EVIDENCE_SOURCE_COMMIT_INVALID");
    }
  }, 60_000);

  it("the CLI refuses a missing flag by name with exit 2 before touching anything", () => {
    const main = join(dirname(fileURLToPath(import.meta.url)), "v2-readiness-evidence-collector-main.ts");
    const run = spawnSync(process.execPath, [main, "--evidence-root=x"], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout) as Record<string, unknown>).toMatchObject({
      code: "V2_READINESS_EVIDENCE_USAGE", missing: "source-commit", ok: false,
    });
  }, 60_000);
});

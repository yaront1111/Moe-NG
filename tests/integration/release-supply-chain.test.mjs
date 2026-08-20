import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { RELEASE_COMPONENTS } from "../../scripts/release/release-subject.mjs";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SOURCE_SHA = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).trim();
const temporary = [];
const COMPONENT_IDS = Object.freeze(RELEASE_COMPONENTS.map((entry) => entry.componentId));

const temp = () => {
  const path = mkdtempSync(join(tmpdir(), "moe-release-test-"));
  temporary.push(path);
  return path;
};

/**
 * A PER-SUITE EQUIVALENT of the hardened teardown, not an import: this file runs under
 * `node --test` as `.mjs`, which cannot load the TypeScript helper the daemon tree shares.
 * The reference implementation is `removeTemporaryRoots` in
 * `tests/integration/release-archive-cleanup.test.ts`; the semantics are the same three —
 * iterate a COPY, prune only after the removal SUCCEEDS, and report rather than abandon.
 * The previous loop popped before removing, so one throw lost that dir and every dir behind it.
 */
afterEach(() => {
  const failures = [];
  for (const path of [...temporary]) {
    let removed = false;
    for (let attempt = 0; attempt < 2 && !removed; attempt += 1) {
      try {
        rmSync(path, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
        removed = true;
      } catch (error) {
        if (attempt === 1) failures.push(`${path}: ${String(error)}`);
      }
    }
    if (!removed) continue;
    const pruned = temporary.indexOf(path);
    if (pruned >= 0) temporary.splice(pruned, 1);
  }
  if (failures.length > 0) {
    throw new Error(`RELEASE_SUPPLY_CHAIN_TEARDOWN_LEAK: ${failures.join("; ")}`);
  }
});

const loadSubject = () => import("../../scripts/release/release-subject.mjs");
const loadSupplyChain = () => import("../../scripts/release/supply-chain.mjs");

function expectReleaseRefusal(result, reason) {
  assert.equal(result.ok, false);
  assert.equal(result.code, "RELEASE_SUPPLY_CHAIN_REFUSED");
  assert.equal(result.reason, reason);
  assert.equal(result.refusedBy, "RELEASE_SUPPLY_CHAIN");
}

async function buildSubject(overrides = {}) {
  const { buildReleaseSubject } = await loadSubject();
  const { privateKey } = generateKeyPairSync("ed25519");
  return buildReleaseSubject({
    privateKey,
    signingKeyId: "ephemeral-release-test",
    source: { objectFormat: "sha1", sourceSha: SOURCE_SHA },
    sourceRoot: REPO_ROOT,
    ...overrides,
  });
}

describe("release distribution subject", () => {
  test("builds the exact non-empty shipped inventory through production admission", async () => {
    const { RELEASE_COMPONENTS, RELEASE_TEMPLATES } = await loadSubject();
    const { privateKey } = generateKeyPairSync("ed25519");
    assert.equal(RELEASE_COMPONENTS.length, 6);
    assert.equal(RELEASE_TEMPLATES.length, 3);
    assert.equal(RELEASE_COMPONENTS.every((entry) => entry.assets.length > 0), true);

    const first = await buildSubject({ privateKey });
    assert.equal(first.ok, true);
    const second = await buildSubject({ privateKey });
    assert.equal(first.componentCount, 6);
    assert.equal(first.templateCount, 3);
    assert.equal(first.verificationKeyUse, "EPHEMERAL_VERIFICATION_ONLY");
    assert.equal(Object.hasOwn(first, "verificationPrivateKey"), false);
    assert.match(first.receipt.verificationKey.publicKeyHex, /^[0-9a-f]{64}$/u);
    assert.equal(first.containers.length, 6);
    assert.equal(first.receipt.admittedComponentIds.length, 6);
    assert.equal(first.receipt.compatibleComponentIds.length, 6);
    assert.deepEqual(
      second.containers.map((entry) => entry.containerBytes),
      first.containers.map((entry) => entry.containerBytes),
    );
  });

  test("refuses malformed source provenance at the release layer", async () => {
    const result = await buildSubject({
      source: { objectFormat: "sha1", sourceSha: "not-a-sha" },
    });
    expectReleaseRefusal(result, "SOURCE_PROVENANCE_INVALID");
  });

  test("refuses a generated empty inventory non-vacuously", async () => {
    const { buildReleaseSubject } = await loadSubject();
    const { privateKey } = generateKeyPairSync("ed25519");
    const cases = [[]];
    assert.equal(cases.length, 1);
    const result = buildReleaseSubject({
      components: cases[0],
      privateKey,
      signingKeyId: "ephemeral-release-test",
      source: { objectFormat: "sha1", sourceSha: SOURCE_SHA },
      sourceRoot: REPO_ROOT,
    });
    expectReleaseRefusal(result, "RELEASE_INVENTORY_EMPTY");
  });

  test("carries the toolchain observation reason in the frozen refusal vocabulary", async () => {
    const { RELEASE_REFUSAL_REASONS } = await loadSubject();
    assert.deepEqual([...RELEASE_REFUSAL_REASONS], [
      "SOURCE_PROVENANCE_INVALID", "RELEASE_INVENTORY_EMPTY", "RELEASE_INPUT_INVALID",
      "SOURCE_ASSET_UNAVAILABLE", "CONTROL_ROOM_COMPATIBILITY_REFUSED",
      "FROZEN_INSTALL_FAILED", "SBOM_GENERATION_FAILED", "DEPENDENCY_AUDIT_FAILED",
      "LICENSE_REPORT_FAILED", "SBOM_REPORT_INVALID", "DEPENDENCY_AUDIT_INVALID",
      "LICENSE_REPORT_INVALID", "SUPPORTED_OS_EVIDENCE_MISSING", "REPRODUCIBILITY_MISMATCH",
      "TOOLCHAIN_IDENTITY_MISMATCH", "TOOLCHAIN_OBSERVATION_FAILED",
      "EVIDENCE_PUBLICATION_CONFLICT", "CLI_ARGUMENT_INVALID", "OUTPUT_PATH_INVALID",
      "EVIDENCE_WRITE_INTERRUPTED",
    ]);
    assert.equal(RELEASE_REFUSAL_REASONS.length, 20);
    assert.equal(Object.isFrozen(RELEASE_REFUSAL_REASONS), true);
  });

  test("preserves delegated distribution refusal code and layer", async () => {
    const result = await buildSubject({ signingKeyId: "" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "DISTRIBUTION_MISMATCH");
    assert.equal(result.reason, "MANIFEST_SCHEMA_INVALID");
    assert.equal(result.refusedBy, "DISTRIBUTION_PACKAGER");
  });
});

function successfulEvidence() {
  return {
    audit: JSON.stringify({ advisories: {}, metadata: { dependencies: 95 } }),
    licenses: JSON.stringify({ MIT: [{ name: "fixture", version: "1.0.0" }] }),
    sbom: JSON.stringify({ bomFormat: "CycloneDX", components: [{ name: "fixture" }] }),
  };
}

function doctorReport() {
  const node = { known: true, value: "v24.16.0" };
  const pnpm = {
    known: false,
    code: "DOCTOR_TOOL_VERSION_UNREADABLE",
    layer: "DOCTOR_VERSION_HOST",
  };
  const nodeVersionFile = { known: true, value: "24.16.0\n" };
  const packageManager = { known: true, value: "pnpm@11.0.8" };
  const enginesNode = { known: true, value: "workspace:^24" };
  const enginesPnpm = {
    known: false,
    code: "DOCTOR_DECLARED_PIN_UNREADABLE",
    layer: "DOCTOR_VERSION_HOST",
  };
  return {
    reportVersion: "moe-doctor-version-report/1",
    observed: {
      node,
      pnpm,
      platform: { known: true, value: "win32" },
      arch: { known: true, value: "x64" },
    },
    declared: { nodeVersionFile, packageManager, enginesNode, enginesPnpm },
    pins: [
      { pin: "NODE_RUNTIME", declared: nodeVersionFile, observed: node, verdict: "SATISFIED" },
      {
        pin: "PNPM_TOOL",
        declared: { known: true, value: "11.0.8" },
        observed: pnpm,
        verdict: "UNKNOWN",
      },
      {
        pin: "ENGINES_NODE",
        declared: {
          known: false,
          code: "DOCTOR_PIN_RANGE_UNSUPPORTED",
          layer: "DOCTOR_VERSION",
        },
        observed: node,
        verdict: "UNKNOWN",
      },
      { pin: "ENGINES_PNPM", declared: enginesPnpm, observed: pnpm, verdict: "UNKNOWN" },
    ],
    components: [
      { name: "@moe/daemon", version: { known: true, value: "0.0.0" } },
      {
        name: "@moe/unreadable",
        version: {
          known: false,
          code: "DOCTOR_DECLARED_PIN_UNREADABLE",
          layer: "DOCTOR_VERSION_HOST",
        },
      },
    ],
    componentCount: 2,
    componentInventory: { known: true, value: "2" },
  };
}

function assertRecursivelyFrozen(value) {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertRecursivelyFrozen(nested);
}

function spy(implementation) {
  const fn = async (...args) => {
    fn.calls.push(args);
    return implementation(...args);
  };
  fn.calls = [];
  return fn;
}

function fakePorts(overrides = {}) {
  const evidence = successfulEvidence();
  return {
    archiveSource: spy(async ({ destination }) => ({ destination, ok: true })),
    buildSubject: spy(async ({ buildIndex }) => ({
      componentCount: COMPONENT_IDS.length,
      containers: COMPONENT_IDS
        .map((componentId) => ({
          assetDigests: [`asset-${componentId}`],
          componentId,
          containerBytes: new TextEncoder().encode(`container-${componentId}`),
          containerDigest: `container-digest-${componentId}`,
          manifestBytes: new TextEncoder().encode(`manifest-${componentId}`),
          manifestDigest: `manifest-digest-${componentId}`,
        })),
      ok: true,
      receipt: {
        admittedComponentIds: COMPONENT_IDS,
        compatibleComponentIds: COMPONENT_IDS,
        launchReceipts: [{ componentId: "daemon", physicallyLaunched: false }],
        verificationKey: { keyId: "ephemeral-release-test", publicKeyHex: "ab".repeat(32) },
      },
      source: { objectFormat: "sha1", sourceSha: SOURCE_SHA },
      templateCount: 3,
      verificationKeyUse: "EPHEMERAL_VERIFICATION_ONLY",
      buildIndex,
    })),
    collectDoctorVersionReport: spy(async () => structuredClone(doctorReport())),
    frozenInstall: spy(async () => ({ exitCode: 0, stderr: "", stdout: "" })),
    generateAudit: spy(async () => ({ exitCode: 0, stderr: "", stdout: evidence.audit })),
    generateLicenses: spy(async () => ({ exitCode: 0, stderr: "", stdout: evidence.licenses })),
    generateSbom: spy(async () => ({ exitCode: 0, stderr: "", stdout: evidence.sbom })),
    observeTools: spy(async () => ({ git: "2.51.0", node: "24.16.0", pnpm: "11.0.8", tar: "3.8.1", cdxgen: "12.8.2" })),
    readSourceFile: (_root, path) => readFileSync(join(REPO_ROOT, path)),
    resolveSource: spy(async () => ({ objectFormat: "sha1", sourceSha: SOURCE_SHA })),
    ...overrides,
  };
}

function supplyInput(overrides = {}) {
  return {
    evidenceRoot: temp(),
    platform: "win32",
    repositoryRoot: REPO_ROOT,
    source: { objectFormat: "sha1", sourceSha: SOURCE_SHA },
    ...overrides,
  };
}

async function runSupply(overrides = {}, portOverrides = {}) {
  const { runReleaseSupplyChain } = await loadSupplyChain();
  return runReleaseSupplyChain(supplyInput(overrides), fakePorts(portOverrides));
}

async function runSupplyWithPorts(ports, overrides = {}) {
  const { runReleaseSupplyChain } = await loadSupplyChain();
  return runReleaseSupplyChain(supplyInput(overrides), ports);
}

// Forces temporary cleanup to throw. cleanRoots removes `${root}.tar` WITHOUT `recursive`, so a
// directory at that path makes rmSync raise ERR_FS_EISDIR. That is the deterministic stand-in for
// the Windows EBUSY (held handle) this guard exists for: holding an open fd would NOT work, because
// libuv opens with FILE_SHARE_DELETE, rmSync then succeeds, and the test would be vacuous.
function blockingArchiveSource(blocked) {
  return spy(async ({ destination }) => {
    const obstacle = `${destination}.tar`;
    mkdirSync(obstacle, { recursive: true });
    writeFileSync(join(obstacle, "held"), "held");
    blocked.push({ obstacle, root: destination });
    return { destination, ok: true };
  });
}

function releaseBlocked(blocked) {
  for (const { obstacle, root } of blocked) {
    rmSync(obstacle, { force: true, recursive: true });
    rmSync(root, { force: true, recursive: true });
  }
}

// Cleanup ran (every build root is gone) AND it really hit the throwing removal (every obstacle
// survives). Without both, a green cleanup test would prove nothing.
function assertCleanupAttempted(blocked, expectedRoots) {
  assert.equal(blocked.length, expectedRoots);
  assert.equal(blocked.every(({ root }) => !existsSync(root)), true);
  assert.equal(blocked.every(({ obstacle }) => existsSync(obstacle)), true);
}

describe("release supply-chain evidence", () => {
  test("records Windows and keeps unsupported and unavailable evidence UNKNOWN", async () => {
    const ports = fakePorts();
    const result = await runSupplyWithPorts(ports);
    assert.equal(result.ok, true);
    assert.equal(result.evidence.buildCount, 2);
    assert.equal(result.evidence.componentCount, 6);
    assert.equal(result.evidence.templateCount, 3);
    assert.deepEqual(result.evidence.source, { objectFormat: "sha1", sourceSha: SOURCE_SHA });
    assert.equal(result.evidence.operation, "RECORDED");
    assert.equal(result.evidence.releaseVerdict, "UNKNOWN");
    assert.equal(result.evidence.publicationAuthorized, false);
    assert.deepEqual(ports.collectDoctorVersionReport.calls, [[]]);
    assert.deepEqual(result.evidence.doctor, doctorReport());
    assert.deepEqual(result.evidence.doctor.observed.pnpm, {
      known: false,
      code: "DOCTOR_TOOL_VERSION_UNREADABLE",
      layer: "DOCTOR_VERSION_HOST",
    });
    assert.deepEqual(result.evidence.doctor.pins[2].declared, {
      known: false,
      code: "DOCTOR_PIN_RANGE_UNSUPPORTED",
      layer: "DOCTOR_VERSION",
    });
    assert.equal(result.evidence.doctor.componentCount, 2);
    assert.equal(result.evidence.componentCount, 6);
    assert.equal(Object.hasOwn(result.evidence.doctor, "missingSymbol"), false);
    assertRecursivelyFrozen(result.evidence.doctor);
    assert.deepEqual(result.evidence.os, [
      { platform: "win32", status: "PASS" },
      {
        deferredTaskId: "task-e87a735386f643fe92c0eeff09bc4275",
        platform: "linux",
        reason: "SUPPORTED_OS_EVIDENCE_MISSING",
        status: "UNKNOWN",
      },
      {
        deferredTaskId: "task-e94b2055e281489ea9e97820919f6856",
        platform: "darwin",
        reason: "SUPPORTED_OS_EVIDENCE_MISSING",
        status: "UNKNOWN",
      },
    ]);
    assert.ok(result.evidence.sbom.componentCount > 0);
    assert.ok(result.evidence.audit.dependencyCount > 0);
    assert.ok(result.evidence.licenses.packageCount > 0);
    assert.deepEqual(result.evidence.builds[0].containers, result.evidence.builds[1].containers);
    assert.deepEqual(result.evidence.sbom.normalizedPointers,
      ["/annotations/timestamp", "/metadata/timestamp", "/serialNumber"]);
    assert.deepEqual(result.evidence.builds[0].subjectReceipt,
      result.evidence.builds[1].subjectReceipt);
    assert.equal(result.evidence.builds[0].verificationKeyUse,
      "EPHEMERAL_VERIFICATION_ONLY");
    assert.equal(Object.hasOwn(result.evidence.builds[0], "privateKey"), false);
    assert.equal(result.evidence.builds[0].sourceDigests.lockBefore,
      result.evidence.builds[0].sourceDigests.lockAfter);
  });

  test("records the real bare-root doctor observation from the executing process", async () => {
    const ports = fakePorts();
    delete ports.collectDoctorVersionReport;
    const result = await runSupplyWithPorts(ports);
    assert.equal(result.ok, true);
    assert.equal(result.evidence.doctor.reportVersion, "moe-doctor-version-report/1");
    assert.deepEqual(result.evidence.doctor.observed.node, {
      known: true,
      value: process.version,
    });
    assert.deepEqual(result.evidence.doctor.observed.platform, {
      known: true,
      value: process.platform,
    });
    assert.equal(result.evidence.doctor.pins.length, 4);
    assert.equal(result.evidence.doctor.componentCount > 0, true);
    assert.equal(result.evidence.doctor.componentCount,
      result.evidence.doctor.components.length);
    assert.equal(Object.hasOwn(result.evidence.doctor, "missingSymbol"), false);
    assertRecursivelyFrozen(result.evidence.doctor);
  });

  // The collector owns its report; recorded evidence must own an independent snapshot. Mutating the
  // very object the port returned, after the run, is the only way to tell a copy from an alias.
  test("snapshots the doctor report instead of aliasing the collector's object", async () => {
    const retained = doctorReport();
    const collectDoctorVersionReport = spy(async () => retained);
    const result = await runSupplyWithPorts(fakePorts({ collectDoctorVersionReport }));
    assert.equal(result.ok, true);
    assert.deepEqual(result.evidence.doctor, doctorReport());
    // An alias would have carried the recorder's deep freeze back to the collector's own object.
    assert.equal(Object.isFrozen(retained), false);

    retained.componentCount = 99;
    retained.observed.node.value = "v0.0.0";
    retained.pins[0].verdict = "VIOLATED";
    retained.components.push({ name: "@moe/forged", version: { known: true, value: "9.9.9" } });

    assert.deepEqual(result.evidence.doctor, doctorReport());
    assert.equal(result.evidence.doctor.componentCount, 2);
    assert.equal(result.evidence.doctor.components.length, 2);
  });

  const doctorFailureCases = [
    ["a rejected doctor observation", () => { throw new Error("doctor unavailable"); }],
    ["a structured doctor refusal", () => ({
      ok: false,
      code: "RELEASE_SUPPLY_CHAIN_REFUSED",
      reason: "TOOLCHAIN_OBSERVATION_FAILED",
      refusedBy: "RELEASE_SUPPLY_CHAIN",
    })],
    ["an incompatible doctor report", () => ({
      ...doctorReport(),
      reportVersion: "moe-doctor-version-report/2",
    })],
  ];
  assert.equal(doctorFailureCases.length, 3);

  for (const [label, observation] of doctorFailureCases) {
    test(`refuses ${label} before evidence publication`, async () => {
      const collectDoctorVersionReport = spy(async () => observation());
      const publishEvidence = spy(async () => ({ ok: true, reused: false }));
      const ports = fakePorts({ collectDoctorVersionReport, publishEvidence });
      const result = await runSupplyWithPorts(ports);
      expectReleaseRefusal(result, "TOOLCHAIN_OBSERVATION_FAILED");
      assert.deepEqual(collectDoctorVersionReport.calls, [[]]);
      assert.equal(ports.archiveSource.calls.length, 0);
      assert.equal(ports.buildSubject.calls.length, 0);
      assert.equal(publishEvidence.calls.length, 0);
    });
  }

  test("refuses a stale five-component subject at the release supply-chain layer", async () => {
    const ports = fakePorts();
    const acceptedSubject = ports.buildSubject;
    ports.buildSubject = spy(async (request) => ({
      ...await acceptedSubject(request),
      componentCount: 5,
    }));
    const result = await runSupplyWithPorts(ports);
    expectReleaseRefusal(result, "RELEASE_INVENTORY_EMPTY");
    assert.equal(ports.buildSubject.calls.length, 1);
  });

  test("admits the orchestrator argument through the real subject builder", async () => {
    const { RELEASE_COMPONENTS, RELEASE_TEMPLATES, buildReleaseSubject } = await loadSubject();
    const owned = [...RELEASE_COMPONENTS.flatMap((entry) => entry.assets), ...RELEASE_TEMPLATES];
    assert.ok(owned.length > 0);
    const result = await runSupply({}, {
      archiveSource: spy(async ({ destination }) => {
        for (const logicalPath of owned) {
          const target = join(destination, ...logicalPath.split("/"));
          mkdirSync(dirname(target), { recursive: true });
          copyFileSync(join(REPO_ROOT, ...logicalPath.split("/")), target);
        }
        return { destination, ok: true };
      }),
      buildSubject: buildReleaseSubject,
    });
    assert.equal(result.reason, undefined);
    assert.equal(result.ok, true);
    assert.equal(result.evidence.componentCount, 6);
    assert.equal(result.evidence.templateCount, 3);
    assert.equal(result.evidence.builds.length, 2);
    assert.equal(result.evidence.builds[0].containers.length, 6);
    assert.equal(result.evidence.builds[0].verificationKeyUse, "EPHEMERAL_VERIFICATION_ONLY");
    assert.deepEqual(result.evidence.builds[0].containers, result.evidence.builds[1].containers);
  });

  for (const [operation, reason] of [
    ["frozenInstall", "FROZEN_INSTALL_FAILED"],
    ["generateSbom", "SBOM_GENERATION_FAILED"],
    ["generateAudit", "DEPENDENCY_AUDIT_FAILED"],
    ["generateLicenses", "LICENSE_REPORT_FAILED"],
  ]) {
    test(`refuses ${operation} failure without changing durable evidence`, async () => {
      const evidenceRoot = temp();
      const sentinel = join(evidenceRoot, "sentinel");
      writeFileSync(sentinel, "unchanged");
      const { runReleaseSupplyChain } = await loadSupplyChain();
      const ports = fakePorts({
        [operation]: spy(async () => ({ exitCode: 1, stderr: "failed", stdout: "" })),
      });
      const result = await runReleaseSupplyChain({
        evidenceRoot,
        platform: "win32",
        repositoryRoot: REPO_ROOT,
        source: { objectFormat: "sha1", sourceSha: SOURCE_SHA },
      }, ports);
      expectReleaseRefusal(result, reason);
      assert.equal(readFileSync(sentinel, "utf8"), "unchanged");
    });
  }

  for (const [operation, stdout, reason] of [
    ["generateSbom", "{}", "SBOM_REPORT_INVALID"],
    ["generateAudit", "{}", "DEPENDENCY_AUDIT_INVALID"],
    ["generateLicenses", "{}", "LICENSE_REPORT_INVALID"],
  ]) {
    test(`refuses empty or malformed ${operation} output`, async () => {
      const result = await runSupply({}, {
        [operation]: spy(async () => ({ exitCode: 0, stderr: "", stdout })),
      });
      expectReleaseRefusal(result, reason);
    });
  }

  const malformedReports = [
    ["generateSbom", "SBOM_REPORT_INVALID"],
    ["generateAudit", "DEPENDENCY_AUDIT_INVALID"],
    ["generateLicenses", "LICENSE_REPORT_INVALID"],
  ];
  assert.ok(malformedReports.length > 0);
  for (const [operation, reason] of malformedReports) {
    test(`refuses syntactically malformed ${operation} output`, async () => {
      const result = await runSupply({}, {
        [operation]: spy(async () => ({ exitCode: 0, stderr: "", stdout: "{" })),
      });
      expectReleaseRefusal(result, reason);
    });
  }

  test("refuses unsupported host execution rather than fabricating OS evidence", async () => {
    expectReleaseRefusal(await runSupply({ platform: "linux" }), "SUPPORTED_OS_EVIDENCE_MISSING");
  });

  test("refuses malformed source SHA before external work", async () => {
    const ports = fakePorts();
    const { runReleaseSupplyChain } = await loadSupplyChain();
    const result = await runReleaseSupplyChain({
      evidenceRoot: temp(),
      platform: "win32",
      repositoryRoot: REPO_ROOT,
      source: { objectFormat: "sha1", sourceSha: "bad" },
    }, ports);
    expectReleaseRefusal(result, "SOURCE_PROVENANCE_INVALID");
    assert.equal(ports.archiveSource.calls.length, 0);
  });

  const toolDriftCases = [
    ["node", "25.0.0"], ["pnpm", "12.0.0"], ["cdxgen", "12.8.3"],
  ];
  assert.ok(toolDriftCases.length > 0);
  for (const [tool, version] of toolDriftCases) {
    test(`refuses observed ${tool} identity drift`, async () => {
      const observed = { git: "2.51.0", node: "24.16.0", pnpm: "11.0.8", tar: "3.8.1", cdxgen: "12.8.2", [tool]: version };
      expectReleaseRefusal(await runSupply({}, {
        observeTools: spy(async () => observed),
      }), "TOOLCHAIN_IDENTITY_MISMATCH");
    });
  }

  test("separates an unobservable toolchain from a frozen install failure", async () => {
    const unobservable = fakePorts({ observeTools: spy(async () => undefined) });
    const observation = await runSupplyWithPorts(unobservable);
    expectReleaseRefusal(observation, "TOOLCHAIN_OBSERVATION_FAILED");
    assert.equal(unobservable.frozenInstall.calls.length, 0);

    const brokenInstall = fakePorts({
      frozenInstall: spy(async () => ({ exitCode: 9, stderr: "frozen install failed", stdout: "" })),
    });
    const install = await runSupplyWithPorts(brokenInstall);
    expectReleaseRefusal(install, "FROZEN_INSTALL_FAILED");
    assert.equal(brokenInstall.observeTools.calls.length, 1);
    assert.equal(brokenInstall.frozenInstall.calls.length, 1);

    // The two failures live in different subsystems and must never share a reason again.
    assert.notEqual(observation.reason, install.reason);
  });

  test("keeps a successful record when temporary cleanup fails", async () => {
    const blocked = [];
    try {
      const result = await runSupply({}, { archiveSource: blockingArchiveSource(blocked) });
      // Both roots are cleaned even though the first one threw: cleanup must not abandon the rest.
      assertCleanupAttempted(blocked, 2);
      assert.equal(result.reason, undefined);
      assert.equal(result.ok, true);
      assert.equal(result.evidence.operation, "RECORDED");
      assert.equal(result.evidence.releaseVerdict, "UNKNOWN");
    } finally { releaseBlocked(blocked); }
  });

  test("keeps the original refusal reason when temporary cleanup fails", async () => {
    const blocked = [];
    try {
      const result = await runSupply({}, {
        archiveSource: blockingArchiveSource(blocked),
        generateSbom: spy(async () => ({ exitCode: 1, stderr: "sbom failed", stdout: "" })),
      });
      assertCleanupAttempted(blocked, 1);
      expectReleaseRefusal(result, "SBOM_GENERATION_FAILED");
    } finally { releaseBlocked(blocked); }
  });

  test("refuses unreviewed reproducibility drift", async () => {
    let buildIndex = 0;
    const buildSubject = spy(async () => {
      buildIndex += 1;
      const result = await fakePorts().buildSubject({ buildIndex });
      if (buildIndex === 2) result.containers[0].containerBytes = new TextEncoder().encode("drift");
      return result;
    });
    expectReleaseRefusal(await runSupply({}, { buildSubject }),
      "REPRODUCIBILITY_MISMATCH");
  });

  test("refuses frozen source metadata mutation", async () => {
    let reads = 0;
    const readSourceFile = () => new TextEncoder().encode(`source-${reads += 1}`);
    expectReleaseRefusal(await runSupply({}, { readSourceFile }),
      "REPRODUCIBILITY_MISMATCH");
  });

  test("refuses a source SHA that differs from the observed head before external work", async () => {
    const ports = fakePorts({
      resolveSource: spy(async () => ({ objectFormat: "sha1", sourceSha: "0".repeat(40) })),
    });
    const { runReleaseSupplyChain } = await loadSupplyChain();
    const result = await runReleaseSupplyChain({
      evidenceRoot: temp(),
      platform: "win32",
      repositoryRoot: REPO_ROOT,
      source: { objectFormat: "sha1", sourceSha: SOURCE_SHA },
    }, ports);
    expectReleaseRefusal(result, "SOURCE_PROVENANCE_INVALID");
    assert.equal(ports.archiveSource.calls.length, 0);
    assert.equal(ports.frozenInstall.calls.length, 0);
  });

  test("refuses an audit report whose advisories field is absent", async () => {
    expectReleaseRefusal(await runSupply({}, {
      generateAudit: spy(async () => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({ metadata: { dependencies: 95 } }),
      })),
    }), "DEPENDENCY_AUDIT_INVALID");
  });

  test("refuses SBOM component drift that normalization must not absorb", async () => {
    let call = 0;
    expectReleaseRefusal(await runSupply({}, {
      generateSbom: spy(async () => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          bomFormat: "CycloneDX",
          components: [{ name: `fixture-${call += 1}` }],
          metadata: { timestamp: `2026-08-09T00:00:0${call}Z` },
          serialNumber: `urn:uuid:0000000${call}`,
        }),
      })),
    }), "REPRODUCIBILITY_MISMATCH");
  });

  const sbomWithPath = (path, tick, note = "generated") => JSON.stringify({
    annotations: [{ text: note, timestamp: `2026-08-09T00:00:0${tick}Z` }],
    bomFormat: "CycloneDX",
    components: [{ name: "fixture", properties: [{ name: "SrcFile", value: `${path}/package.json` }] }],
    metadata: { timestamp: `2026-08-09T01:00:0${tick}Z` },
    serialNumber: `urn:uuid:0000000${tick}`,
  });

  test("normalizes only the build source root and reviewed volatile pointers", async () => {
    let tick = 0;
    const result = await runSupply({}, {
      generateSbom: spy(async ({ sourceRoot }) => ({
        exitCode: 0, stderr: "", stdout: sbomWithPath(sourceRoot, tick += 1),
      })),
    });
    assert.equal(result.reason, undefined);
    assert.equal(result.ok, true);
    assert.equal(result.evidence.sbom.normalizedSourceRootToken, "<SOURCE_ROOT>");
    assert.deepEqual(result.evidence.sbom.normalizedPointers,
      ["/annotations/timestamp", "/metadata/timestamp", "/serialNumber"]);
    assert.notEqual(result.evidence.builds[0].sbomRawDigest, result.evidence.builds[1].sbomRawDigest);
    assert.equal(result.evidence.builds[0].sbomNormalizedDigest,
      result.evidence.builds[1].sbomNormalizedDigest);
  });

  test("refuses SBOM path drift outside the build source root", async () => {
    let tick = 0;
    expectReleaseRefusal(await runSupply({}, {
      generateSbom: spy(async () => ({
        exitCode: 0, stderr: "", stdout: sbomWithPath(`D:/foreign-${tick += 1}`, tick),
      })),
    }), "REPRODUCIBILITY_MISMATCH");
  });

  test("refuses annotation content drift that is not a reviewed pointer", async () => {
    let tick = 0;
    expectReleaseRefusal(await runSupply({}, {
      generateSbom: spy(async ({ sourceRoot }) => ({
        exitCode: 0, stderr: "", stdout: sbomWithPath(sourceRoot, tick += 1, `note-${tick}`),
      })),
    }), "REPRODUCIBILITY_MISMATCH");
  });

  // One row per releaseRefusal site reachable through runReleaseSupplyChain. The hand-written
  // length plus the distinct-reason count pin the intentional duplicate: tool and doctor
  // observation failures share one stable reason but remain separate production sites.
  let mutatingReads = 0;
  const refusalSites = [
    ["a traversal evidence root", { evidenceRoot: "../escape" }, {}, "OUTPUT_PATH_INVALID"],
    ["malformed source provenance", { source: { objectFormat: "sha1", sourceSha: "bad" } }, {}, "SOURCE_PROVENANCE_INVALID"],
    ["an unsupported host", { platform: "linux" }, {}, "SUPPORTED_OS_EVIDENCE_MISSING"],
    ["an unobservable toolchain", {}, { observeTools: spy(async () => undefined) }, "TOOLCHAIN_OBSERVATION_FAILED"],
    ["an unavailable doctor observation", {}, {
      collectDoctorVersionReport: spy(async () => { throw new Error("doctor unavailable"); }),
    }, "TOOLCHAIN_OBSERVATION_FAILED"],
    ["toolchain identity drift", {}, {
      observeTools: spy(async () => ({ git: "2.51.0", node: "25.0.0", pnpm: "11.0.8", tar: "3.8.1", cdxgen: "12.8.2" })),
    }, "TOOLCHAIN_IDENTITY_MISMATCH"],
    ["a failed source archive", {}, { archiveSource: spy(async () => ({ ok: false })) }, "SOURCE_ARCHIVE_FAILED"],
    ["a failed frozen install", {}, {
      frozenInstall: spy(async () => ({ exitCode: 1, stderr: "install failed", stdout: "" })),
    }, "FROZEN_INSTALL_FAILED"],
    ["frozen source mutation", {}, {
      readSourceFile: () => new TextEncoder().encode(`source-${mutatingReads += 1}`),
    }, "REPRODUCIBILITY_MISMATCH"],
    ["an unreadable source file", {}, {
      readSourceFile: () => { throw new Error("source unreadable"); },
    }, "EVIDENCE_WRITE_INTERRUPTED"],
  ];
  assert.equal(refusalSites.length, 10);
  assert.equal(new Set(refusalSites.map((entry) => entry[3])).size, 9);

  for (const [label, overrides, portOverrides, reason] of refusalSites) {
    test(`refuses ${label} with its own reason`, async () => {
      expectReleaseRefusal(await runSupply(overrides, portOverrides), reason);
    });
  }

  // Cleanup and deregistration must still happen on every exit path. This task changed what
  // cleanup can OVERWRITE, not whether it runs.
  const lifecycleCases = [
    ["success", {}, undefined, 2],
    ["refusal", { generateSbom: spy(async () => ({ exitCode: 1, stderr: "", stdout: "" })) }, "SBOM_GENERATION_FAILED", 1],
    ["exception", { readSourceFile: () => { throw new Error("source unreadable"); } }, "EVIDENCE_WRITE_INTERRUPTED", 1],
  ];
  assert.equal(lifecycleCases.length, 3);

  for (const [label, portOverrides, reason, expectedRoots] of lifecycleCases) {
    test(`cleans up and deregisters signal handlers on ${label}`, async () => {
      const roots = [];
      const sigint = process.listenerCount("SIGINT");
      const sigterm = process.listenerCount("SIGTERM");
      const result = await runSupply({}, {
        archiveSource: spy(async ({ destination }) => {
          roots.push(destination);
          return { destination, ok: true };
        }),
        ...portOverrides,
      });
      assert.equal(roots.length, expectedRoots);
      assert.equal(roots.every((root) => !existsSync(root)), true);
      assert.equal(process.listenerCount("SIGINT"), sigint);
      assert.equal(process.listenerCount("SIGTERM"), sigterm);
      if (reason === undefined) assert.equal(result.ok, true);
      else expectReleaseRefusal(result, reason);
    });
  }

  test("cleans up on the signal path without replacing the outcome", async () => {
    const blocked = [];
    const exits = [];
    const observed = {};
    const sigint = process.listenerCount("SIGINT");
    const sigterm = process.listenerCount("SIGTERM");
    const realExit = process.exit;
    try {
      process.exit = (code) => { exits.push(code); };
      // The registered SIGINT handler cleans up and exits; it must not be able to throw either,
      // so it runs here against a build root whose removal fails.
      const result = await runSupply({}, {
        archiveSource: blockingArchiveSource(blocked),
        frozenInstall: spy(async () => {
          if (exits.length === 0) {
            observed.sigint = process.listenerCount("SIGINT");
            observed.sigterm = process.listenerCount("SIGTERM");
            observed.stop = process.listeners("SIGINT").at(-1);
            if (typeof observed.stop === "function") observed.stop();
          }
          return { exitCode: 0, stderr: "", stdout: "" };
        }),
      });
      assert.equal(observed.sigint, sigint + 1);
      assert.equal(observed.sigterm, sigterm + 1);
      assert.deepEqual(exits, [130]);
      assert.equal(result.reason, undefined);
      assert.equal(result.ok, true);
      assertCleanupAttempted(blocked, 2);
    } finally {
      process.exit = realExit;
      releaseBlocked(blocked);
    }
    assert.equal(process.listenerCount("SIGINT"), sigint);
    assert.equal(process.listenerCount("SIGTERM"), sigterm);
  });

  test("refuses conflicting durable content through the real publisher", async () => {
    const evidenceRoot = temp();
    const first = await runSupply({ evidenceRoot });
    assert.equal(first.ok, true);
    writeFileSync(first.evidencePath, "conflicting-durable-bytes");
    const second = await runSupply({ evidenceRoot });
    expectReleaseRefusal(second, "EVIDENCE_PUBLICATION_CONFLICT");
    assert.equal(readFileSync(first.evidencePath, "utf8"), "conflicting-durable-bytes");
  });

  test("publishes idempotently and refuses conflicting concurrent content", async () => {
    const evidenceRoot = temp();
    const [first, second] = await Promise.all([
      runSupply({ evidenceRoot }), runSupply({ evidenceRoot }),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.evidenceDigest, first.evidenceDigest);
    expectReleaseRefusal(await runSupply({ evidenceRoot }, {
      publishEvidence: spy(async () => ({
        code: "RELEASE_SUPPLY_CHAIN_REFUSED",
        ok: false,
        reason: "EVIDENCE_PUBLICATION_CONFLICT",
        refusedBy: "RELEASE_SUPPLY_CHAIN",
      })),
    }),
      "EVIDENCE_PUBLICATION_CONFLICT");
  });
});

describe("release CLI and filesystem boundary", () => {
  test("accepts only the explicit current-HEAD mode without a publish flag", async () => {
    const { parseReleaseArguments } = await loadSupplyChain();
    assert.deepEqual(parseReleaseArguments(["--head"]), { mode: "HEAD", ok: true });
  });

  test("rejects extra CLI keys at the release layer", async () => {
    const { parseReleaseArguments } = await loadSupplyChain();
    expectReleaseRefusal(parseReleaseArguments(["--source-sha", SOURCE_SHA, "--publish"]),
      "CLI_ARGUMENT_INVALID");
  });

  for (const [hostileCase, reason] of [
    ["partial-write", "EVIDENCE_WRITE_INTERRUPTED"],
    ["symlink-output", "OUTPUT_PATH_INVALID"],
  ]) {
    test(`refuses hostile output case ${hostileCase}`, async () => {
      const publishEvidence = spy(async () => ({
        code: "RELEASE_SUPPLY_CHAIN_REFUSED", ok: false, reason,
        refusedBy: "RELEASE_SUPPLY_CHAIN",
      }));
      expectReleaseRefusal(await runSupply({}, { publishEvidence }), reason);
    });
  }

  test("refuses traversal evidence roots before external work", async () => {
    expectReleaseRefusal(await runSupply({ evidenceRoot: "../escape" }), "OUTPUT_PATH_INVALID");
  });

  test("refuses a not-yet-created evidence root beneath a junction", async () => {
    const link = join(temp(), "junction");
    symlinkSync(temp(), link, "junction");
    expectReleaseRefusal(await runSupply({ evidenceRoot: join(link, "new") }),
      "OUTPUT_PATH_INVALID");
  });

  test("refuses a junction planted below the evidence root through the real publisher", async () => {
    const evidenceRoot = temp();
    const outside = temp();
    symlinkSync(outside, join(evidenceRoot, SOURCE_SHA), "junction");
    expectReleaseRefusal(await runSupply({ evidenceRoot }), "OUTPUT_PATH_INVALID");
    assert.deepEqual(readdirSync(outside), []);
  });

  // The macOS $TMPDIR shape, made host-independent. On darwin runners /var is a symlink to
  // /private/var, so EVERY temp evidence root carries a symlinked ancestor ABOVE it. A win32
  // junction reproduces that exactly — lstatSync(junction).isSymbolicLink() is true here too —
  // so these two accept cases pin the darwin behaviour on every host, no macOS lane required.
  test("publishes through a symlinked ancestor above an existing evidence root", async () => {
    const link = join(temp(), "ancestor");
    symlinkSync(temp(), link, "junction");
    const evidenceRoot = join(link, "root");
    mkdirSync(evidenceRoot);
    const result = await runSupply({ evidenceRoot });
    assert.equal(result.reason, undefined);
    assert.equal(result.ok, true);
    assert.equal(existsSync(result.evidencePath), true);
    assert.equal(JSON.parse(readFileSync(result.evidencePath, "utf8")).operation, "RECORDED");
  });

  // Production's own shape, and the reason the ceiling is the root's nearest EXISTING ancestor
  // rather than the root itself: main() passes evidenceRoot = join(repositoryRoot, "dist",
  // "release") and dist/ is gitignored, so on a clean checkout the root does not exist when the
  // guard runs. A bound expressed as "stop when the cursor equals the root" can never fire there.
  test("publishes through a symlinked ancestor above an absent evidence root", async () => {
    const link = join(temp(), "ancestor");
    symlinkSync(temp(), link, "junction");
    mkdirSync(join(link, "repo"));
    const result = await runSupply({ evidenceRoot: join(link, "repo", "dist", "release") });
    assert.equal(result.reason, undefined);
    assert.equal(result.ok, true);
    assert.equal(existsSync(result.evidencePath), true);
  });

  // The fence at the exact boundary those two accept cases move: the ceiling is INCLUSIVE, so an
  // evidence root that IS itself a junction to a real outside destination still refuses and writes
  // nothing there. The archive call count pins WHICH layer refused — validInput returns
  // OUTPUT_PATH_INVALID before any port runs, so two archive calls prove this one came from the
  // publisher's path guard and not from input validation.
  test("refuses an evidence root that is itself a junction to an outside destination", async () => {
    const outside = temp();
    const evidenceRoot = join(temp(), "asroot");
    symlinkSync(outside, evidenceRoot, "junction");
    const archiveSource = spy(async ({ destination }) => ({ destination, ok: true }));
    expectReleaseRefusal(await runSupply({ evidenceRoot }, { archiveSource }), "OUTPUT_PATH_INVALID");
    assert.equal(archiveSource.calls.length, 2);
    assert.deepEqual(readdirSync(outside), []);
  });

  // A DANGLING junction — target removed after the link was made — reads as absent to existsSync
  // while lstat still sees the reparse point, so the ascent to the deepest existing ancestor would
  // step straight over it and the symlink walk above would never visit it. A planted redirect is a
  // containment failure whichever way it points, so it must carry the containment code: without the
  // ascent's own lstat the publish instead dies in the write half as EVIDENCE_WRITE_INTERRUPTED,
  // which reports a containment violation as a disk mishap.
  test("refuses a dangling junction in the target span with the containment code", async () => {
    const evidenceRoot = temp();
    const vanished = join(temp(), "vanished");
    mkdirSync(vanished);
    symlinkSync(vanished, join(evidenceRoot, SOURCE_SHA), "junction");
    rmSync(vanished, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    const result = await runSupply({ evidenceRoot });
    assert.notEqual(result.reason, "EVIDENCE_WRITE_INTERRUPTED");
    expectReleaseRefusal(result, "OUTPUT_PATH_INVALID");
  });

  // Mirror negative for that lstat: an ancestor chain that is merely ABSENT, with no link anywhere,
  // must still publish. Every segment of this root is walked by the same ascent as the dangling
  // case, so a probe that refused on absence rather than on a surviving reparse point reds here.
  test("publishes into an evidence root whose ancestor chain does not exist yet", async () => {
    const result = await runSupply({ evidenceRoot: join(temp(), "absent", "chain") });
    assert.equal(result.reason, undefined);
    assert.equal(result.ok, true);
    assert.equal(existsSync(result.evidencePath), true);
  });
});

describe("release package command", () => {
  const packageJson = () => JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

  test("runs pnpm through a validated Corepack JavaScript entrypoint", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts/release/supply-chain.mjs"), "utf8");
    assert.match(source, /realpathSync\(PNPM_ENTRY\)/u);
    assert.match(source, /command\(process\.execPath, \[entry, \.\.\.args\]/u);
    // The doctor observed-key list names a report field, not an executable. Exempt exactly that
    // one declaration - and assert it is still present verbatim - so the PATH-resolution guard
    // stays a whole-file scan instead of being narrowed to a call-site pattern.
    const keyDeclaration =
      /const DOCTOR_OBSERVED_KEYS = Object\.freeze\(\["arch", "node", "platform", "pnpm"\]\);\n/u;
    assert.match(source, keyDeclaration);
    assert.doesNotMatch(source.replace(keyDeclaration, ""), /"pnpm(?:\.exe)?"/u);
  });

  test("collects the CycloneDX document from a file, never from stdout", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts/release/supply-chain.mjs"), "utf8");
    assert.match(source, /"-o", output/u);
    assert.match(source, /stdout: readFileSync\(output, "utf8"\)/u);
    assert.doesNotMatch(source, /"-o", "-"/u);
  });

  test("pins checked release scripts and the local CycloneDX generator", () => {
    const root = packageJson();
    assert.equal(root.devDependencies["@cyclonedx/cdxgen"], "12.8.2");
    assert.equal(root.scripts["release:evidence"],
      "node scripts/release/supply-chain.mjs --head");
    assert.match(root.scripts["test:integration"],
      /node --test tests\/integration\/release-supply-chain\.test\.mjs/u);
    assert.match(root.scripts["typecheck:release"], /--allowJs --checkJs/u);
    assert.equal(root.scripts["verify:release"],
      "pnpm typecheck:release && pnpm test:integration && pnpm release:evidence");
    assert.equal(root.private, true);
    assert.equal(Object.hasOwn(root, "publishConfig"), false);
  });

  test("records truthful evidence through the actual package script", { timeout: 900_000 }, () => {
    const root = packageJson();
    assert.equal(typeof root.scripts["release:evidence"], "string");
    const run = spawnSync(process.platform === "win32" ? "pnpm.exe" : "pnpm",
      ["--silent", "release:evidence"], {
        cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
        timeout: 840_000, windowsHide: true,
      });
    assert.equal(run.error, undefined);
    const record = JSON.parse(run.stdout.trim().split(/\r?\n/u).at(-1));
    if (process.platform !== "win32") {
      assert.equal(run.status, 1);
      expectReleaseRefusal(record, "SUPPORTED_OS_EVIDENCE_MISSING");
      return;
    }
    assert.equal(run.status, 0);
    assert.equal(record.componentCount, 6);
    assert.equal(record.reportCount, 3);
    assert.equal(record.sourceSha, SOURCE_SHA);
    assert.equal(record.operation, "RECORDED");
    assert.equal(record.releaseVerdict, "UNKNOWN");
    assert.equal(record.publicationAuthorized, false);
  });
});

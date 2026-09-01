import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { RELEASE_COMPONENTS } from "../../scripts/release/release-subject.mjs";
import {
  PACK_STEP_FAILED, PACK_TREE_ROOT_NOT_CANONICAL, PACK_TREE_SYMLINK,
  capturePackTreeIdentity, normalizedTreeSha256,
} from "../../tools/packaging/pack-tool-identity.ts";
import { normalizedPnpmPackageTreeSha256 } from "../../tools/packaging/pack-pnpm-package-identity.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SOURCE_SHA = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).trim();
const temporary = [];
const COMPONENT_IDS = Object.freeze(RELEASE_COMPONENTS.map((entry) => entry.componentId));

const temp = () => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "moe-release-test-")));
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
    resolvePnpmLaunch: spy(() => Object.freeze({
      file: process.execPath,
      prefixArgs: Object.freeze([join(REPO_ROOT, "node_modules", "pnpm", "bin", "pnpm.cjs")]),
    })),
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

  test("resolves one immutable pnpm launch for every release operation", async () => {
    const launch = Object.freeze({
      file: process.execPath,
      prefixArgs: Object.freeze([join(temp(), "pnpm.cjs")]),
    });
    const seen = [];
    const remember = (operation, answer) => spy(async (request) => {
      seen.push({ launch: request.pnpmLaunch, operation });
      return answer;
    });
    const ports = fakePorts({
      frozenInstall: remember("frozenInstall", { exitCode: 0, stderr: "", stdout: "" }),
      generateAudit: remember("generateAudit", {
        exitCode: 0, stderr: "", stdout: successfulEvidence().audit,
      }),
      generateLicenses: remember("generateLicenses", {
        exitCode: 0, stderr: "", stdout: successfulEvidence().licenses,
      }),
      observeTools: remember("observeTools", {
        cdxgen: "12.8.2", git: "2.51.0", node: "24.16.0", pnpm: "11.0.8", tar: "3.8.1",
      }),
      resolvePnpmLaunch: spy(() => launch),
    });

    const result = await runSupplyWithPorts(ports);

    assert.equal(result.ok, true);
    assert.equal(ports.resolvePnpmLaunch.calls.length, 1);
    assert.deepEqual(seen.map(({ operation }) => operation), [
      "observeTools", "frozenInstall", "generateAudit", "generateLicenses", "frozenInstall",
    ]);
    assert.equal(seen.every((entry) => entry.launch === launch), true);
    assert.equal(Object.isFrozen(launch), true);
    assert.equal(Object.isFrozen(launch.prefixArgs), true);
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

describe("release evidence containment", () => {
  test("escapesRoot refuses targets outside the root on every host", async () => {
    const { escapesRoot } = await loadSupplyChain();
    if (process.platform === "win32") {
      assert.equal(escapesRoot("C:\\node", "C:\\node\\corepack\\pnpm.js"), false);
      assert.equal(escapesRoot("C:\\node", "C:\\node\\..\\outside"), true);
      // win32 relative() across drives answers an ABSOLUTE path, which does not start with
      // "..", so the classic startsWith probe alone silently passes a cross-drive redirect.
      assert.equal(escapesRoot("C:\\node", "D:\\redirected\\pnpm.js"), true);
    } else {
      assert.equal(escapesRoot("/node", "/node/corepack/pnpm.js"), false);
      assert.equal(escapesRoot("/node", "/outside/pnpm.js"), true);
    }
  });

  test("tool and evidence containment consume the shared escape probe", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts/release/supply-chain.mjs"), "utf8");
    const runner = readFileSync(join(REPO_ROOT, "scripts/release/pnpm-runner.mjs"), "utf8");
    assert.match(runner, /escapesRoot\(descriptor\.destination, descriptor\.packageRoot\)/u);
    assert.match(runner, /escapesRoot\(descriptor\.packageRoot, descriptor\.entry\)/u);
    // Both containment call sites live in the pre-spawn identity check, and there are exactly
    // two: a third would be a second fence that makes weakening either one unobservable.
    assert.equal([...runner.matchAll(/if \(escapesRoot\(/gu)].length, 2);
    assert.match(source, /escapesRoot\(root, target\)/u);
    assert.match(source, /import \{ escapesRoot, resolveActionPnpm, runActionPnpm \} from "\.\/pnpm-runner\.mjs";/u);
    // One definition, two consumers: a second copy is how a containment fix lands on one side
    // of the release toolchain only.
    assert.equal([...`${source}\n${runner}`.matchAll(/function escapesRoot\(/gu)].length, 1);
    assert.doesNotMatch(source, /relative\([^)]*\)\.startsWith\("\.\."\)/u);
    assert.doesNotMatch(runner, /relative\([^)]*\)\.startsWith\("\.\."\)/u);
  });

  // Production's exact shape: evidenceRoot is <repo>/dist/release, dist/ is gitignored and so
  // plantable, and the junction's outside target really contains release/ — which pushes the
  // nearest-existing ceiling BELOW the junction, so the walk breaks before ever lstat'ing dist.
  // Raising the ceiling to the repository root (only when the evidence root sits inside it) puts
  // the dist seam inside the walked span. Cross-repository roots keep the near bound, which the
  // symlinked-ancestor accept cases above pin.
  test("refuses a junction at the repository dist seam that resolves to a real outside tree", async () => {
    const repositoryRoot = join(temp(), "repo");
    mkdirSync(repositoryRoot);
    const outside = temp();
    mkdirSync(join(outside, "release"));
    symlinkSync(outside, join(repositoryRoot, "dist"), "junction");
    const result = await runSupply({ evidenceRoot: join(repositoryRoot, "dist", "release"), repositoryRoot });
    expectReleaseRefusal(result, "OUTPUT_PATH_INVALID");
    assert.deepEqual(readdirSync(join(outside, "release")), []);
  });

  // Positive control for the raised ceiling: an honest repository-contained root, absent chain and
  // no links anywhere, must still publish — including the post-write re-guard walking the
  // directories the write itself just created under the FROZEN pre-write ceiling.
  test("publishes into a repository-contained evidence root whose span is real", async () => {
    const repositoryRoot = join(temp(), "repo");
    mkdirSync(repositoryRoot);
    const result = await runSupply({ evidenceRoot: join(repositoryRoot, "dist", "release"), repositoryRoot });
    assert.equal(result.reason, undefined);
    assert.equal(result.ok, true);
    assert.equal(existsSync(result.evidencePath), true);
    assert.equal(result.reused, false);
  });

  test("repository ceiling does not inspect a symlink above the repository root", async () => {
    const link = join(temp(), "ancestor");
    symlinkSync(temp(), link, "junction");
    const repositoryRoot = join(link, "repo");
    mkdirSync(repositoryRoot);
    const evidenceRoot = join(repositoryRoot, "dist", "release");
    const result = await runSupply({ evidenceRoot, repositoryRoot });
    assert.equal(result.reason, undefined);
    assert.equal(result.ok, true);
    assert.equal(existsSync(result.evidencePath), true);
  });

  test("re-guards with the pre-write ceiling after creating an absent root", async () => {
    const { publishEvidence } = await loadSupplyChain();
    const base = temp();
    const outside = temp();
    const seam = join(base, "seam");
    const evidenceRoot = join(seam, "release");
    const bytes = new TextEncoder().encode("frozen-ceiling-drill");
    const evidencePath = join(evidenceRoot, SOURCE_SHA, "digest", "evidence.json");
    const planted = [];
    const result = publishEvidence({ bytes, evidencePath, evidenceRoot }, {
      mkdirSync: (path, options) => {
        if (planted.length === 0) {
          symlinkSync(outside, seam, "junction");
          planted.push(seam);
        }
        return mkdirSync(path, options);
      },
    });
    assert.deepEqual(planted, [seam]);
    expectReleaseRefusal(result, "OUTPUT_PATH_INVALID");
    assert.equal(existsSync(join(outside, "release", SOURCE_SHA, "digest")), true);
    assert.equal(existsSync(join(outside, "release", SOURCE_SHA, "digest", "evidence.json")), false);
  });

  // The guard-to-write window is sub-millisecond, far below what any spawn-based race can hit, so
  // the drill injects at the only in-window seam: the first mkdir runs strictly AFTER the pre-write
  // guard passed. The write itself genuinely escapes through the junction — the trailing read-back
  // proves the window is real — and the post-write re-guard refuses to ADOPT the escaped bytes.
  test("re-guards after the write: a junction born in the guard-to-write window is refused", async () => {
    const { publishEvidence } = await loadSupplyChain();
    const evidenceRoot = temp();
    const outside = temp();
    const shaDir = join(evidenceRoot, SOURCE_SHA);
    const bytes = new TextEncoder().encode("in-window-drill");
    const planted = [];
    const result = publishEvidence({ bytes, evidencePath: join(shaDir, "digest", "evidence.json"), evidenceRoot }, {
      mkdirSync: (path, options) => {
        if (planted.length === 0) {
          symlinkSync(outside, shaDir, "junction");
          planted.push(shaDir);
        }
        return mkdirSync(path, options);
      },
    });
    assert.equal(planted.length, 1);
    expectReleaseRefusal(result, "OUTPUT_PATH_INVALID");
    // The window was real — the write escaped through the junction — and the escaped bytes are
    // OURS at this exit, so the refusal also unlinked them. The directory shell the rename created
    // proves the escape happened before cleanup.
    assert.equal(existsSync(join(outside, "digest")), true);
    assert.equal(existsSync(join(outside, "digest", "evidence.json")), false);
  });

  // Same window, third ok-exit: rename onto the junction-backed existing digest directory throws
  // EPERM, and the catch then reads the comparison bytes back THROUGH the junction — adopting
  // foreign-redirected content as reused evidence with zero bytes written locally. The catch must
  // re-guard before adopting.
  test("the interrupted-write catch re-guards before adopting bytes read through a junction", async () => {
    const { publishEvidence } = await loadSupplyChain();
    const evidenceRoot = temp();
    const outside = temp();
    const shaDir = join(evidenceRoot, SOURCE_SHA);
    const bytes = new TextEncoder().encode("catch-adoption-drill");
    mkdirSync(join(outside, "digest"), { recursive: true });
    writeFileSync(join(outside, "digest", "evidence.json"), bytes);
    const result = publishEvidence({ bytes, evidencePath: join(shaDir, "digest", "evidence.json"), evidenceRoot }, {
      mkdirSync: (path, options) => {
        if (!existsSync(shaDir)) symlinkSync(outside, shaDir, "junction");
        return mkdirSync(path, options);
      },
    });
    expectReleaseRefusal(result, "OUTPUT_PATH_INVALID");
    assert.equal(result.reused, undefined);
    // Unlike the fresh-write exit, the catch must LEAVE the bytes: from inside the catch they are
    // indistinguishable from a concurrent publisher's real evidence, and destroying that would
    // turn a containment refusal into data loss.
    assert.equal(readFileSync(join(outside, "digest", "evidence.json"), "utf8"), "catch-adoption-drill");
  });
});

describe("release package command", () => {
  const packageJson = () => JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

  test("resolves the pnpm/action-setup installation without assuming Corepack beside Node", async () => {
    const { resolvePnpmLaunch } = await loadSupplyChain();
    const { resolveActionPnpm } = await loadPnpmRunner();
    assert.equal(typeof resolvePnpmLaunch, "function");
    const layout = actionLayout();

    assert.equal(resolvePnpmLaunch(
      { PATH: "", PNPM_HOME: layout.binDirectory }, REPO_ROOT), undefined);
    const launch = resolveActionPnpm(
      { environment: { PATH: "", PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT },
      { expectedPackageTreeSha256: packageTreeDigest(layout), platform: "linux" },
    );

    assert.equal(launch.ok, true);
    assert.equal(launch.entry, layout.entry);
    assert.equal(launch.entry.startsWith(dirname(process.execPath)), false);
    assert.equal(Object.isFrozen(launch), true);
  });

  test("resolves the pinned pnpm 11 action entrypoint", async () => {
    const { resolvePnpmLaunch } = await loadSupplyChain();
    const { resolveActionPnpm } = await loadPnpmRunner();
    const pinned = actionLayout();
    const drifted = actionLayout({ version: "11.0.9" });

    assert.equal(packageJson().packageManager, `pnpm@${PNPM_PIN}`);
    assert.equal(packageJson().engines.pnpm, PNPM_PIN);
    assert.equal(resolvePnpmLaunch({ PNPM_HOME: pinned.binDirectory }, REPO_ROOT), undefined);
    const resolved = resolveActionPnpm(
      { environment: { PNPM_HOME: pinned.binDirectory }, repositoryRoot: REPO_ROOT },
      { expectedPackageTreeSha256: packageTreeDigest(pinned), platform: "linux" },
    );
    assert.equal(resolved.version, PNPM_PIN);
    assert.equal(resolvePnpmLaunch({ PNPM_HOME: drifted.binDirectory }, REPO_ROOT), undefined);
  });

  test("refuses a redirected action-installed pnpm package instead of falling back to PATH", async () => {
    const { resolvePnpmLaunch } = await loadSupplyChain();
    assert.equal(typeof resolvePnpmLaunch, "function");
    const layout = actionLayout();
    const outside = temp();
    mkdirSync(join(outside, "bin"), { recursive: true });
    writeFileSync(join(outside, "bin", "pnpm.cjs"), "#!/usr/bin/env node\n");
    writeFileSync(join(outside, "package.json"), JSON.stringify({
      bin: { pnpm: "bin/pnpm.cjs" }, name: "pnpm", version: PNPM_PIN,
    }));
    rmSync(layout.packageRoot, { force: true, recursive: true });
    symlinkSync(outside, layout.packageRoot, "junction");

    assert.equal(resolvePnpmLaunch({
      PATH: [dirname(process.execPath), layout.binDirectory].join(";"),
      PNPM_HOME: layout.binDirectory,
    }, REPO_ROOT), undefined);
  });

  test("runs pnpm through a validated action-installed entrypoint", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts/release/supply-chain.mjs"), "utf8");
    assert.equal([...source.matchAll(
      /resolvePnpmLaunch\(process\.env, String\(input\.repositoryRoot\)\)/gu,
    )].length, 1);
    assert.match(source, /runActionPnpm\(\{ args, cwd, descriptor: launch \}\)/u);
    assert.equal([...source.matchAll(/pnpmCommand\(request\.pnpmLaunch,/gu)].length, 4);
    assert.doesNotMatch(source, /node_modules["'], ["']corepack/u);
    // The doctor observed-key list names a report field, not an executable. Exempt exactly that
    // one declaration - and assert it is still present verbatim - so the PATH-resolution guard
    // stays a whole-file scan instead of being narrowed to a call-site pattern.
    const keyDeclaration =
      /const DOCTOR_OBSERVED_KEYS = Object\.freeze\(\["arch", "node", "platform", "pnpm"\]\);\n/u;
    assert.match(source, keyDeclaration);
    assert.doesNotMatch(source.replace(keyDeclaration, ""), /command\(["']pnpm(?:\.exe)?["']/u);
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

  /**
   * A package script may only name files that EXIST IN THE DELIVERED TREE. Checked against the
   * committed HEAD tree, never `existsSync`: a shared dirty worktree makes untracked WIP look
   * present, which is exactly how a `pack:windows` entrypoint absent from the commit shipped a
   * clean-checkout MODULE_NOT_FOUND. Staging is deliberately not enough — only committed bytes
   * are what a consumer checks out.
   */
  test("names only committed files in every package script, so a clean checkout can run them", () => {
    const root = packageJson();
    const tracked = new Set(
      execFileSync("git", ["ls-tree", "-r", "HEAD", "--name-only"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      })
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
    const referenced = [
      ...new Set(
        Object.values(root.scripts)
          .flatMap((command) => command.split(" "))
          .filter((token) => /^[\w./-]+\.(?:mjs|cjs|js|ts)$/u.test(token)),
      ),
    ];

    assert.ok(referenced.length > 0, "no package script named a source file");
    assert.deepEqual(
      referenced.filter((path) => !tracked.has(path)),
      [],
      "package scripts name files absent from the committed tree",
    );
  });

  test("records truthful evidence through the actual package script", { timeout: 900_000 }, async () => {
    const root = packageJson();
    // Run the package script's OWN argv rather than a pnpm the test located for itself: the
    // release supply chain is the only layer allowed to decide which pnpm is authority, and it
    // must reach that decision inside the run being measured.
    const script = root.scripts["release:evidence"];
    assert.equal(script, "node scripts/release/supply-chain.mjs --head");
    const { resolveActionPnpm } = await loadPnpmRunner();
    const resolved = resolveActionPnpm({ environment: process.env, repositoryRoot: REPO_ROOT });
    const run = spawnSync(process.execPath, script.split(" ").slice(1), {
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
    if (!resolved.ok) {
      assert.notEqual(process.env.MOE_REQUIRE_ACTION_PNPM, "1",
        "workflow-required action pnpm did not authenticate");
      // No pnpm/action-setup installation on this host. The recorder refuses by its own stable
      // code instead of adopting whichever pnpm happens to sit first on PATH.
      assert.equal(run.status, 1);
      expectReleaseRefusal(record, "TOOLCHAIN_OBSERVATION_FAILED");
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

const PNPM_PIN = "11.0.8";
const EXPECTED_RUNNER_CASES = 26;
let executedRunnerCases = 0;
const recordRunnerCase = () => { executedRunnerCases += 1; };

const loadPnpmRunner = () => import("../../scripts/release/pnpm-runner.mjs");

/** Bounded pnpm/action-setup destination: `<dest>/node_modules/.bin` plus the installed package. */
function actionLayout(options = {}) {
  return portableActionLayout(options);
}

const PORTABLE_SHIMS = Object.freeze([
  "node_modules/.bin/pn", "node_modules/.bin/pn.CMD",
  "node_modules/.bin/pnpm", "node_modules/.bin/pnpm.CMD",
  "node_modules/.bin/pnpx", "node_modules/.bin/pnpx.CMD",
  "node_modules/.bin/pnx", "node_modules/.bin/pnx.CMD",
]);

function destinationSpellings(destination) {
  const drive = /^([A-Za-z]):[\\/](.*)$/u.exec(destination);
  if (drive === null) return { cmd: destination, shell: destination.replaceAll("\\", "/") };
  return {
    cmd: destination.replaceAll("/", "\\"),
    shell: `/mnt/${drive[1].toLowerCase()}/${drive[2].replaceAll("\\", "/")}`,
  };
}

function portableShimBody(destination, path) {
  const roots = destinationSpellings(destination);
  const prefix = path.endsWith(".CMD") ? roots.cmd : roots.shell;
  return `${Array.from({ length: 8 }, (_unused, index) =>
    `NODE_PATH_${index}=${prefix}/node_modules/${index}`).join("\n")}\n`;
}

function portableActionLayout(options = {}) {
  const destination = options.destination ?? temp();
  const packageDestination = options.nested === true
    ? join(destination, "nested-authority") : destination;
  const nodeModules = join(destination, "node_modules");
  const packageRoot = join(packageDestination, "node_modules", ".pnpm",
    `pnpm@${options.storeVersion ?? PNPM_PIN}`, "node_modules", "pnpm");
  const binRelative = options.binRelative ?? "bin/pnpm.cjs";
  const entry = join(packageRoot, ...binRelative.split("/"));
  const binDirectory = join(nodeModules, ".bin");
  const mutable = join(packageRoot, "lib", "worker.js");
  mkdirSync(binDirectory, { recursive: true });
  if (options.packageRoot !== "absent") {
    mkdirSync(dirname(entry), { recursive: true });
    if (options.entry !== "absent") {
      writeFileSync(entry, options.entryBody ?? "#!/usr/bin/env node\n");
    }
    if (options.manifest !== "absent") {
      writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
        bin: options.bin ?? { pnpm: binRelative, pnpx: "bin/pnpx.cjs" },
        name: options.name ?? "pnpm", version: options.version ?? PNPM_PIN,
      }));
    }
    mkdirSync(dirname(mutable), { recursive: true });
    writeFileSync(mutable, "trusted-nonprefix-byte\n");
    for (const path of PORTABLE_SHIMS) {
      const absolute = join(packageRoot, ...path.split("/"));
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, portableShimBody(packageDestination, path));
    }
    symlinkSync(packageRoot, join(nodeModules, "pnpm"), "junction");
  }
  if (options.shim !== "absent") {
    writeFileSync(join(binDirectory, "pnpm.cmd"), "@echo off\r\n");
    writeFileSync(join(binDirectory, "pnpm"), "#!/bin/sh\n");
  }
  return { binDirectory, destination, entry, mutable, nodeModules, packageDestination, packageRoot };
}

function assertPortableDenominator(layout) {
  const tree = capturePackTreeIdentity(layout.packageRoot);
  const roster = tree.entries.filter((entry) => entry.kind === "file"
    && entry.path.startsWith("node_modules/.bin/")).map((entry) => entry.path);
  assert.deepEqual(roster, PORTABLE_SHIMS);
  let occurrences = 0;
  for (const path of roster) {
    const expected = path.endsWith(".CMD")
      ? destinationSpellings(layout.destination).cmd : destinationSpellings(layout.destination).shell;
    const body = readFileSync(join(layout.packageRoot, ...path.split("/")), "utf8");
    const count = body.split(expected).length - 1;
    assert.equal(count, 8, `${path} destination occurrence denominator`);
    occurrences += count;
  }
  assert.equal(roster.length, 8);
  assert.equal(occurrences, 64);
  return tree;
}

/** Repository version authority: root `packageManager` plus `engines.pnpm`. */
function repositoryAuthority(options = {}) {
  const root = temp();
  writeFileSync(join(root, "package.json"), JSON.stringify({
    engines: { node: ">=24.16.0 <25", pnpm: options.engines ?? PNPM_PIN },
    packageManager: options.packageManager ?? `pnpm@${PNPM_PIN}`,
  }));
  return root;
}

function execSpy(answer = { stderr: "", stdout: "" }) {
  const calls = [];
  const exec = async (file, args, execOptions) => {
    calls.push({ args, file, options: execOptions });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  exec.calls = calls;
  return exec;
}

function expectRunnerRefusal(result, forbidden, reason = "TOOLCHAIN_OBSERVATION_FAILED") {
  assert.equal(result.ok, false);
  assert.equal(result.code, "RELEASE_SUPPLY_CHAIN_REFUSED");
  assert.equal(result.reason, reason);
  assert.equal(result.refusedBy, "RELEASE_SUPPLY_CHAIN");
  assert.deepEqual(Object.keys(result).sort(), ["code", "ok", "reason", "refusedBy"]);
  const serialized = JSON.stringify(result);
  for (const secret of forbidden) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    assert.equal(serialized.includes(secret), false, `refusal leaked ${secret}`);
  }
}

const packageTreeDigest = (layout) =>
  normalizedPnpmPackageTreeSha256(capturePackTreeIdentity(layout.packageRoot), {
    actionDestination: layout.destination, pnpmVersion: PNPM_PIN,
  });

describe("pnpm runner tree authentication (task-861530ae, R3-12)", () => {
  test("R3-12-A refuses the reviewer's forged pnpm without executing it", async () => {
    const { resolveActionPnpm, runActionPnpm } = await loadPnpmRunner();
    const marker = "FORGED_PNPM_EXECUTED";
    const layout = actionLayout({
      entryBody: `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${marker}\n`)})\n`,
    });
    const request = {
      environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT,
    };

    expectRunnerRefusal(resolveActionPnpm(request, { platform: "linux" }), [],
      "TOOLCHAIN_IDENTITY_MISMATCH");
    const descriptor = Object.freeze({
      destination: layout.destination, entry: layout.entry, ok: true,
      packageRoot: layout.packageRoot,
      packageTreeSha256: "22c177c6e8cac54a8b26001b3b49390bd78dc6ecc15a3c9aac50869cf19b4cf7",
      shim: join(layout.binDirectory, "pnpm"), version: PNPM_PIN,
    });
    const exec = execSpy({ stderr: marker, stdout: marker });
    const result = await runActionPnpm(
      { args: ["--version"], cwd: layout.destination, descriptor }, { exec });

    assert.deepEqual(result, { exitCode: 1, stderr: "", stdout: "" });
    assert.equal(exec.calls.length, 0);
    assert.equal(`${result.stdout}${result.stderr}`.includes(marker), false);
  });

  test("R3-12-B binds every non-entry byte of an injected fixture tree", async () => {
    const { resolveActionPnpm } = await loadPnpmRunner();
    const layout = actionLayout();
    const nonEntry = join(layout.packageRoot, "lib", "worker.js");
    mkdirSync(dirname(nonEntry), { recursive: true });
    writeFileSync(nonEntry, "trusted-byte\n");
    const expectedPackageTreeSha256 = packageTreeDigest(layout);
    const request = {
      environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT,
    };
    const dependencies = { expectedPackageTreeSha256, platform: "linux" };

    assert.equal(resolveActionPnpm(request, dependencies).ok, true);
    const original = readFileSync(nonEntry);
    const altered = Buffer.from(original);
    altered[0] ^= 1;
    writeFileSync(nonEntry, altered);
    expectRunnerRefusal(resolveActionPnpm(request, dependencies), [],
      "TOOLCHAIN_IDENTITY_MISMATCH");
    writeFileSync(nonEntry, original);
    assert.equal(resolveActionPnpm(request, dependencies).ok, true);
  });

  test("R3-12-C keeps production runner calls off the injected digest seam", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts/release/supply-chain.mjs"), "utf8");
    assert.match(source, /resolveActionPnpm\(\{ environment, repositoryRoot \}\)/u);
    assert.match(source, /runActionPnpm\(\{ args, cwd, descriptor: launch \}\)/u);
    assert.doesNotMatch(source, /expectedPackageTreeSha256/u);
    assert.doesNotMatch(source, /captureTree/u);
  });

  test("R3-12-D refuses an equal-length equal-mtime swap before spawn", async () => {
    const { resolveActionPnpm, runActionPnpm } = await loadPnpmRunner();
    const layout = actionLayout();
    const nonEntry = join(layout.packageRoot, "lib", "worker.js");
    mkdirSync(dirname(nonEntry), { recursive: true });
    writeFileSync(nonEntry, "trusted-byte\n");
    const expectedPackageTreeSha256 = packageTreeDigest(layout);
    const resolved = resolveActionPnpm(
      { environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT },
      { expectedPackageTreeSha256, platform: "linux" },
    );
    assert.equal(resolved.ok, true);
    const original = readFileSync(nonEntry);
    const times = statSync(nonEntry);
    const altered = Buffer.from(original);
    altered[0] ^= 1;
    writeFileSync(nonEntry, altered);
    utimesSync(nonEntry, times.atime, times.mtime);
    const exec = execSpy({ stderr: "", stdout: `${PNPM_PIN}\n` });

    assert.deepEqual(await runActionPnpm(
      { args: ["--version"], cwd: layout.destination, descriptor: resolved }, { exec }),
    { exitCode: 1, stderr: "", stdout: "" });
    assert.equal(exec.calls.length, 0);
    writeFileSync(nonEntry, original);
    utimesSync(nonEntry, times.atime, times.mtime);
    assert.equal((await runActionPnpm(
      { args: ["--version"], cwd: layout.destination, descriptor: resolved }, { exec })).exitCode, 0);
    assert.equal(exec.calls.length, 1);
  });

  test("R3-12-S keeps a symlinked tree entry distinct from digest mismatches", async () => {
    const { resolveActionPnpm } = await loadPnpmRunner();
    const layout = actionLayout();
    const outside = join(temp(), "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "outside.js"), "outside\n");
    symlinkSync(outside, join(layout.packageRoot, "linked"), "junction");

    expectRunnerRefusal(resolveActionPnpm({
      environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT,
    }, { expectedPackageTreeSha256: "0".repeat(64), platform: "linux" }), [],
    "TOOLCHAIN_OBSERVATION_FAILED");
  });
});

describe("action-installed pnpm runner", () => {
  test("normalizes only the exact action-copy shim prefixes across install roots", async () => {
    const { resolveActionPnpm } = await loadPnpmRunner();
    const left = portableActionLayout({ destination: join(temp(), "a") });
    const right = portableActionLayout({
      destination: join(temp(), "copy-destination-with-a-longer-name"),
    });
    const leftTree = assertPortableDenominator(left);
    const rightTree = assertPortableDenominator(right);

    assert.notEqual(left.destination.length, right.destination.length);
    assert.notEqual(normalizedTreeSha256(leftTree), normalizedTreeSha256(rightTree));
    const portable = normalizedPnpmPackageTreeSha256(leftTree, {
      actionDestination: left.destination, pnpmVersion: PNPM_PIN,
    });
    assert.equal(normalizedPnpmPackageTreeSha256(rightTree, {
      actionDestination: right.destination, pnpmVersion: PNPM_PIN,
    }), portable);
    const resolved = resolveActionPnpm({
      environment: { PNPM_HOME: right.binDirectory }, repositoryRoot: REPO_ROOT,
    }, { expectedPackageTreeSha256: portable, platform: "win32" });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.packageTreeSha256, portable);
    recordRunnerCase();
  });

  test("distinguishes malformed shim evidence from a package digest mismatch", async () => {
    const { resolveActionPnpm } = await loadPnpmRunner();
    const hardlinked = portableActionLayout();
    assertPortableDenominator(hardlinked);
    linkSync(hardlinked.mutable, join(hardlinked.packageRoot, "lib", "linked-worker.js"));
    expectRunnerRefusal(resolveActionPnpm({
      environment: { PNPM_HOME: hardlinked.binDirectory }, repositoryRoot: REPO_ROOT,
    }, { expectedPackageTreeSha256: "0".repeat(64), platform: "win32" }), [],
    "TOOLCHAIN_OBSERVATION_FAILED");

    const cases = [
      ["missing", (layout) => rmSync(join(layout.packageRoot, ...PORTABLE_SHIMS[0].split("/")))],
      ["extra", (layout) => writeFileSync(
        join(layout.packageRoot, "node_modules", ".bin", "extra"), "extra\n")],
      ["foreign-prefix", (layout) => {
        const path = join(layout.packageRoot, "node_modules", ".bin", "pnpm.CMD");
        const foreign = process.platform === "win32" ? "Z:\\foreign-root" : "/opt/foreign-root";
        writeFileSync(path, `${readFileSync(path, "utf8")}FOREIGN_NODE_PATH=${foreign}/lib\n`);
      }],
      ["invalid-utf8", (layout) => {
        const path = join(layout.packageRoot, "node_modules", ".bin", "pnpm.CMD");
        writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from([0xff])]));
      }],
    ];
    let executed = 0;
    for (const [name, mutate] of cases) {
      const layout = portableActionLayout();
      assertPortableDenominator(layout);
      mutate(layout);
      const expectedPackageTreeSha256 = normalizedTreeSha256(
        capturePackTreeIdentity(layout.packageRoot));
      expectRunnerRefusal(resolveActionPnpm({
        environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT,
      }, { expectedPackageTreeSha256, platform: "win32" }), [name],
      "TOOLCHAIN_OBSERVATION_FAILED");
      executed += 1;
    }
    assert.equal(cases.length, 4);
    assert.equal(executed, 4);
    recordRunnerCase();
  });

  test("refuses a direct package root before resolution or spawn", async () => {
    const { resolveActionPnpm, runActionPnpm } = await loadPnpmRunner();
    const layout = portableActionLayout();
    const portable = normalizedPnpmPackageTreeSha256(assertPortableDenominator(layout), {
      actionDestination: layout.destination, pnpmVersion: PNPM_PIN,
    });
    const directRoot = join(layout.nodeModules, "pnpm");
    rmSync(directRoot);
    renameSync(layout.packageRoot, directRoot);
    const entry = join(directRoot, "bin", "pnpm.cjs");
    const descriptor = Object.freeze({
      destination: layout.destination, entry, ok: true, packageRoot: directRoot,
      packageTreeSha256: portable, shim: join(layout.binDirectory, "pnpm.cmd"), version: PNPM_PIN,
    });

    expectRunnerRefusal(resolveActionPnpm({
      environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT,
    }, { expectedPackageTreeSha256: portable, platform: "win32" }), [],
    "TOOLCHAIN_OBSERVATION_FAILED");
    const exec = execSpy();
    assert.deepEqual(await runActionPnpm({
      args: ["--version"], cwd: layout.destination, descriptor,
    }, { exec }), { exitCode: 1, stderr: "", stdout: "" });
    assert.equal(exec.calls.length, 0);
    recordRunnerCase();
  });

  test("binds portable identity to the exact action destination and repository version", async () => {
    const { resolveActionPnpm, runActionPnpm } = await loadPnpmRunner();
    const canonical = portableActionLayout();
    const expectedPackageTreeSha256 = packageTreeDigest(canonical);
    const fixtures = [
      ["nested-root", portableActionLayout({ nested: true })],
      ["wrong-store-label", portableActionLayout({ storeVersion: "99.0.0" })],
    ];
    let executed = 0;

    for (const [name, layout] of fixtures) {
      const request = {
        environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT,
      };
      expectRunnerRefusal(resolveActionPnpm(request, {
        expectedPackageTreeSha256, platform: "win32",
      }), [name], "TOOLCHAIN_OBSERVATION_FAILED");
      const descriptor = Object.freeze({
        destination: layout.destination, entry: layout.entry, ok: true,
        packageRoot: layout.packageRoot, packageTreeSha256: expectedPackageTreeSha256,
        shim: join(layout.binDirectory, "pnpm.cmd"), version: PNPM_PIN,
      });
      const exec = execSpy();
      assert.deepEqual(await runActionPnpm({
        args: ["--version"], cwd: layout.destination, descriptor,
      }, { exec }), { exitCode: 1, stderr: "", stdout: "" });
      assert.equal(exec.calls.length, 0);
      executed += 1;
    }
    assert.equal(fixtures.length, 2);
    assert.equal(executed, 2);
    recordRunnerCase();
  });

  test("refuses an entry swap after the authenticated capture and before spawn", async () => {
    const { resolveActionPnpm, runActionPnpm } = await loadPnpmRunner();
    const layout = portableActionLayout();
    const expectedPackageTreeSha256 = packageTreeDigest(layout);
    const request = {
      environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT,
    };
    const original = readFileSync(layout.entry);
    const forged = Buffer.from(original);
    forged[0] ^= 1;
    let captures = 0;
    const captureTree = (root) => {
      const snapshot = capturePackTreeIdentity(root);
      captures += 1;
      if (captures === 1) writeFileSync(layout.entry, forged);
      return snapshot;
    };

    expectRunnerRefusal(resolveActionPnpm(request, {
      captureTree, expectedPackageTreeSha256, platform: "win32",
    }), [], "TOOLCHAIN_IDENTITY_MISMATCH");
    assert.equal(captures, 2);
    writeFileSync(layout.entry, original);
    const resolved = resolveActionPnpm(request, { expectedPackageTreeSha256, platform: "win32" });
    assert.equal(resolved.ok, true);
    captures = 0;
    const exec = execSpy();
    assert.deepEqual(await runActionPnpm({
      args: ["--version"], cwd: layout.destination, descriptor: resolved,
    }, { captureTree, exec }), { exitCode: 1, stderr: "", stdout: "" });
    assert.equal(captures, 2);
    assert.equal(exec.calls.length, 0);
    recordRunnerCase();
  });

  test("refuses non-prefix drift before resolving or spawning the action entry", async () => {
    const { resolveActionPnpm, runActionPnpm } = await loadPnpmRunner();
    const layout = portableActionLayout();
    const expectedPackageTreeSha256 = normalizedPnpmPackageTreeSha256(
      assertPortableDenominator(layout), {
        actionDestination: layout.destination, pnpmVersion: PNPM_PIN,
      });
    const request = {
      environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT,
    };
    const resolved = resolveActionPnpm(request, {
      expectedPackageTreeSha256, platform: "win32",
    });
    assert.equal(resolved.ok, true);
    const bytes = readFileSync(layout.mutable);
    bytes[0] ^= 1;
    writeFileSync(layout.mutable, bytes);

    expectRunnerRefusal(resolveActionPnpm(request, {
      expectedPackageTreeSha256, platform: "win32",
    }), [], "TOOLCHAIN_IDENTITY_MISMATCH");
    const exec = execSpy();
    assert.deepEqual(await runActionPnpm({
      args: ["--version"], cwd: layout.destination, descriptor: resolved,
    }, { exec }), { exitCode: 1, stderr: "", stdout: "" });
    assert.equal(exec.calls.length, 0);
    recordRunnerCase();
  });

  test("resolves a Linux runner layout with pnpm installed outside the Node installation", async () => {
    const { resolveActionPnpm } = await loadPnpmRunner();
    const layout = actionLayout();
    assert.equal(layout.packageRoot.startsWith(dirname(process.execPath)), false);

    const resolved = resolveActionPnpm(
      { environment: { PATH: "", PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT },
      { expectedPackageTreeSha256: packageTreeDigest(layout), platform: "linux" },
    );

    assert.equal(resolved.ok, true);
    assert.equal(resolved.entry, layout.entry);
    assert.equal(resolved.packageRoot, layout.packageRoot);
    assert.equal(resolved.shim, join(layout.binDirectory, "pnpm"));
    assert.equal(resolved.version, PNPM_PIN);
    assert.equal(Object.isFrozen(resolved), true);
    recordRunnerCase();
  });

  test("resolves a Windows runner layout through the .cmd shim without executing it", async () => {
    const { resolveActionPnpm } = await loadPnpmRunner();
    const layout = actionLayout();

    const resolved = resolveActionPnpm(
      { environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT },
      { expectedPackageTreeSha256: packageTreeDigest(layout), platform: "win32" },
    );

    assert.equal(resolved.ok, true);
    assert.equal(resolved.shim, join(layout.binDirectory, "pnpm.cmd"));
    assert.equal(resolved.entry, layout.entry);
    assert.match(resolved.entry, /\.cjs$/u);
    recordRunnerCase();
  });

  test("resolves a regular POSIX shim carrying no executable bit, and never spawns it", async () => {
    const { resolveActionPnpm, runActionPnpm } = await loadPnpmRunner();
    const layout = actionLayout();
    const exec = execSpy();

    const resolved = resolveActionPnpm(
      { environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT },
      { expectedPackageTreeSha256: packageTreeDigest(layout), platform: "linux" },
    );
    assert.equal(resolved.ok, true);
    await runActionPnpm({ args: ["--version"], cwd: REPO_ROOT, descriptor: resolved }, { exec });

    assert.equal(exec.calls.length, 1);
    assert.equal(exec.calls[0].file, process.execPath);
    assert.equal(exec.calls[0].args.includes(resolved.shim), false);
    recordRunnerCase();
  });

  test("resolves an internally contained symlinked package root", async () => {
    const { resolveActionPnpm } = await loadPnpmRunner();
    const layout = actionLayout();
    const visiblePackageRoot = join(layout.nodeModules, "pnpm");
    assert.equal(lstatSync(visiblePackageRoot).isSymbolicLink(), true);

    const resolved = resolveActionPnpm(
      { environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT },
      { expectedPackageTreeSha256: packageTreeDigest(layout), platform: "linux" },
    );

    assert.equal(resolved.ok, true);
    assert.equal(resolved.packageRoot, layout.packageRoot);
    assert.equal(resolved.entry, layout.entry);
    recordRunnerCase();
  });

  test("refuses a missing or empty PNPM_HOME without consulting PATH", async () => {
    const { resolveActionPnpm } = await loadPnpmRunner();
    const layout = actionLayout();
    const request = { environment: { PATH: layout.binDirectory }, repositoryRoot: REPO_ROOT };

    expectRunnerRefusal(resolveActionPnpm(request, { platform: "linux" }), [layout.binDirectory]);
    expectRunnerRefusal(
      resolveActionPnpm({ ...request, environment: { PNPM_HOME: "" } }, { platform: "linux" }),
      [layout.binDirectory],
    );
    recordRunnerCase();
  });

  test("refuses a PNPM_HOME that is not the action node_modules/.bin destination", async () => {
    const { resolveActionPnpm } = await loadPnpmRunner();
    const layout = actionLayout();
    const foreign = join(layout.destination, "bin");
    mkdirSync(foreign, { recursive: true });

    // A COMPLETE install one directory away from `node_modules`: everything below PNPM_HOME is
    // valid, so only the install-directory half of the layout check can refuse it.
    const sibling = join(layout.destination, "tools");
    mkdirSync(join(sibling, ".bin"), { recursive: true });
    mkdirSync(join(sibling, "pnpm", "bin"), { recursive: true });
    writeFileSync(join(sibling, ".bin", "pnpm"), "#!/bin/sh\n");
    writeFileSync(join(sibling, "pnpm", "bin", "pnpm.cjs"), "#!/usr/bin/env node\n");
    writeFileSync(join(sibling, "pnpm", "package.json"), JSON.stringify({
      bin: { pnpm: "bin/pnpm.cjs" }, name: "pnpm", version: PNPM_PIN,
    }));

    // The mirror case: inside `node_modules`, complete install below it, but NOT the `.bin`
    // directory the action publishes - so only the `.bin` half of the layout check can refuse it.
    const shims = join(layout.nodeModules, "shims");
    mkdirSync(shims, { recursive: true });
    writeFileSync(join(shims, "pnpm"), "#!/bin/sh\n");

    for (const home of [foreign, layout.destination, layout.packageRoot, "relative/.bin", join(sibling, ".bin"), shims]) {
      expectRunnerRefusal(
        resolveActionPnpm({ environment: { PNPM_HOME: home }, repositoryRoot: REPO_ROOT }, { platform: "linux" }),
        [home],
      );
    }
    recordRunnerCase();
  });

  test("refuses when the host-appropriate action shim is missing", async () => {
    const { resolveActionPnpm } = await loadPnpmRunner();
    const layout = actionLayout({ shim: "absent" });
    const request = { environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT };

    expectRunnerRefusal(resolveActionPnpm(request, { platform: "linux" }), [layout.entry]);
    expectRunnerRefusal(resolveActionPnpm(request, { platform: "win32" }), [layout.entry]);
    recordRunnerCase();
  });

  test("refuses a missing installed manifest", async () => {
    const { resolveActionPnpm } = await loadPnpmRunner();
    const layout = actionLayout({ manifest: "absent" });

    expectRunnerRefusal(
      resolveActionPnpm({ environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT }, { platform: "linux" }),
      [layout.packageRoot],
    );
    recordRunnerCase();
  });

  test("refuses a foreign package name in the installed manifest", async () => {
    const { resolveActionPnpm } = await loadPnpmRunner();
    const layout = actionLayout({ name: "pnpm-impostor" });

    expectRunnerRefusal(
      resolveActionPnpm({ environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT }, { platform: "linux" }),
      ["pnpm-impostor", layout.packageRoot],
    );
    recordRunnerCase();
  });

  test("refuses a missing verified entry target", async () => {
    const { resolveActionPnpm } = await loadPnpmRunner();
    const layout = actionLayout({ entry: "absent" });

    expectRunnerRefusal(
      resolveActionPnpm({ environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT }, { platform: "linux" }),
      [layout.entry],
    );
    recordRunnerCase();
  });

  test("refuses an external symlinked package root or entry target", async () => {
    const { resolveActionPnpm } = await loadPnpmRunner();
    const outside = temp();
    const layout = actionLayout();
    rmSync(layout.packageRoot, { force: true, recursive: true });
    mkdirSync(join(outside, "bin"), { recursive: true });
    writeFileSync(join(outside, "bin", "pnpm.cjs"), "#!/usr/bin/env node\n");
    writeFileSync(join(outside, "package.json"), JSON.stringify({
      bin: { pnpm: "bin/pnpm.cjs" }, name: "pnpm", version: PNPM_PIN,
    }));
    symlinkSync(outside, layout.packageRoot, "junction");

    expectRunnerRefusal(
      resolveActionPnpm({ environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT }, { platform: "linux" }),
      [outside],
    );
    recordRunnerCase();
  });

  test("refuses a bin map that traverses or escapes the installed package root", async () => {
    const { resolveActionPnpm } = await loadPnpmRunner();
    const outside = temp();
    writeFileSync(join(outside, "pnpm.cjs"), "#!/usr/bin/env node\n");
    const maps = [{ pnpm: "../../escape.cjs" }, { pnpm: join(outside, "pnpm.cjs") }, { pnpx: "bin/pnpx.cjs" }, "bin/pnpm.cjs"];
    for (const bin of maps) {
      const layout = actionLayout();
      writeFileSync(join(layout.destination, "escape.cjs"), "#!/usr/bin/env node\n");
      writeFileSync(join(layout.packageRoot, "package.json"), JSON.stringify({ bin, name: "pnpm", version: PNPM_PIN }));
      expectRunnerRefusal(
        resolveActionPnpm({ environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT }, { platform: "linux" }),
        [outside, layout.packageRoot],
      );
    }
    assert.equal(maps.length, 4);
    // A present, contained, NON-JavaScript target: only the entrypoint-kind check can refuse it.
    const shellEntry = actionLayout({ binRelative: "bin/pnpm.sh" });
    expectRunnerRefusal(
      resolveActionPnpm({ environment: { PNPM_HOME: shellEntry.binDirectory }, repositoryRoot: REPO_ROOT }, { platform: "linux" }),
      [shellEntry.entry],
    );
    recordRunnerCase();
  });

  test("refuses when repository packageManager and engines.pnpm disagree", async () => {
    const { resolveActionPnpm } = await loadPnpmRunner();
    const layout = actionLayout();
    const authorities = [{ engines: "11.0.7" }, { packageManager: "pnpm@11.0.9" }, { packageManager: "yarn@4.0.0" }, { packageManager: "pnpm" }];
    for (const authority of authorities) {
      const repositoryRoot = repositoryAuthority(authority);
      expectRunnerRefusal(
        resolveActionPnpm({ environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot }, { platform: "linux" }),
        [repositoryRoot, "11.0.7", "11.0.9"],
      );
    }
    assert.equal(authorities.length, 4);
    recordRunnerCase();
  });

  test("refuses an installed version that drifts from the repository pin", async () => {
    const { resolveActionPnpm } = await loadPnpmRunner();
    const repositoryRoot = repositoryAuthority();
    const versions = ["11.0.9", "10.0.8", "", "11.0.8-rc.1"];
    for (const version of versions) {
      const layout = actionLayout({ version });
      expectRunnerRefusal(
        resolveActionPnpm({ environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot }, { platform: "linux" }),
        [version, layout.entry],
      );
    }
    assert.equal(versions.length, 4);
    const missingRoot = temp();
    expectRunnerRefusal(
      resolveActionPnpm({ environment: { PNPM_HOME: actionLayout().binDirectory }, repositoryRoot: missingRoot }, { platform: "linux" }),
      [missingRoot],
    );
    recordRunnerCase();
  });

  test("executes the verified entry with process.execPath, safe argv, and shell:false", async () => {
    const { resolveActionPnpm, runActionPnpm } = await loadPnpmRunner();
    const layout = actionLayout();
    const exec = execSpy({ stderr: "warn", stdout: `${PNPM_PIN}\n` });
    const resolved = resolveActionPnpm(
      { environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT },
      { expectedPackageTreeSha256: packageTreeDigest(layout), platform: "win32" },
    );
    const callerArgs = ["install", "--frozen-lockfile", "--dir", "C:\\path with space & ^cmd"];

    const result = await runActionPnpm({ args: callerArgs, cwd: layout.destination, descriptor: resolved }, { exec });

    assert.deepEqual(result, { exitCode: 0, stderr: "warn", stdout: `${PNPM_PIN}\n` });
    assert.equal(exec.calls.length, 1);
    assert.equal(exec.calls[0].file, process.execPath);
    assert.deepEqual(exec.calls[0].args, [layout.entry, ...callerArgs]);
    assert.deepEqual(exec.calls[0].options, {
      cwd: layout.destination, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      shell: false, timeout: 180_000, windowsHide: true,
    });
    recordRunnerCase();
  });

  test("re-validates the entry immediately before spawn and refuses a swapped target", async () => {
    const { resolveActionPnpm, runActionPnpm } = await loadPnpmRunner();
    const layout = actionLayout();
    const exec = execSpy();
    const resolved = resolveActionPnpm(
      { environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT },
      { expectedPackageTreeSha256: packageTreeDigest(layout), platform: "linux" },
    );
    assert.equal(resolved.ok, true);
    rmSync(layout.entry, { force: true });

    const result = await runActionPnpm({ args: ["--version"], cwd: layout.destination, descriptor: resolved }, { exec });

    assert.deepEqual(result, { exitCode: 1, stderr: "", stdout: "" });
    assert.equal(exec.calls.length, 0);
    recordRunnerCase();
  });

  test("maps a bounded child failure to a command result without leaking the raw error", async () => {
    const { resolveActionPnpm, runActionPnpm } = await loadPnpmRunner();
    const layout = actionLayout();
    const failure = Object.assign(new Error(`spawn failed for ${layout.entry} TOKEN_SECRET`), {
      code: 7, stderr: "child stderr", stdout: "child stdout",
    });
    const resolved = resolveActionPnpm(
      { environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT },
      { expectedPackageTreeSha256: packageTreeDigest(layout), platform: "linux" },
    );

    const result = await runActionPnpm(
      { args: ["install"], cwd: layout.destination, descriptor: resolved },
      { exec: execSpy(failure) },
    );

    assert.deepEqual(result, { exitCode: 7, stderr: "child stderr", stdout: "child stdout" });
    for (const nonNumeric of [undefined, "ENOENT", null]) {
      const mapped = await runActionPnpm(
        { args: ["install"], cwd: layout.destination, descriptor: resolved },
        { exec: execSpy(Object.assign(new Error("boom"), { code: nonNumeric })) },
      );
      assert.equal(mapped.exitCode, 1);
      assert.equal(mapped.stdout, "");
      assert.equal(mapped.stderr, "");
    }
    recordRunnerCase();
  });

  test("refuses a malformed request instead of throwing a raw error past the layer", async () => {
    const { resolveActionPnpm, runActionPnpm } = await loadPnpmRunner();
    const layout = actionLayout();
    const exec = execSpy();
    const resolved = resolveActionPnpm(
      { environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot: REPO_ROOT },
      { expectedPackageTreeSha256: packageTreeDigest(layout), platform: "linux" },
    );
    assert.equal(resolved.ok, true);

    for (const request of [{}, { repositoryRoot: REPO_ROOT }, { environment: null, repositoryRoot: REPO_ROOT },
      { environment: { PNPM_HOME: layout.binDirectory } }, { environment: { PNPM_HOME: layout.binDirectory }, repositoryRoot: "" }]) {
      expectRunnerRefusal(resolveActionPnpm(request, { platform: "linux" }), [layout.binDirectory]);
    }
    for (const request of [{ cwd: REPO_ROOT, descriptor: resolved }, { args: ["--version"], descriptor: resolved },
      { args: "--version", cwd: REPO_ROOT, descriptor: resolved }, { args: [], cwd: REPO_ROOT }]) {
      assert.deepEqual(await runActionPnpm(request, { exec }), { exitCode: 1, stderr: "", stdout: "" });
    }
    assert.equal(exec.calls.length, 0);
    recordRunnerCase();
  });

  test("leaves the release recorder owning the refusal when no action pnpm resolves", async () => {
    const ports = fakePorts({ resolvePnpmLaunch: spy(() => undefined) });

    const result = await runSupplyWithPorts(ports);

    expectReleaseRefusal(result, "TOOLCHAIN_OBSERVATION_FAILED");
    assert.equal(ports.resolvePnpmLaunch.calls.length, 1);
    assert.equal(ports.observeTools.calls.length, 0);
    assert.equal(ports.frozenInstall.calls.length, 0);
    recordRunnerCase();
  });

  test("keeps every release pnpm call site on the verified runner with no PATH or Corepack fallback", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts/release/supply-chain.mjs"), "utf8");
    const runner = readFileSync(join(REPO_ROOT, "scripts/release/pnpm-runner.mjs"), "utf8");
    assert.match(source, /from "\.\/pnpm-runner\.mjs";/u);
    assert.match(source, /resolveActionPnpm/u);
    assert.equal([...source.matchAll(/pnpmCommand\(request\.pnpmLaunch,/gu)].length, 4);
    assert.doesNotMatch(source, /corepack/u);
    assert.doesNotMatch(source, /delimiter/u);
    assert.doesNotMatch(runner, /corepack/u);
    assert.doesNotMatch(runner, /\bdelimiter\b/u);
    assert.doesNotMatch(runner, /environment\.PATH/u);
    assert.match(runner, /shell: false/u);
    recordRunnerCase();
  });

  test("pins the release typecheck file list to the runner module and counts every runner case", () => {
    const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    assert.match(root.scripts["typecheck:release"], /scripts\/release\/pnpm-runner\.mjs/u);
    assert.match(root.scripts["typecheck:release"], /scripts\/release\/supply-chain\.mjs/u);
    assert.match(root.scripts["typecheck:release"], /scripts\/release\/release-subject\.mjs/u);
    assert.ok(executedRunnerCases > 0, "no action-installed pnpm runner cases executed");
    assert.equal(executedRunnerCases, EXPECTED_RUNNER_CASES);
    recordRunnerCase();
  });
});

/**
 * task-b80f181d (R3-11). `capturePackTreeIdentity` used to demand an already-canonical root,
 * which no macOS caller can supply: `os.tmpdir()` answers `/var/folders/...` whose realpath is
 * `/private/var/folders/...`, so the walk refused before reading a single dirent and darkened
 * the whole `portability-evidence (macos-latest)` lane. These arms drive the PRODUCTION function
 * and assert its refusal codes by IDENTITY off `error.reason`, never by matching message prose.
 *
 * The symlink is created with the `"junction"` type, which Windows accepts without elevation and
 * every other platform ignores, so all three arms run on win32 and POSIX alike - no arm is pinned
 * or skipped, and `lstatSync().isSymbolicLink()` is true for a junction on Windows too.
 */
describe("pack tree identity root canonicalization (task-b80f181d, R3-11)", () => {
  test("R3-11-A walks a root reached through a symlink and records the canonical path", () => {
    const base = temp();
    const real = join(base, "real");
    mkdirSync(join(real, "sub"), { recursive: true });
    writeFileSync(join(real, "sub", "a.txt"), "a");
    const link = join(base, "link");
    symlinkSync(real, link, "junction");
    assert.notEqual(link, realpathSync(link));

    let captured = null;
    let tree = null;
    try {
      tree = capturePackTreeIdentity(link);
    } catch (error) {
      captured = error;
    }
    assert.equal(captured?.reason ?? null, null,
      `refused a symlinked root with ${captured?.reason} (${captured?.subject})`);
    assert.notEqual(captured?.reason, PACK_TREE_ROOT_NOT_CANONICAL);
    assert.equal(tree.root, realpathSync(real));
    assert.deepEqual(tree.entries.map((entry) => entry.path), [".", "sub", "sub/a.txt"]);
    assert.equal(normalizedTreeSha256(tree),
      normalizedTreeSha256(capturePackTreeIdentity(real)));
  });

  test("R3-11-B still refuses a symlink INSIDE the tree, naming code and path", () => {
    const base = temp();
    const root = join(base, "root");
    const outside = join(base, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, "kept.txt"), "kept");
    symlinkSync(outside, join(root, "linked"), "junction");

    assert.throws(() => capturePackTreeIdentity(root), (error) => {
      assert.equal(error.reason, PACK_TREE_SYMLINK);
      assert.equal(error.subject, join(realpathSync(root), "linked"));
      assert.equal(error.message.startsWith(PACK_STEP_FAILED), true);
      return true;
    });
  });

  test("R3-11-C canonicalizing the root does not start accepting a missing root", () => {
    assert.throws(() => capturePackTreeIdentity(join(temp(), "absent")), (error) => {
      assert.equal(error.reason, undefined);
      assert.equal(error.message, `${PACK_STEP_FAILED}: tool identity unavailable`);
      return true;
    });
  });
});

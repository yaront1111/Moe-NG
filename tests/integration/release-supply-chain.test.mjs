import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SOURCE_SHA = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).trim();
const temporary = [];

const temp = () => {
  const path = mkdtempSync(join(tmpdir(), "moe-release-test-"));
  temporary.push(path);
  return path;
};

afterEach(() => {
  while (temporary.length > 0) rmSync(temporary.pop(), { force: true, recursive: true });
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
    assert.equal(RELEASE_COMPONENTS.length, 5);
    assert.equal(RELEASE_TEMPLATES.length, 3);
    assert.equal(RELEASE_COMPONENTS.every((entry) => entry.assets.length > 0), true);

    const first = await buildSubject({ privateKey });
    assert.equal(first.ok, true);
    const second = await buildSubject({ privateKey });
    assert.equal(first.componentCount, 5);
    assert.equal(first.templateCount, 3);
    assert.equal(first.verificationKeyUse, "EPHEMERAL_VERIFICATION_ONLY");
    assert.equal(Object.hasOwn(first, "verificationPrivateKey"), false);
    assert.match(first.receipt.verificationKey.publicKeyHex, /^[0-9a-f]{64}$/u);
    assert.equal(first.containers.length, 5);
    assert.equal(first.receipt.admittedComponentIds.length, 5);
    assert.equal(first.receipt.compatibleComponentIds.length, 5);
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
      componentCount: 5,
      containers: ["daemon", "control-room", "mcp-bridge", "provider-claude", "provider-codex"]
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
        admittedComponentIds: ["control-room", "daemon", "mcp-bridge", "provider-claude", "provider-codex"],
        compatibleComponentIds: ["control-room", "daemon", "mcp-bridge", "provider-claude", "provider-codex"],
        launchReceipts: [{ componentId: "daemon", physicallyLaunched: false }],
        verificationKey: { keyId: "ephemeral-release-test", publicKeyHex: "ab".repeat(32) },
      },
      source: { objectFormat: "sha1", sourceSha: SOURCE_SHA },
      templateCount: 3,
      verificationKeyUse: "EPHEMERAL_VERIFICATION_ONLY",
      buildIndex,
    })),
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

async function runSupply(overrides = {}, portOverrides = {}) {
  const { runReleaseSupplyChain } = await loadSupplyChain();
  return runReleaseSupplyChain({
    evidenceRoot: temp(),
    platform: "win32",
    repositoryRoot: REPO_ROOT,
    source: { objectFormat: "sha1", sourceSha: SOURCE_SHA },
    ...overrides,
  }, fakePorts(portOverrides));
}

describe("release supply-chain evidence", () => {
  test("records Windows and keeps unsupported and unavailable evidence UNKNOWN", async () => {
    const result = await runSupply();
    assert.equal(result.ok, true);
    assert.equal(result.evidence.buildCount, 2);
    assert.equal(result.evidence.componentCount, 5);
    assert.equal(result.evidence.templateCount, 3);
    assert.deepEqual(result.evidence.source, { objectFormat: "sha1", sourceSha: SOURCE_SHA });
    assert.equal(result.evidence.operation, "RECORDED");
    assert.equal(result.evidence.releaseVerdict, "UNKNOWN");
    assert.equal(result.evidence.publicationAuthorized, false);
    assert.deepEqual(result.evidence.doctor, {
      missingSymbol: "@moe/daemon.collectDoctorVersionReport",
      reason: "DOCTOR_COMPATIBILITY_UNAVAILABLE",
      status: "UNKNOWN",
    });
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
      ["/metadata/timestamp", "/serialNumber"]);
    assert.deepEqual(result.evidence.builds[0].subjectReceipt,
      result.evidence.builds[1].subjectReceipt);
    assert.equal(result.evidence.builds[0].verificationKeyUse,
      "EPHEMERAL_VERIFICATION_ONLY");
    assert.equal(Object.hasOwn(result.evidence.builds[0], "privateKey"), false);
    assert.equal(result.evidence.builds[0].sourceDigests.lockBefore,
      result.evidence.builds[0].sourceDigests.lockAfter);
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
});

describe("release package command", () => {
  const packageJson = () => JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

  test("runs pnpm through a validated Corepack JavaScript entrypoint", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts/release/supply-chain.mjs"), "utf8");
    assert.match(source, /realpathSync\(PNPM_ENTRY\)/u);
    assert.match(source, /command\(process\.execPath, \[entry, \.\.\.args\]/u);
    assert.doesNotMatch(source, /"pnpm(?:\.exe)?"/u);
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
    const stdout = execFileSync(process.platform === "win32" ? "pnpm.exe" : "pnpm",
      ["--silent", "release:evidence"], {
        cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
        timeout: 840_000, windowsHide: true,
      });
    const record = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
    assert.equal(record.componentCount, 5);
    assert.equal(record.reportCount, 3);
    assert.equal(record.sourceSha, SOURCE_SHA);
    assert.equal(record.operation, "RECORDED");
    assert.equal(record.releaseVerdict, "UNKNOWN");
    assert.equal(record.publicationAuthorized, false);
  });
});

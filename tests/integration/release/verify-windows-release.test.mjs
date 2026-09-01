import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync, existsSync, mkdtempSync, readFileSync, readSync, rmSync, truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  WINDOWS_RELEASE_VERIFICATION_LAYER,
  verifyWindowsRelease,
} from "../../../scripts/release/verify-windows-release.mjs";

const REPOSITORY = "yaront1111/Moe-NG";
const SIGNER_WORKFLOW = `${REPOSITORY}/.github/workflows/reusable-windows-release.yml`;
const SOURCE_DIGEST = "2".repeat(40);
const SIGNER_DIGEST = SOURCE_DIGEST;
const SOURCE_REF = "refs/heads/main";
const PUBLISH_WORKFLOW_PATH = resolve(".github/workflows/publish-windows-release.yml");
const AUTHORIZE_WORKFLOW_PATH = resolve(
  ".github/workflows/reusable-windows-publication-authorize.yml",
);
const VERIFY_WORKFLOW_PATH = resolve(
  ".github/workflows/reusable-windows-publication-verify.yml",
);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function receiptBody(zipBytes, sourceSha = SOURCE_DIGEST, evidenceDigest = "3".repeat(64)) {
  return {
    schemaVersion: "moe-pack-observation/1",
    mode: "LOCAL_OBSERVED",
    publicationAuthorized: false,
    sourceSha,
    artifact: {
      name: "moe-windows.zip",
      byteLength: zipBytes.length,
      sha256: sha256(zipBytes),
    },
    releaseEvidenceDigest: evidenceDigest,
    runner: { imageOS: "win22", imageVersion: "20260818.1", arch: "X64" },
    isolationClass: "GITHUB_HOSTED_EPHEMERAL_JOB",
  };
}

function seal(body) {
  return { ...body, receiptDigest: sha256(JSON.stringify(canonical(body))) };
}

function releaseEvidence(sourceSha, overrides = {}) {
  return {
    audit: {}, buildCount: 2, builds: [], componentCount: 6, doctor: {}, licenses: {},
    operation: "RECORDED", os: [], publicationAuthorized: false, releaseVerdict: "UNKNOWN",
    sbom: {}, source: { objectFormat: sourceSha.length === 40 ? "sha1" : "sha256", sourceSha },
    templateCount: 3, tools: {}, ...overrides,
  };
}

function fixture(sourceSha = SOURCE_DIGEST, zipBytes = Buffer.from("exact candidate zip bytes")) {
  const root = mkdtempSync(join(tmpdir(), "moe-release-verifier-"));
  const zip = join(root, "moe-windows.zip");
  const receipt = join(root, "moe-windows.zip.provenance.json");
  const bundle = join(root, "moe-windows.zip.attestation.json");
  const evidence = join(root, "moe-windows.zip.release-evidence.json");
  const evidenceBytes = Buffer.from(JSON.stringify(canonical(releaseEvidence(sourceSha))));
  writeFileSync(zip, zipBytes);
  const body = receiptBody(zipBytes, sourceSha, sha256(evidenceBytes));
  writeFileSync(receipt, JSON.stringify(canonical(seal(body))));
  writeFileSync(bundle, "{}\n");
  writeFileSync(evidence, evidenceBytes);
  return { bundle, evidence, evidenceBytes, receipt, root, zip, zipBytes };
}

function verifierArgv(paths, overrides = {}) {
  const values = {
    bundle: paths.bundle,
    receipt: paths.receipt,
    repository: REPOSITORY,
    signerDigest: SIGNER_DIGEST,
    signerWorkflow: SIGNER_WORKFLOW,
    sourceDigest: SOURCE_DIGEST,
    sourceRef: SOURCE_REF,
    zip: paths.zip,
    ...overrides,
  };
  return [
    "--zip", values.zip,
    "--receipt", values.receipt,
    "--bundle", values.bundle,
    "--release-evidence", values.evidence ?? paths.evidence,
    "--repository", values.repository,
    "--signer-workflow", values.signerWorkflow,
    "--signer-digest", values.signerDigest,
    "--source-digest", values.sourceDigest,
    "--source-ref", values.sourceRef,
    "--deny-self-hosted-runners",
  ];
}

function acceptedGh(calls) {
  return async (file, args, options) => {
    calls.push({ args, file, options });
    const argument = (name) => args[args.indexOf(name) + 1];
    const repository = argument("--repo");
    const signerDigest = argument("--signer-digest");
    const signerWorkflow = argument("--signer-workflow");
    const sourceDigest = argument("--source-digest");
    const sourceRef = argument("--source-ref");
    const signer = `https://github.com/${signerWorkflow}@${sourceRef}`;
    return { exitCode: 0, stderr: "", stdout: JSON.stringify([{
      verificationResult: { signature: { certificate: {
        buildConfigDigest: sourceDigest,
        buildConfigURI: `https://github.com/${repository}/.github/workflows/windows-release-candidate.yml@${sourceRef}`,
        buildSignerDigest: signerDigest,
        buildSignerURI: signer,
        buildTrigger: "workflow_dispatch",
        runnerEnvironment: "github-hosted",
        sourceRepositoryDigest: sourceDigest,
        sourceRepositoryRef: sourceRef,
        sourceRepositoryURI: `https://github.com/${repository}`,
        subjectAlternativeName: signer,
      } } },
    }]) };
  };
}

test("verifies all three exact subjects with an offline bundle and immutable gh argv", async (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  const calls = [];
  const result = await verifyWindowsRelease(verifierArgv(paths), { execute: acceptedGh(calls) });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "CI_ATTESTED");
  assert.equal(result.publicationAuthorized, false);
  assert.equal(result.sourceSha, SOURCE_DIGEST);
  assert.equal(result.artifact.sha256, sha256(paths.zipBytes));
  assert.equal(result.receipt.sha256, sha256(readFileSync(paths.receipt)));
  assert.equal(result.receipt.byteLength, readFileSync(paths.receipt).length);
  assert.equal(result.releaseEvidence.sha256, sha256(paths.evidenceBytes));
  assert.equal(result.attestationBundle.byteLength, readFileSync(paths.bundle).length);
  assert.equal(result.attestations.zipCount, 1);
  assert.equal(result.attestations.receiptCount, 1);
  assert.equal(result.attestations.evidenceCount, 1);
  assert.equal(calls.length, 3);

  for (const [index, subject] of [paths.zip, paths.receipt, paths.evidence].entries()) {
    assert.equal(calls[index].file, "gh");
    assert.deepEqual(calls[index].args, [
      "attestation", "verify", subject,
      "--repo", REPOSITORY,
      "--signer-workflow", SIGNER_WORKFLOW,
      "--signer-digest", SIGNER_DIGEST,
      "--source-digest", SOURCE_DIGEST,
      "--source-ref", SOURCE_REF,
      "--deny-self-hosted-runners",
      "--bundle", paths.bundle,
      "--format", "json",
    ]);
    assert.equal(calls[index].options.shell, false);
  }
});

test("refuses a receipt with any extra schema key", async (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  const body = { ...receiptBody(paths.zipBytes), authority: "forged" };
  writeFileSync(paths.receipt, JSON.stringify(canonical(seal(body))));
  const result = await verifyWindowsRelease(verifierArgv(paths), { execute: acceptedGh([]) });
  assert.deepEqual(result, {
    code: "WINDOWS_RELEASE_CANDIDATE_MALFORMED", layer: WINDOWS_RELEASE_VERIFICATION_LAYER, ok: false,
  });
});

test("refuses local observation bytes that claim publication authority", async (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  const body = { ...receiptBody(paths.zipBytes), publicationAuthorized: true };
  writeFileSync(paths.receipt, JSON.stringify(canonical(seal(body))));
  const result = await verifyWindowsRelease(verifierArgv(paths), { execute: acceptedGh([]) });
  assert.equal(result.code, "WINDOWS_RELEASE_PUBLICATION_CONFLICT");
  assert.equal(result.layer, WINDOWS_RELEASE_VERIFICATION_LAYER);
});

test("refuses an artifact whose current bytes differ from its receipt", async (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  writeFileSync(paths.zip, "tampered");
  const result = await verifyWindowsRelease(verifierArgv(paths), { execute: acceptedGh([]) });
  assert.equal(result.code, "WINDOWS_RELEASE_ARTIFACT_MISMATCH");
});

test("refuses a receipt whose body digest does not recompute", async (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  const receipt = JSON.parse(readFileSync(paths.receipt, "utf8"));
  receipt.receiptDigest = "0".repeat(64);
  writeFileSync(paths.receipt, JSON.stringify(canonical(receipt)));
  const result = await verifyWindowsRelease(verifierArgv(paths), { execute: acceptedGh([]) });
  assert.equal(result.code, "WINDOWS_RELEASE_ARTIFACT_MISMATCH");
});

test("refuses a receipt bound to a different source digest", async (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  const body = { ...receiptBody(paths.zipBytes), sourceSha: "4".repeat(40) };
  writeFileSync(paths.receipt, JSON.stringify(canonical(seal(body))));
  const result = await verifyWindowsRelease(verifierArgv(paths), { execute: acceptedGh([]) });
  assert.equal(result.code, "WINDOWS_RELEASE_SOURCE_MISMATCH");
});

test("requires the exact protected policy arguments", async (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  for (const argv of [
    verifierArgv(paths).slice(0, -1),
    [...verifierArgv(paths), "--repository", REPOSITORY],
    [...verifierArgv(paths), "--unexpected"],
    verifierArgv(paths, { sourceRef: "refs/heads/feature" }),
    verifierArgv(paths, { signerDigest: "1".repeat(40) }),
    verifierArgv(paths, { signerWorkflow: `${REPOSITORY}/.github/workflows/../reusable-windows-release.yml` }),
  ]) {
    const result = await verifyWindowsRelease(argv, { execute: acceptedGh([]) });
    assert.equal(result.code, "WINDOWS_RELEASE_INPUT_INVALID");
  }
});

test("accepts a 64-character source and same-commit signer digest", async (t) => {
  const digest = "a".repeat(64);
  const paths = fixture(digest);
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  const result = await verifyWindowsRelease(verifierArgv(paths, {
    signerDigest: digest, sourceDigest: digest,
  }), { execute: acceptedGh([]) });
  assert.equal(result.ok, true);
  assert.equal(result.sourceSha, digest);
});

test("refuses noncanonical receipt bytes before they gain attested authority", async (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  const receipt = JSON.parse(readFileSync(paths.receipt, "utf8"));
  writeFileSync(paths.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  const result = await verifyWindowsRelease(verifierArgv(paths), { execute: acceptedGh([]) });
  assert.equal(result.code, "WINDOWS_RELEASE_CANDIDATE_MALFORMED");
});

test("refuses a duplicate receipt key that JSON parsing could collapse", async (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  const receipt = readFileSync(paths.receipt, "utf8");
  writeFileSync(paths.receipt, receipt.replace("{", '{"mode":"CI_ATTESTED",'));
  const result = await verifyWindowsRelease(verifierArgv(paths), { execute: acceptedGh([]) });
  assert.equal(result.code, "WINDOWS_RELEASE_CANDIDATE_MALFORMED");
});

test("refuses an empty ZIP even when the receipt claims zero bytes", async (t) => {
  const paths = fixture(SOURCE_DIGEST, Buffer.alloc(0));
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  const result = await verifyWindowsRelease(verifierArgv(paths), { execute: acceptedGh([]) });
  assert.equal(result.code, "WINDOWS_RELEASE_CANDIDATE_MALFORMED");
});

test("refuses an oversized offline bundle before invoking gh", async (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  writeFileSync(paths.bundle, Buffer.alloc(16 * 1024 * 1024 + 1));
  const calls = [];
  const result = await verifyWindowsRelease(verifierArgv(paths), { execute: acceptedGh(calls) });
  assert.equal(result.code, "WINDOWS_RELEASE_CANDIDATE_MALFORMED");
  assert.equal(calls.length, 0);
});

test("refuses a ZIP larger than the producer's 512 MiB limit before invoking gh", async (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  truncateSync(paths.zip, 512 * 1024 * 1024 + 1);
  const calls = [];
  const result = await verifyWindowsRelease(verifierArgv(paths), { execute: acceptedGh(calls) });
  assert.equal(result.code, "WINDOWS_RELEASE_CANDIDATE_MALFORMED");
  assert.equal(calls.length, 0);
});

test("never reads beyond the opened file size plus one EOF probe when a file grows", async (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  const requested = [];
  let grew = false;
  const result = await verifyWindowsRelease(verifierArgv(paths), {
    execute: acceptedGh([]),
    read: (descriptor, buffer, offset, length, position) => {
      requested.push(length);
      const count = readSync(descriptor, buffer, offset, length, position);
      if (!grew) {
        grew = true;
        appendFileSync(paths.zip, "concurrent growth");
      }
      return count;
    },
  });
  assert.equal(result.code, "WINDOWS_RELEASE_CANDIDATE_MALFORMED");
  assert.deepEqual(requested, [paths.zipBytes.length, 1]);
});

test("refuses release evidence bound to a different source", async (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  const evidenceBytes = Buffer.from(JSON.stringify(canonical(releaseEvidence("5".repeat(40)))));
  writeFileSync(paths.evidence, evidenceBytes);
  const body = receiptBody(paths.zipBytes, SOURCE_DIGEST, sha256(evidenceBytes));
  writeFileSync(paths.receipt, JSON.stringify(canonical(seal(body))));
  const result = await verifyWindowsRelease(verifierArgv(paths), { execute: acceptedGh([]) });
  assert.equal(result.code, "WINDOWS_RELEASE_SOURCE_MISMATCH");
});

test("refuses signed evidence that claims publication authority", async (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  for (const override of [{ publicationAuthorized: true }, { releaseVerdict: "ALLOW" }]) {
    const evidenceBytes = Buffer.from(JSON.stringify(canonical(releaseEvidence(SOURCE_DIGEST, override))));
    writeFileSync(paths.evidence, evidenceBytes);
    const body = receiptBody(paths.zipBytes, SOURCE_DIGEST, sha256(evidenceBytes));
    writeFileSync(paths.receipt, JSON.stringify(canonical(seal(body))));
    const result = await verifyWindowsRelease(verifierArgv(paths), { execute: acceptedGh([]) });
    assert.equal(result.code, "WINDOWS_RELEASE_PUBLICATION_CONFLICT");
  }
});

test("refuses noncanonical or structurally broadened release evidence", async (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  for (const evidence of [
    { ...releaseEvidence(SOURCE_DIGEST), authority: "forged" },
    releaseEvidence(SOURCE_DIGEST, { operation: "AUTHORIZED" }),
    releaseEvidence(SOURCE_DIGEST, {
      source: { objectFormat: "sha1", sourceSha: SOURCE_DIGEST, waiver: "forged" },
    }),
  ]) {
    const evidenceBytes = Buffer.from(JSON.stringify(canonical(evidence)));
    writeFileSync(paths.evidence, evidenceBytes);
    const body = receiptBody(paths.zipBytes, SOURCE_DIGEST, sha256(evidenceBytes));
    writeFileSync(paths.receipt, JSON.stringify(canonical(seal(body))));
    const result = await verifyWindowsRelease(verifierArgv(paths), { execute: acceptedGh([]) });
    assert.equal(result.code, "WINDOWS_RELEASE_CANDIDATE_MALFORMED");
  }
  const evidence = releaseEvidence(SOURCE_DIGEST);
  const prettyBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(paths.evidence, prettyBytes);
  writeFileSync(paths.receipt, JSON.stringify(canonical(seal(
    receiptBody(paths.zipBytes, SOURCE_DIGEST, sha256(prettyBytes)),
  ))));
  const result = await verifyWindowsRelease(verifierArgv(paths), { execute: acceptedGh([]) });
  assert.equal(result.code, "WINDOWS_RELEASE_CANDIDATE_MALFORMED");
});

test("refuses release evidence whose current digest differs from its receipt", async (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  writeFileSync(paths.evidence, '{"tampered":true}\n');
  const result = await verifyWindowsRelease(verifierArgv(paths), { execute: acceptedGh([]) });
  assert.equal(result.code, "WINDOWS_RELEASE_ARTIFACT_MISMATCH");
});

test("refuses successful gh output unless it is nonempty JSON", async (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  for (const stdout of ["[]", "not json", "{}"] ) {
    const result = await verifyWindowsRelease(verifierArgv(paths), {
      execute: async () => ({ exitCode: 0, stderr: "", stdout }),
    });
    assert.equal(result.code, "WINDOWS_RELEASE_ATTESTATION_INVALID");
  }
});

test("refuses a nonzero gh attestation verification", async (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  const result = await verifyWindowsRelease(verifierArgv(paths), {
    execute: async () => ({ exitCode: 17, stderr: "refused", stdout: "" }),
  });
  assert.equal(result.code, "WINDOWS_RELEASE_ATTESTATION_INVALID");
});

test("refuses gh JSON whose flattened certificate proves a different signer", async (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  const stdout = JSON.stringify([{
    verificationResult: { signature: { certificate: {
      buildSignerDigest: "9".repeat(40),
      buildSignerURI: `https://github.com/${SIGNER_WORKFLOW}@refs/heads/main`,
      runnerEnvironment: "github-hosted",
      sourceRepositoryDigest: SOURCE_DIGEST,
      sourceRepositoryRef: SOURCE_REF,
      sourceRepositoryURI: `https://github.com/${REPOSITORY}`,
      subjectAlternativeName: `https://github.com/${SIGNER_WORKFLOW}@refs/heads/main`,
    } } },
  }]);
  const result = await verifyWindowsRelease(verifierArgv(paths), {
    execute: async () => ({ exitCode: 0, stderr: "", stdout }),
  });
  assert.equal(result.code, "WINDOWS_RELEASE_SIGNER_MISMATCH");
});

test("refuses gh JSON with any required certificate policy fact absent", async (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  const result = await verifyWindowsRelease(verifierArgv(paths), {
    execute: async () => ({
      exitCode: 0, stderr: "", stdout: '[{"verificationResult":{"signature":{"certificate":{}}}}]',
    }),
  });
  assert.equal(result.code, "WINDOWS_RELEASE_SIGNER_MISMATCH");
});

test("refuses an alternate caller even when the reusable signer is exact", async (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  const calls = [];
  const execute = acceptedGh(calls);
  const result = await verifyWindowsRelease(verifierArgv(paths), {
    execute: async (file, args, options) => {
      const answer = await execute(file, args, options);
      const parsed = JSON.parse(answer.stdout);
      parsed[0].verificationResult.signature.certificate.buildConfigURI =
        `https://github.com/${REPOSITORY}/.github/workflows/alternate.yml@${SOURCE_REF}`;
      return { ...answer, stdout: JSON.stringify(parsed) };
    },
  });
  assert.equal(result.code, "WINDOWS_RELEASE_SIGNER_MISMATCH");
});

test("refuses candidate bytes mutated while gh verifies the offline bundle", async (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { force: true, recursive: true }));
  const calls = [];
  const execute = acceptedGh(calls);
  const result = await verifyWindowsRelease(verifierArgv(paths), {
    execute: async (file, args, options) => {
      const answer = await execute(file, args, options);
      if (calls.length === 3) writeFileSync(paths.zip, "mutated after gh reopened subjects");
      return answer;
    },
  });
  assert.equal(result.code, "WINDOWS_RELEASE_ARTIFACT_MISMATCH");
});

test("publish workflow keeps candidate bytes unexecuted behind the production environment", () => {
  const workflow = readFileSync(PUBLISH_WORKFLOW_PATH, "utf8");
  assert.equal(existsSync(AUTHORIZE_WORKFLOW_PATH), true, "authorization leaf is required");
  assert.equal(existsSync(VERIFY_WORKFLOW_PATH), true, "verification leaf is required");
  const authorize = readFileSync(AUTHORIZE_WORKFLOW_PATH, "utf8");
  const verify = readFileSync(VERIFY_WORKFLOW_PATH, "utf8");
  const releasePath = `${workflow}\n${authorize}\n${verify}`;
  for (const source of [workflow, authorize, verify]) {
    assert.ok(source.split(/\r?\n/u).length <= 400, "publication workflow must stay under 400 lines");
  }
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /environment:\s*windows-production-release/u);
  assert.doesNotMatch(releasePath, /ubuntu-latest/u);
  assert.equal(workflow.match(/runs-on:\s*ubuntu-24\.04/gu)?.length, 2);
  assert.equal(authorize.match(/runs-on:\s*ubuntu-24\.04/gu)?.length, 1);
  assert.equal(verify.match(/runs-on:\s*ubuntu-24\.04/gu)?.length, 1);
  assert.doesNotMatch(releasePath, /actions\/checkout@/u);
  assert.match(workflow, /if:\s*github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /github\.ref_protected/u);
  assert.match(workflow, /WINDOWS_RELEASE_REF_UNPROTECTED@WINDOWS_RELEASE_AUTHORITY/u);
  assert.match(workflow, /REF_PROTECTED[^\n]+refuse WINDOWS_RELEASE_REF_UNPROTECTED/u);
  assert.match(authorize, /path[^\n]+\.github\/workflows\/windows-release-candidate\.yml/u);
  assert.match(authorize, /event[^\n]+workflow_dispatch/u);
  assert.match(authorize, /head_branch[^\n]+main/u);
  assert.match(authorize, /conclusion[^\n]+success/u);
  assert.match(authorize, /head_sha[^\n]+\$source/u);
  assert.match(releasePath, /SOURCE_SHA[^\n]+GITHUB_SHA/u);
  assert.doesNotMatch(releasePath, /node\s+[^\n]*candidate\//u);
  assert.doesNotMatch(releasePath, /contents\/scripts\/release\/verify-windows-release/u);
  assert.doesNotMatch(releasePath, /VERIFIER_PATH/u);
  assert.doesNotMatch(releasePath, /^      GH_TOKEN:/mu);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/reusable-windows-publication-authorize\.yml/u);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/reusable-windows-publication-verify\.yml/u);
});

test("publish job revalidates protected hosted context before any privileged operation", () => {
  const workflow = readFileSync(resolve(".github/workflows/publish-windows-release.yml"), "utf8");
  const publish = workflow.slice(workflow.indexOf("\n  publish:"));
  const guard = publish.indexOf("- name: Revalidate the protected publication context after approval");
  const download = publish.indexOf("- name: Download the authorized candidate artifact ID");
  assert.ok(guard > 0 && guard < download);
  const guardedPrefix = publish.slice(0, download);
  assert.match(guardedPrefix, /GITHUB_REF[^\n]+refs\/heads\/main[^\n]+WINDOWS_RELEASE_REF_UNPROTECTED/u);
  assert.match(guardedPrefix, /REF_PROTECTED[^\n]+true[^\n]+WINDOWS_RELEASE_REF_UNPROTECTED/u);
  assert.match(guardedPrefix, /SOURCE_SHA[^\n]+GITHUB_SHA[^\n]+WINDOWS_RELEASE_SOURCE_MISMATCH/u);
  assert.match(guardedPrefix, /OBSERVED_RUNNER_ENVIRONMENT[^\n]+github-hosted[^\n]+WINDOWS_RELEASE_SIGNER_MISMATCH/u);
});

test("publish workflow has the exact release permissions and fixed attestation roster", () => {
  const workflow = readFileSync(resolve(".github/workflows/publish-windows-release.yml"), "utf8");
  const authorize = readFileSync(AUTHORIZE_WORKFLOW_PATH, "utf8");
  const verify = readFileSync(VERIFY_WORKFLOW_PATH, "utf8");
  assert.match(workflow, /^permissions:\s*\{\}$/mu);
  assert.match(workflow, /authorize:[\s\S]*?permissions:\n\s+actions: read\n\s+contents: read/u);
  assert.match(workflow, /publish:[\s\S]*?permissions:\n\s+actions: read\n\s+contents: write\n\s+id-token: write\n\s+attestations: write\n\s+artifact-metadata: write/u);
  assert.match(workflow, /verify-release:[\s\S]*?permissions:\n\s+actions: read\n\s+contents: read/u);
  assert.match(authorize, /authorize:[\s\S]*?permissions:\n\s+actions: read\n\s+contents: read/u);
  assert.match(verify, /verify-release:[\s\S]*?permissions:\n\s+actions: read\n\s+contents: read/u);
  assert.doesNotMatch(`${authorize}\n${verify}`, /(?:contents|id-token|attestations|artifact-metadata): write/u);
  assert.match(workflow, /actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6/u);
  assert.match(workflow, /OBSERVED_RUNNER_ENVIRONMENT:\s*\$\{\{ runner\.environment \}\}/u);
  assert.match(workflow, /OBSERVED_RUNNER_ENVIRONMENT[^\n]+github-hosted[^\n]+WINDOWS_RELEASE_SIGNER_MISMATCH/u);
  assert.match(workflow, /subject-path: \|[\s\S]*moe-windows\.zip\n[\s\S]*moe-windows\.zip\.provenance\.json\n[\s\S]*moe-windows\.zip\.release-evidence\.json\n[\s\S]*moe-windows\.release\.json/u);
  assert.match(workflow, /moe-windows\.zip\.attestation\.json/u);
  assert.match(authorize, /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/u);
  assert.match(authorize, /artifact-ids:\s*\$\{\{ steps\.candidate\.outputs\.artifact_id \}\}/u);
  assert.match(workflow, /artifact-ids:\s*\$\{\{ needs\.authorize\.outputs\.artifact_id \}\}/u);
  assert.match(verify, /artifact-ids:\s*\$\{\{ inputs\.artifact_id \}\}/u);
});

test("publisher rebinds all pre-attestation bytes after verification and before upload", () => {
  const workflow = readFileSync(PUBLISH_WORKFLOW_PATH, "utf8");
  const attest = workflow.indexOf("- name: Attest the fixed publication subject roster");
  const verify = workflow.indexOf("- name: Offline-verify every publication signer statement");
  const rebind = workflow.indexOf("- name: Rebind every attested publication subject before upload");
  const draft = workflow.indexOf("- name: Create the draft and upload the fixed release assets");
  assert.ok(attest >= 0 && attest < verify && verify < rebind && rebind < draft);
  const step = workflow.slice(rebind, draft);
  for (const output of ["zip", "receipt", "evidence", "bundle"]) {
    for (const field of ["sha", "size"]) {
      assert.match(step, new RegExp(`needs\\.authorize\\.outputs\\.${output}_${field}`, "u"));
    }
  }
  assert.match(step, /steps\.manifest\.outputs\.sha/u);
  assert.match(step, /steps\.manifest\.outputs\.size/u);
  for (const name of [
    "moe-windows.zip", "moe-windows.zip.provenance.json",
    "moe-windows.zip.release-evidence.json", "moe-windows.zip.attestation.json",
    "moe-windows.release.json",
  ]) assert.match(step, new RegExp(`bind ${name.replaceAll(".", "\\.")}`, "u"));
});

test("publication action inventory is exact and fully pinned", () => {
  const releasePath = [PUBLISH_WORKFLOW_PATH, AUTHORIZE_WORKFLOW_PATH, VERIFY_WORKFLOW_PATH]
    .map((path) => readFileSync(path, "utf8")).join("\n");
  // The ref may carry a trailing version-provenance comment (`@<sha> # v1.2.3`). Match it
  // explicitly rather than letting `$` sit against the SHA: an end-anchor immediately after
  // the capture parses ZERO refs the moment a comment is added, silently emptying this
  // inventory instead of failing it. The SHA capture itself stays exact.
  const uses = [...releasePath.matchAll(/^\s+(?:-\s+)?uses:\s+([^@.][^@\s]*)@([^\s#]+)(?:\s+#.*)?$/gmu)];
  const expected = new Map([
    ["actions/attest", [1, "1e69f48acb82d1966a394da916b4c1698aa569d6"]],
    ["actions/download-artifact", [3, "d3f86a106a0bac45b974a628896c90dbdf5c8093"]],
    ["actions/upload-artifact", [1, "ea165f8d65b6e75b540449e92b4886f43607fa02"]],
  ]);
  assert.equal(uses.length, 5);
  for (const [action, [count, revision]] of expected) {
    const matches = uses.filter((match) => match[1] === action);
    assert.equal(matches.length, count, `unexpected ${action} count`);
    assert.ok(matches.every((match) => match[2] === revision), `${action} pin drifted`);
  }
});

test("publication workflow-call outputs join every producer to its exact consumer", () => {
  const workflow = readFileSync(PUBLISH_WORKFLOW_PATH, "utf8");
  const authorize = readFileSync(AUTHORIZE_WORKFLOW_PATH, "utf8");
  const verify = readFileSync(VERIFY_WORKFLOW_PATH, "utf8");
  for (const output of [
    "artifact_digest", "artifact_id", "bundle_sha", "bundle_size", "evidence_sha",
    "evidence_size", "receipt_sha", "receipt_size", "zip_sha", "zip_size",
  ]) {
    assert.match(authorize, new RegExp(
      `value: \\$\\{\\{ jobs\\.authorize\\.outputs\\.${output} \\}\\}`, "u",
    ));
    assert.match(workflow, new RegExp(`needs\\.authorize\\.outputs\\.${output}`, "u"));
  }
  assert.match(workflow, /artifact_digest:\s*\$\{\{ steps\.verification-handoff\.outputs\['artifact-digest'\] \}\}/u);
  assert.match(workflow, /artifact_id:\s*\$\{\{ steps\.verification-handoff\.outputs\['artifact-id'\] \}\}/u);
  assert.match(workflow, /release_id:\s*\$\{\{ steps\.draft-roster\.outputs\.release_id \}\}/u);
  assert.match(workflow, /name: windows-release-publication-verification-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
  assert.match(workflow, /include-hidden-files: false/u);
  assert.match(workflow, /overwrite: false/u);
  for (const output of ["artifact_digest", "artifact_id", "release_id"]) {
    assert.match(workflow, new RegExp(
      `${output}: \\$\\{\\{ needs\\.publish\\.outputs\\.${output} \\}\\}`, "u",
    ));
  }
  assert.match(workflow, /publish:\n\s+needs: authorize/u);
  assert.match(workflow, /verify-release:\n\s+needs: publish/u);
  assert.match(verify, /HANDOFF_ARTIFACT_DIGEST:\s*\$\{\{ inputs\.artifact_digest \}\}/u);
  assert.match(verify, /HANDOFF_ARTIFACT_ID:\s*\$\{\{ inputs\.artifact_id \}\}/u);
  assert.match(verify, /EXPECTED_RELEASE_ID:\s*\$\{\{ inputs\.release_id \}\}/u);
  assert.match(verify, /HANDOFF_ARTIFACT_ID[^\n]+\^\[1-9\]\[0-9\]\*\$/u);
  assert.match(verify, /HANDOFF_ARTIFACT_DIGEST[^\n]+\^\[0-9a-f\]\{64\}\$/u);
  assert.match(verify, /actions\/artifacts\/\$\{HANDOFF_ARTIFACT_ID\}/u);
  assert.match(verify, /\.id == \$id and \.name == \$name/u);
  assert.match(verify, /\.expired == false and \.digest == \$digest/u);
  assert.doesNotMatch(verify, /digest-mismatch:/u);
});

test("authorize job inline-verifies three subjects with the complete protected policy", () => {
  const workflow = readFileSync(AUTHORIZE_WORKFLOW_PATH, "utf8");
  assert.match(workflow, /schemaVersion[^\n]+moe-pack-observation\/1/u);
  assert.match(workflow, /JSON\.stringify\(canonical\(receipt\)\)/u);
  assert.match(workflow, /releaseEvidenceDigest/u);
  assert.equal(workflow.match(/gh attestation verify/gu)?.length, 1);
  for (const argument of [
    "--repo", "--signer-workflow", "--signer-digest", "--source-digest", "--source-ref",
    "--deny-self-hosted-runners",
  ]) assert.match(workflow, new RegExp(argument, "u"));
  assert.match(workflow, /reusable-windows-release\.yml/u);
  assert.match(workflow, /windows-release-candidate\.yml@refs\/heads\/main/u);
  assert.match(workflow, /\$c\.buildConfigDigest/u);
  assert.match(workflow, /\$c\.buildTrigger[^\n]+workflow_dispatch/u);
  assert.match(workflow, /refs\/heads\/main/u);
  assert.match(workflow, /moe-windows\.zip moe-windows\.zip\.provenance\.json moe-windows\.zip\.release-evidence\.json/u);
});

test("final manifest binds all four candidate files without self-authorizing the verifier", () => {
  const workflow = readFileSync(resolve(".github/workflows/publish-windows-release.yml"), "utf8");
  assert.match(workflow, /mode:\s*"PUBLICATION_APPROVED"/u);
  assert.match(workflow, /publicationAuthorized:\s*true/u);
  for (const output of ["zip_sha", "receipt_sha", "evidence_sha", "bundle_sha"]) {
    assert.match(workflow, new RegExp(`needs\\.authorize\\.outputs\\.${output}`, "u"));
  }
});

test("publish tag is exactly the inert package version and immutable releases are mandatory", () => {
  const workflow = `${readFileSync(AUTHORIZE_WORKFLOW_PATH, "utf8")}\n${readFileSync(PUBLISH_WORKFLOW_PATH, "utf8")}`;
  assert.match(workflow, /contents\/package\.json\?ref=\$\{SOURCE_SHA\}/u);
  assert.match(workflow, /RELEASE_TAG[^\n]+v\$\{version\}/u);
  assert.match(workflow, /refuse WINDOWS_RELEASE_VERSION_MISMATCH/u);
  assert.match(workflow, /refuse WINDOWS_RELEASE_IMMUTABILITY_DISABLED/u);
  assert.match(workflow, /@WINDOWS_RELEASE_AUTHORITY/u);
  assert.doesNotMatch(workflow, /curl[^\n]+Authorization/u);
});

test("publish workflow refuses pre-existing and mutable releases before draft publication", () => {
  const workflow = readFileSync(resolve(".github/workflows/publish-windows-release.yml"), "utf8");
  const authorize = readFileSync(AUTHORIZE_WORKFLOW_PATH, "utf8");
  const verifyWorkflow = readFileSync(VERIFY_WORKFLOW_PATH, "utf8");
  const releasePath = `${authorize}\n${workflow}`;
  assert.match(releasePath, /immutable-releases/u);
  assert.match(releasePath, /immutable[^\n]+== "true"/u);
  assert.match(releasePath, /release\(tagName:\$tag\)/u);
  assert.match(releasePath, /ref\(qualifiedName:\$ref\)/u);
  const manifest = workflow.indexOf("moe-windows.release.json");
  const draft = workflow.indexOf("gh release create");
  const upload = workflow.indexOf("gh release upload");
  const publish = workflow.indexOf("gh release edit");
  const handoff = workflow.indexOf("- name: Upload the exact publication verification handoff");
  assert.ok(manifest >= 0 && manifest < draft && draft < upload && upload < handoff && handoff < publish);
  assert.match(verifyWorkflow, /gh release verify[^\n]+--format json/u);
  assert.match(verifyWorkflow, /for name in moe-windows\.zip moe-windows\.zip\.provenance\.json \\\n\s+moe-windows\.zip\.release-evidence\.json moe-windows\.zip\.attestation\.json \\\n\s+moe-windows\.release\.json moe-windows\.release\.attestation\.json/u);
  assert.match(verifyWorkflow, /gh release verify-asset "\$\{RELEASE_TAG\}" "\$\{CANDIDATE_DIR\}\/\$\{name\}"/u);
  assert.match(verifyWorkflow, /type == "object" and \(\.attestation \| type == "object"\)[\s\S]*?\.verificationResult/u);
  assert.match(verifyWorkflow, /WINDOWS_RELEASE_IMMUTABILITY_UNVERIFIED@WINDOWS_RELEASE_AUTHORITY/u);
  assert.match(verifyWorkflow, /for attempt in 1 2 3 4 5 6/u);
  assert.match(workflow, /if ! gh release create/u);
  assert.match(workflow, /release_id=\$\{release_id\}/u);
});

test("release workflows fail closed on GitHub CLI semantic drift", () => {
  const reusable = readFileSync(resolve(".github/workflows/reusable-windows-release.yml"), "utf8");
  const publication = [PUBLISH_WORKFLOW_PATH, AUTHORIZE_WORKFLOW_PATH, VERIFY_WORKFLOW_PATH]
    .map((path) => readFileSync(path, "utf8")).join("\n");
  const exactVersion = /gh version 2\.92\.0 \(2026-04-28\)/u;
  assert.match(reusable, exactVersion);
  assert.equal(publication.match(new RegExp(exactVersion.source, "gu"))?.length, 3);
});

function releaseRosterValidator(workflow) {
  const marker = "// WINDOWS_RELEASE_ROSTER_VALIDATOR_V1";
  const markerAt = workflow.indexOf(marker);
  const heredocAt = workflow.lastIndexOf("<<'NODE'\n", markerAt);
  const endAt = workflow.indexOf("\n          NODE", markerAt);
  assert.ok(heredocAt >= 0 && markerAt > heredocAt && endAt > markerAt);
  return workflow.slice(heredocAt + "<<'NODE'\n".length, endAt)
    .split("\n").map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n");
}

test("release statement validator refuses a seventh asset and same-digest alias", (t) => {
  const root = mkdtempSync(join(tmpdir(), "moe-release-roster-"));
  const verificationPath = root + ".verification.json";
  t.after(() => {
    rmSync(root, { force: true, recursive: true });
    rmSync(verificationPath, { force: true });
  });
  const names = [
    "moe-windows.zip",
    "moe-windows.zip.provenance.json",
    "moe-windows.zip.release-evidence.json",
    "moe-windows.zip.attestation.json",
    "moe-windows.release.json",
    "moe-windows.release.attestation.json",
  ];
  const subjects = names.map((name, index) => {
    const bytes = Buffer.from("release asset " + index);
    writeFileSync(join(root, name), bytes);
    return { digest: { sha256: sha256(bytes) }, name };
  });
  const purl = "pkg:github/" + REPOSITORY + "@v1.2.3";
  const base = {
    _type: "https://in-toto.io/Statement/v1",
    predicate: {
      ownerId: "1", purl, releaseId: "2", repository: REPOSITORY,
      repositoryId: "3", tag: "v1.2.3",
    },
    predicateType: "https://in-toto.io/attestation/release/v0.1",
    subject: [{ digest: { sha1: SOURCE_DIGEST }, uri: purl }, ...subjects],
  };
  const workflow = readFileSync(VERIFY_WORKFLOW_PATH, "utf8");
  const script = releaseRosterValidator(workflow);
  const run = (statement) => {
    const payload = Buffer.from(JSON.stringify(statement)).toString("base64");
    writeFileSync(verificationPath, JSON.stringify({
      attestation: { bundle: { dsseEnvelope: {
        payload, payloadType: "application/vnd.in-toto+json", signatures: [{}],
      } } },
      verificationResult: {},
    }));
    return spawnSync(process.execPath, ["--input-type=module"], {
      encoding: "utf8", env: {
        ...process.env, CANDIDATE_DIR: root, RELEASE_TAG: "v1.2.3",
        EXPECTED_RELEASE_ID: "2", RELEASE_VERIFICATION_PATH: verificationPath,
        REPOSITORY, SOURCE_SHA: SOURCE_DIGEST,
      },
      input: script, maxBuffer: 1024 * 1024,
    });
  };
  const accepted = run(base);
  assert.equal(accepted.status, 0, accepted.stderr);

  const seventh = structuredClone(base);
  seventh.subject.push({ digest: { sha256: "f".repeat(64) }, name: "unexpected.exe" });
  assert.notEqual(run(seventh).status, 0);

  const alias = structuredClone(base);
  alias.subject[1].name = "moe-windows.zip.alias";
  assert.notEqual(run(alias).status, 0);

  const wrongIdentity = structuredClone(base);
  wrongIdentity.subject[0].digest.sha1 = "4".repeat(40);
  assert.notEqual(run(wrongIdentity).status, 0);

  const wrongPredicate = structuredClone(base);
  wrongPredicate.predicate.repository = "attacker/alias";
  assert.notEqual(run(wrongPredicate).status, 0);

  const wrongRelease = structuredClone(base);
  wrongRelease.predicate.releaseId = "9";
  assert.notEqual(run(wrongRelease).status, 0);
});

test("draft publication checks the exact six API assets before becoming public", () => {
  const workflow = readFileSync(resolve(".github/workflows/publish-windows-release.yml"), "utf8");
  const upload = workflow.indexOf("gh release upload");
  const roster = workflow.indexOf("- name: Verify the exact draft asset roster before publication");
  const publish = workflow.indexOf("gh release edit");
  assert.ok(upload >= 0 && upload < roster && roster < publish);
  assert.match(workflow, /releases\/tags\/\$\{RELEASE_TAG\}/u);
  assert.match(workflow, /releases\/\$\{release_id\}\/assets\?per_page=100/u);
  assert.match(workflow, /type == "array" and length == 6/u);
  assert.match(workflow, /\.name == \$name and \.size == \$size and \.digest == \$digest/u);
  assert.match(workflow, /sha256:\$\{sha\}/u);
});

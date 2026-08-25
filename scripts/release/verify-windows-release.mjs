// @ts-check
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

/** @typedef {"WINDOWS_RELEASE_INPUT_INVALID" | "WINDOWS_RELEASE_CANDIDATE_MALFORMED" | "WINDOWS_RELEASE_PUBLICATION_CONFLICT" | "WINDOWS_RELEASE_SOURCE_MISMATCH" | "WINDOWS_RELEASE_ARTIFACT_MISMATCH" | "WINDOWS_RELEASE_ATTESTATION_INVALID" | "WINDOWS_RELEASE_SIGNER_MISMATCH"} VerificationCode */
/** @typedef {{code: VerificationCode, layer: typeof WINDOWS_RELEASE_VERIFICATION_LAYER, ok: false}} VerificationFailure */
/** @typedef {{bundle: string, receipt: string, repository: string, "release-evidence": string, "signer-digest": string, "signer-workflow": string, "source-digest": string, "source-ref": string, zip: string}} VerificationPolicy */
/** @typedef {{exitCode: number, stderr: string, stdout: string}} CommandResult */
/** @typedef {(file: string, args: string[], options: import("node:child_process").ExecFileOptionsWithStringEncoding) => Promise<CommandResult>} Execute */
/** @typedef {(descriptor: number, buffer: Buffer, offset: number, length: number, position: number | null) => number} ReadChunk */
/** @typedef {{ctimeMs: number, dev: number, ino: number, mtimeMs: number, size: number}} FileIdentity */
/** @typedef {{byteLength: number, bytes: Buffer | null, identity: FileIdentity, sha256: string}} FileDigest */

export const WINDOWS_RELEASE_VERIFICATION_LAYER = "WINDOWS_RELEASE_AUTHORITY";
export const WINDOWS_RELEASE_VERIFICATION_CODES = Object.freeze([
  "WINDOWS_RELEASE_INPUT_INVALID", "WINDOWS_RELEASE_CANDIDATE_MALFORMED",
  "WINDOWS_RELEASE_PUBLICATION_CONFLICT", "WINDOWS_RELEASE_SOURCE_MISMATCH",
  "WINDOWS_RELEASE_ARTIFACT_MISMATCH", "WINDOWS_RELEASE_ATTESTATION_INVALID",
  "WINDOWS_RELEASE_SIGNER_MISMATCH",
]);
const RECEIPT_KEYS = Object.freeze([
  "artifact", "isolationClass", "mode", "publicationAuthorized", "receiptDigest",
  "releaseEvidenceDigest", "runner", "schemaVersion", "sourceSha",
]);
const EVIDENCE_KEYS = Object.freeze(["audit", "buildCount", "builds", "componentCount", "doctor", "licenses", "operation", "os", "publicationAuthorized", "releaseVerdict", "sbom", "source", "templateCount", "tools"]);
const ARGUMENTS = Object.freeze([
  "--zip", "--receipt", "--bundle", "--release-evidence", "--repository",
  "--signer-workflow", "--signer-digest", "--source-digest", "--source-ref",
]);
const MAX_RECEIPT_BYTES = 64 * 1024; const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024; const MAX_ZIP_BYTES = 512 * 1024 * 1024;
const GIT_DIGEST = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const MAX_COMMAND_OUTPUT = 16 * 1024 * 1024; const COMMAND_TIMEOUT_MS = 120_000;
const exec = promisify(execFile);
/** @param {VerificationCode} code @returns {VerificationFailure} */
function refusal(code) { return Object.freeze({ code, layer: WINDOWS_RELEASE_VERIFICATION_LAYER, ok: false }); }
/** @param {unknown} value @param {readonly string[]} keys @returns {Record<string, unknown> | null} */
function exactRecord(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]) ? record : null;
}
/** @param {unknown} value @returns {unknown} */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const record = /** @type {Record<string, unknown>} */ (value);
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
}
/** @param {import("node:crypto").BinaryLike} value @returns {string} */
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
/** @param {import("node:fs").Stats} stats @returns {FileIdentity} */
function identity(stats) {
  return { ctimeMs: stats.ctimeMs, dev: stats.dev, ino: stats.ino,
    mtimeMs: stats.mtimeMs, size: stats.size };
}
/** @param {FileIdentity} left @param {FileIdentity} right */
function sameIdentity(left, right) {
  return Object.keys(left).every((key) => left[/** @type {keyof FileIdentity} */ (key)]
    === right[/** @type {keyof FileIdentity} */ (key)]);
}
/** @param {FileDigest} left @param {FileDigest} right */
function sameFile(left, right) {
  return left.byteLength === right.byteLength && left.sha256 === right.sha256
    && sameIdentity(left.identity, right.identity);
}
/** @param {string} path @param {boolean} [retainBytes] @param {number} [maxBytes] @param {ReadChunk} [read] @returns {FileDigest} */
function digestFile(path, retainBytes = false, maxBytes = Number.MAX_SAFE_INTEGER, read = readSync) {
  let descriptor = null;
  try {
    const pathBefore = lstatSync(path);
    if (!isAbsolute(path) || pathBefore.isSymbolicLink() || !pathBefore.isFile()) throw new Error("not owned");
    descriptor = openSync(path, "r");
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > maxBytes
      || !sameIdentity(identity(pathBefore), identity(before))) throw new Error("not regular");
    const hash = createHash("sha256");
    /** @type {Buffer[]} */ const chunks = [];
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let consumed = 0;
    let remaining = before.size;
    while (remaining > 0) {
      const permitted = Math.min(buffer.length, remaining);
      const count = read(descriptor, buffer, 0, permitted, null);
      if (count <= 0 || count > permitted) throw new Error("short read");
      const chunk = buffer.subarray(0, count); hash.update(chunk);
      if (retainBytes) chunks.push(Buffer.from(chunk));
      consumed += count; remaining -= count;
    }
    if (read(descriptor, buffer, 0, 1, null) !== 0) throw new Error("grew while read");
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(path);
    if (consumed !== before.size || after.size !== before.size
      || pathAfter.isSymbolicLink() || !pathAfter.isFile()
      || !sameIdentity(identity(before), identity(after))
      || !sameIdentity(identity(before), identity(pathAfter))) throw new Error("changed while read");
    return { byteLength: consumed, bytes: retainBytes ? Buffer.concat(chunks) : null,
      identity: identity(before), sha256: hash.digest("hex") };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}
/** @param {readonly string[]} argv @returns {VerificationPolicy | null} */
function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== ARGUMENTS.length * 2 + 1) return null;
  /** @type {Record<string, string>} */ const values = {};
  for (const [index, name] of ARGUMENTS.entries()) {
    if (argv[index * 2] !== name || typeof argv[index * 2 + 1] !== "string"
      || argv[index * 2 + 1].length === 0) return null;
    values[name.slice(2)] = argv[index * 2 + 1];
  }
  if (argv.at(-1) !== "--deny-self-hosted-runners") return null;
  const policy = /** @type {VerificationPolicy} */ (values);
  const repository = policy.repository;
  const workflow = policy["signer-workflow"];
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
    || workflow !== `${repository}/.github/workflows/reusable-windows-release.yml`
    || !GIT_DIGEST.test(policy["signer-digest"]) || !GIT_DIGEST.test(policy["source-digest"])
    || policy["signer-digest"] !== policy["source-digest"]
    || policy["source-ref"] !== "refs/heads/main"
    || !isAbsolute(policy.zip) || !isAbsolute(policy.receipt) || !isAbsolute(policy.bundle)
    || !isAbsolute(policy["release-evidence"])
    || basename(policy.zip) !== "moe-windows.zip"
    || basename(policy.receipt) !== "moe-windows.zip.provenance.json"
    || basename(policy["release-evidence"]) !== "moe-windows.zip.release-evidence.json"
    || basename(policy.bundle) !== "moe-windows.zip.attestation.json") return null;
  return policy;
}
/** @param {Uint8Array} bytes @returns {Record<string, unknown> | null} */
function decodeReceipt(bytes) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const receipt = exactRecord(JSON.parse(text), RECEIPT_KEYS);
    return receipt !== null && text === JSON.stringify(canonical(receipt)) ? receipt : null;
  } catch {
    return null;
  }
}
/** @param {Record<string, unknown>} receipt @returns {boolean} */
function validReceiptShape(receipt) {
  const artifact = exactRecord(receipt.artifact, ["byteLength", "name", "sha256"]);
  const runner = exactRecord(receipt.runner, ["arch", "imageOS", "imageVersion"]);
  return receipt.schemaVersion === "moe-pack-observation/1"
    && typeof receipt.sourceSha === "string" && GIT_DIGEST.test(receipt.sourceSha)
    && typeof receipt.releaseEvidenceDigest === "string" && /^[0-9a-f]{64}$/u.test(receipt.releaseEvidenceDigest)
    && receipt.isolationClass === "GITHUB_HOSTED_EPHEMERAL_JOB"
    && typeof receipt.receiptDigest === "string" && /^[0-9a-f]{64}$/u.test(receipt.receiptDigest)
    && artifact !== null && artifact.name === "moe-windows.zip"
    && Number.isSafeInteger(artifact.byteLength) && Number(artifact.byteLength) > 0
    && typeof artifact.sha256 === "string" && /^[0-9a-f]{64}$/u.test(artifact.sha256)
    && runner !== null && [runner.imageOS, runner.imageVersion, runner.arch]
      .every((value) => typeof value === "string" && value.length > 0);
}
/** @type {Execute} */
async function defaultExecute(file, args, options) {
  try {
    const result = await exec(file, args, options);
    return { exitCode: 0, stderr: String(result.stderr), stdout: String(result.stdout) };
  } catch (error) {
    const failure = /** @type {{code?: number, stderr?: string, stdout?: string}} */ (error);
    return { exitCode: typeof failure.code === "number" ? failure.code : 1,
      stderr: failure.stderr ?? "", stdout: failure.stdout ?? "" };
  }
}
/** @param {Record<string, unknown>[]} entries @param {VerificationPolicy} policy */
function signerMismatch(entries, policy) {
  const signer = `https://github.com/${policy["signer-workflow"]}@${policy["source-ref"]}`;
  const expected = {
    buildConfigDigest: policy["source-digest"],
    buildConfigURI: `https://github.com/${policy.repository}/.github/workflows/windows-release-candidate.yml@${policy["source-ref"]}`,
    buildSignerDigest: policy["signer-digest"], buildSignerURI: signer,
    buildTrigger: "workflow_dispatch",
    runnerEnvironment: "github-hosted", sourceRepositoryDigest: policy["source-digest"],
    sourceRepositoryRef: policy["source-ref"],
    sourceRepositoryURI: `https://github.com/${policy.repository}`,
    subjectAlternativeName: signer,
  };
  return entries.some((entry) => {
    const candidate = /** @type {{verificationResult?: {signature?: {certificate?: unknown}}}} */ (entry);
    const certificate = candidate.verificationResult?.signature?.certificate;
    if (certificate === null || typeof certificate !== "object" || Array.isArray(certificate)) return true;
    const fields = /** @type {Record<string, unknown>} */ (certificate);
    return Object.entries(expected).some(([key, value]) => fields[key] !== value);
  });
}
/** @param {string} subject @param {VerificationPolicy} policy @param {Execute} execute @returns {Promise<number | VerificationFailure>} */
async function attest(subject, policy, execute) {
  const args = [
    "attestation", "verify", subject, "--repo", policy.repository,
    "--signer-workflow", policy["signer-workflow"], "--signer-digest", policy["signer-digest"],
    "--source-digest", policy["source-digest"], "--source-ref", policy["source-ref"],
    "--deny-self-hosted-runners", "--bundle", policy.bundle, "--format", "json",
  ];
  const result = await execute("gh", args, {
    encoding: "utf8", maxBuffer: MAX_COMMAND_OUTPUT, shell: false,
    timeout: COMMAND_TIMEOUT_MS, windowsHide: true,
  });
  if (result.exitCode !== 0) return refusal("WINDOWS_RELEASE_ATTESTATION_INVALID");
  try {
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed) || parsed.length === 0
      || !parsed.every((entry) => entry !== null && typeof entry === "object")) {
      return refusal("WINDOWS_RELEASE_ATTESTATION_INVALID");
    }
    return signerMismatch(parsed, policy)
      ? refusal("WINDOWS_RELEASE_SIGNER_MISMATCH") : parsed.length;
  } catch {
    return refusal("WINDOWS_RELEASE_ATTESTATION_INVALID");
  }
}
/** @param {readonly string[]} argv @param {{execute?: Execute, read?: ReadChunk}} [dependencies] */
export async function verifyWindowsRelease(argv, dependencies = {}) {
  const policy = parseArguments(argv);
  if (policy === null) return refusal("WINDOWS_RELEASE_INPUT_INVALID");
  let zip; let receiptFile; let releaseEvidence; let bundle;
  /** @type {Record<string, unknown>} */ let evidence;
  let evidenceText;
  const read = dependencies.read ?? readSync;
  try {
    zip = digestFile(policy.zip, false, MAX_ZIP_BYTES, read);
    receiptFile = digestFile(policy.receipt, true, MAX_RECEIPT_BYTES, read);
    releaseEvidence = digestFile(policy["release-evidence"], true, MAX_EVIDENCE_BYTES, read);
    evidenceText = new TextDecoder("utf-8", { fatal: true })
      .decode(/** @type {Buffer} */ (releaseEvidence.bytes));
    evidence = /** @type {Record<string, unknown>} */ (JSON.parse(evidenceText));
    if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("evidence invalid");
    bundle = digestFile(policy.bundle, false, MAX_BUNDLE_BYTES, read);
    if (bundle.byteLength === 0) throw new Error("bundle empty");
  } catch {
    return refusal("WINDOWS_RELEASE_CANDIDATE_MALFORMED");
  }
  const receipt = decodeReceipt(/** @type {Buffer} */ (receiptFile.bytes));
  if (receipt === null || !validReceiptShape(receipt)) return refusal("WINDOWS_RELEASE_CANDIDATE_MALFORMED");
  if (receipt.mode !== "LOCAL_OBSERVED" || receipt.publicationAuthorized !== false)
    return refusal("WINDOWS_RELEASE_PUBLICATION_CONFLICT");
  const { receiptDigest, ...body } = receipt;
  if (receiptDigest !== sha256(JSON.stringify(canonical(body))))
    return refusal("WINDOWS_RELEASE_ARTIFACT_MISMATCH");
  if (receipt.sourceSha !== policy["source-digest"]) return refusal("WINDOWS_RELEASE_SOURCE_MISMATCH");
  if (receipt.releaseEvidenceDigest !== releaseEvidence.sha256)
    return refusal("WINDOWS_RELEASE_ARTIFACT_MISMATCH");
  if (exactRecord(evidence, EVIDENCE_KEYS) === null)
    return refusal("WINDOWS_RELEASE_CANDIDATE_MALFORMED");
  if (evidenceText !== JSON.stringify(canonical(evidence)) || evidence.operation !== "RECORDED")
    return refusal("WINDOWS_RELEASE_CANDIDATE_MALFORMED");
  if (evidence.publicationAuthorized !== false || evidence.releaseVerdict !== "UNKNOWN")
    return refusal("WINDOWS_RELEASE_PUBLICATION_CONFLICT");
  const evidenceSource = exactRecord(evidence.source, ["objectFormat", "sourceSha"]);
  if (evidenceSource === null) return refusal("WINDOWS_RELEASE_CANDIDATE_MALFORMED");
  if (evidenceSource.sourceSha !== policy["source-digest"]) {
    return refusal("WINDOWS_RELEASE_SOURCE_MISMATCH");
  }
  if (evidenceSource.objectFormat !== (policy["source-digest"].length === 40 ? "sha1" : "sha256"))
    return refusal("WINDOWS_RELEASE_CANDIDATE_MALFORMED");
  const artifact = /** @type {Record<string, unknown>} */ (receipt.artifact);
  if (artifact.byteLength !== zip.byteLength || artifact.sha256 !== zip.sha256)
    return refusal("WINDOWS_RELEASE_ARTIFACT_MISMATCH");
  const execute = dependencies.execute ?? defaultExecute;
  const zipAttestation = await attest(policy.zip, policy, execute);
  if (typeof zipAttestation !== "number") return zipAttestation;
  const receiptAttestation = await attest(policy.receipt, policy, execute);
  if (typeof receiptAttestation !== "number") return receiptAttestation;
  const evidenceAttestation = await attest(policy["release-evidence"], policy, execute);
  if (typeof evidenceAttestation !== "number") return evidenceAttestation;
  try {
    if (!sameFile(zip, digestFile(policy.zip, false, MAX_ZIP_BYTES, read))
      || !sameFile(receiptFile, digestFile(policy.receipt, false, MAX_RECEIPT_BYTES, read))
      || !sameFile(releaseEvidence, digestFile(policy["release-evidence"], false, MAX_EVIDENCE_BYTES, read))
      || !sameFile(bundle, digestFile(policy.bundle, false, MAX_BUNDLE_BYTES, read))) {
      return refusal("WINDOWS_RELEASE_ARTIFACT_MISMATCH");
    }
  } catch {
    return refusal("WINDOWS_RELEASE_ARTIFACT_MISMATCH");
  }
  return Object.freeze({
    artifact: Object.freeze({ byteLength: zip.byteLength, name: "moe-windows.zip", sha256: zip.sha256 }),
    attestationBundle: Object.freeze({
      byteLength: bundle.byteLength, name: "moe-windows.zip.attestation.json", sha256: bundle.sha256,
    }),
    attestations: Object.freeze({
      evidenceCount: evidenceAttestation, receiptCount: receiptAttestation, zipCount: zipAttestation,
    }),
    mode: "CI_ATTESTED", ok: true, publicationAuthorized: false,
    receipt: Object.freeze({
      byteLength: receiptFile.byteLength,
      name: "moe-windows.zip.provenance.json", receiptDigest, sha256: receiptFile.sha256,
    }),
    releaseEvidence: Object.freeze({
      byteLength: releaseEvidence.byteLength,
      name: "moe-windows.zip.release-evidence.json", sha256: releaseEvidence.sha256,
    }),
    repository: policy.repository, schemaVersion: "moe-windows-release-verification/1",
    signerDigest: policy["signer-digest"], signerWorkflow: policy["signer-workflow"],
    sourceRef: policy["source-ref"], sourceSha: receipt.sourceSha,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = await verifyWindowsRelease(process.argv.slice(2));
  const stream = result.ok ? process.stdout : process.stderr;
  stream.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

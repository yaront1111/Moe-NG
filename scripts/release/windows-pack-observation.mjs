import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalWindowsPackObservationBytes,
  canonicalWindowsReleaseValue,
  deepFreezeWindowsRelease,
  exactDataRecordSnapshot,
  refuseWindowsRelease,
  WINDOWS_PACK_OBSERVATION_SCHEMA_VERSION,
  WINDOWS_RELEASE_AUTHORITY_CODES,
  WINDOWS_RELEASE_AUTHORITY_LAYER,
  WindowsReleaseAuthorityError,
  windowsReleaseSha256,
} from "./windows-pack-observation-contract.mjs";
import { publishWindowsPackObservationOutput } from "./windows-pack-observation-output.mjs";

export {
  canonicalWindowsPackObservationBytes,
  WINDOWS_PACK_OBSERVATION_SCHEMA_VERSION,
  WINDOWS_RELEASE_AUTHORITY_CODES,
  WINDOWS_RELEASE_AUTHORITY_LAYER,
  WindowsReleaseAuthorityError,
} from "./windows-pack-observation-contract.mjs";

export const MAX_WINDOWS_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const MAX_RELEASE_EVIDENCE_BYTES = 16 * 1024 * 1024;

const ARTIFACT_NAME = "moe-windows.zip";
const SOURCE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const RUNNER_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PATH_LIMIT = 4_096;
const READ_CHUNK_BYTES = 64 * 1024;
const RELEASE_EVIDENCE_KEYS = Object.freeze([
  "audit", "buildCount", "builds", "componentCount", "doctor", "licenses",
  "operation", "os", "publicationAuthorized", "releaseVerdict", "sbom",
  "source", "templateCount", "tools",
]);
const REQUEST_KEYS = Object.freeze([
  "artifactPath",
  "cwd",
  "releaseEvidencePath",
  "runnerArch",
  "runnerImageOS",
  "runnerImageVersion",
  "sourceSha",
]);
const CLI_ARGUMENTS = Object.freeze([
  "create",
  "--artifact",
  "--source-sha",
  "--release-evidence",
  "--runner-image-os",
  "--runner-image-version",
  "--runner-arch",
  "--output",
]);

/** @param {unknown} value */
function validPathText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= PATH_LIMIT
    && !value.includes("\0");
}

/** @param {unknown} value */
function validRunnerIdentity(value) {
  return typeof value === "string" && RUNNER_IDENTITY.test(value)
    && Buffer.byteLength(value, "utf8") <= 128;
}

/**
 * @param {unknown} value
 * @returns {{artifactPath: string, cwd: string, releaseEvidencePath: string, runnerArch: string, runnerImageOS: string, runnerImageVersion: string, sourceSha: string}}
 */
function requestRecord(value) {
  const input = exactDataRecordSnapshot(value, REQUEST_KEYS);
  if (input === null) {
    refuseWindowsRelease(WINDOWS_RELEASE_AUTHORITY_CODES.INPUT_INVALID);
  }
  if (!validPathText(input.artifactPath) || !validPathText(input.cwd)
    || !validPathText(input.releaseEvidencePath)
    || !validRunnerIdentity(input.runnerArch) || !validRunnerIdentity(input.runnerImageOS)
    || !validRunnerIdentity(input.runnerImageVersion)
    || typeof input.sourceSha !== "string" || !SOURCE_SHA.test(input.sourceSha)) {
    refuseWindowsRelease(WINDOWS_RELEASE_AUTHORITY_CODES.INPUT_INVALID);
  }
  return /** @type {{artifactPath: string, cwd: string, releaseEvidencePath: string, runnerArch: string, runnerImageOS: string, runnerImageVersion: string, sourceSha: string}} */ (input);
}

/** @param {string} root @param {string} candidate */
function contained(root, candidate) {
  const child = relative(root, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && !isAbsolute(child);
}

/** @param {string} cwd @returns {string} */
function canonicalRoot(cwd) {
  try {
    const lexical = resolve(cwd);
    const info = lstatSync(lexical);
    const canonical = realpathSync.native(lexical);
    if (!info.isDirectory() || !statSync(canonical).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    refuseWindowsRelease(WINDOWS_RELEASE_AUTHORITY_CODES.INPUT_INVALID);
  }
}

/** @param {import("node:fs").BigIntStats} left @param {import("node:fs").BigIntStats} right */
function sameFileObservation(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/**
 * Open and observe a regular contained file once. The pre/open/post identities
 * catch ordinary replacement and in-read mutation; this LOCAL_OBSERVED receipt
 * intentionally does not claim protection from a same-principal mutate/restore.
 * @param {object} options
 * @param {boolean} options.collect
 * @param {string} options.code
 * @param {string} options.cwd
 * @param {number} options.maximumBytes
 * @param {string} options.path
 * @returns {Readonly<{byteLength: number, bytes: Buffer | null, canonicalPath: string, sha256: string}>}
 */
function observeFile({ collect, code, cwd, maximumBytes, path }) {
  let handle;
  try {
    const lexicalPath = resolve(cwd, path);
    const lexical = lstatSync(lexicalPath, { bigint: true });
    if (!lexical.isFile() || lexical.isSymbolicLink()) throw new Error("not a regular file");
    const canonicalPath = realpathSync.native(lexicalPath);
    if (!contained(cwd, canonicalPath)) throw new Error("outside cwd");

    handle = openSync(lexicalPath, constants.O_RDONLY);
    const before = fstatSync(handle, { bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(maximumBytes)
      || lexical.dev !== before.dev || lexical.ino !== before.ino || lexical.size !== before.size) {
      throw new Error("invalid file observation");
    }

    const byteLength = Number(before.size);
    const digest = createHash("sha256");
    const collected = collect ? Buffer.allocUnsafe(byteLength) : null;
    const chunk = collect ? collected : Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, byteLength));
    let offset = 0;
    while (offset < byteLength) {
      const remaining = byteLength - offset;
      const target = /** @type {Buffer} */ (chunk);
      const targetOffset = collect ? offset : 0;
      const read = readSync(handle, target, targetOffset, Math.min(target.length - targetOffset, remaining), null);
      if (read <= 0) throw new Error("short read");
      digest.update(target.subarray(targetOffset, targetOffset + read));
      offset += read;
    }

    const after = fstatSync(handle, { bigint: true });
    const canonicalAfter = realpathSync.native(lexicalPath);
    const pathAfter = statSync(canonicalAfter, { bigint: true });
    if (canonicalAfter !== canonicalPath || !contained(cwd, canonicalAfter)
      || !sameFileObservation(before, after) || !sameFileObservation(after, pathAfter)) {
      throw new Error("file changed during observation");
    }
    return Object.freeze({
      byteLength,
      bytes: collected,
      canonicalPath,
      sha256: digest.digest("hex"),
    });
  } catch {
    return refuseWindowsRelease(code);
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

/** @param {Buffer} bytes @param {string} sourceSha */
function validateReleaseEvidence(bytes, sourceSha) {
  let parsed;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    refuseWindowsRelease(WINDOWS_RELEASE_AUTHORITY_CODES.INPUT_INVALID);
  }
  const evidence = exactDataRecordSnapshot(parsed, RELEASE_EVIDENCE_KEYS);
  if (evidence === null || text !== canonicalWindowsReleaseValue(parsed)
    || evidence.operation !== "RECORDED") {
    refuseWindowsRelease(WINDOWS_RELEASE_AUTHORITY_CODES.INPUT_INVALID);
  }
  if (evidence.publicationAuthorized !== false || evidence.releaseVerdict !== "UNKNOWN") {
    refuseWindowsRelease(WINDOWS_RELEASE_AUTHORITY_CODES.PUBLICATION_CONFLICT);
  }
  const source = exactDataRecordSnapshot(evidence.source, ["objectFormat", "sourceSha"]);
  if (source === null
    || (source.objectFormat !== "sha1" && source.objectFormat !== "sha256")
    || typeof source.sourceSha !== "string" || !SOURCE_SHA.test(source.sourceSha)
    || (source.objectFormat === "sha1" && source.sourceSha.length !== 40)
    || (source.objectFormat === "sha256" && source.sourceSha.length !== 64)) {
    refuseWindowsRelease(WINDOWS_RELEASE_AUTHORITY_CODES.INPUT_INVALID);
  }
  if (source.sourceSha !== sourceSha) {
    refuseWindowsRelease(WINDOWS_RELEASE_AUTHORITY_CODES.SOURCE_MISMATCH);
  }
}

/**
 * Create a detached local observation. This function has no promotion input:
 * CI environment variables cannot change its mode or publication authority.
 * @param {unknown} value
 */
export async function createWindowsPackObservation(value) {
  const input = requestRecord(value);
  const cwd = canonicalRoot(input.cwd);
  if (basename(input.artifactPath) !== ARTIFACT_NAME) {
    refuseWindowsRelease(WINDOWS_RELEASE_AUTHORITY_CODES.ARTIFACT_MISMATCH);
  }
  const artifact = observeFile({
    code: WINDOWS_RELEASE_AUTHORITY_CODES.ARTIFACT_MISMATCH,
    collect: false,
    cwd,
    maximumBytes: MAX_WINDOWS_ARTIFACT_BYTES,
    path: input.artifactPath,
  });

  const evidence = observeFile({
    code: WINDOWS_RELEASE_AUTHORITY_CODES.INPUT_INVALID,
    collect: true,
    cwd,
    maximumBytes: MAX_RELEASE_EVIDENCE_BYTES,
    path: input.releaseEvidencePath,
  });
  validateReleaseEvidence(/** @type {Buffer} */ (evidence.bytes), input.sourceSha);

  const body = {
    artifact: {
      byteLength: artifact.byteLength,
      name: ARTIFACT_NAME,
      sha256: artifact.sha256,
    },
    isolationClass: "GITHUB_HOSTED_EPHEMERAL_JOB",
    mode: "LOCAL_OBSERVED",
    publicationAuthorized: false,
    releaseEvidenceDigest: evidence.sha256,
    runner: {
      arch: input.runnerArch,
      imageOS: input.runnerImageOS,
      imageVersion: input.runnerImageVersion,
    },
    schemaVersion: WINDOWS_PACK_OBSERVATION_SCHEMA_VERSION,
    sourceSha: input.sourceSha,
  };
  const receiptDigest = windowsReleaseSha256(Buffer.from(canonicalWindowsReleaseValue(body), "utf8"));
  return /** @type {Readonly<typeof body & {receiptDigest: string}>} */ (
    deepFreezeWindowsRelease({ ...body, receiptDigest })
  );
}

/**
 * @param {string[]} argv
 * @returns {Readonly<{artifactPath: string, outputPath: string, releaseEvidencePath: string, runnerArch: string, runnerImageOS: string, runnerImageVersion: string, sourceSha: string}>}
 */
function parseCli(argv) {
  if (argv.length !== 15
    || argv[0] !== CLI_ARGUMENTS[0]
    || argv[1] !== CLI_ARGUMENTS[1]
    || argv[3] !== CLI_ARGUMENTS[2]
    || argv[5] !== CLI_ARGUMENTS[3]
    || argv[7] !== CLI_ARGUMENTS[4]
    || argv[9] !== CLI_ARGUMENTS[5]
    || argv[11] !== CLI_ARGUMENTS[6]
    || argv[13] !== CLI_ARGUMENTS[7]
    || argv.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    refuseWindowsRelease(WINDOWS_RELEASE_AUTHORITY_CODES.INPUT_INVALID);
  }
  return Object.freeze({
    artifactPath: /** @type {string} */ (argv[2]),
    outputPath: /** @type {string} */ (argv[14]),
    releaseEvidencePath: /** @type {string} */ (argv[6]),
    runnerArch: /** @type {string} */ (argv[12]),
    runnerImageOS: /** @type {string} */ (argv[8]),
    runnerImageVersion: /** @type {string} */ (argv[10]),
    sourceSha: /** @type {string} */ (argv[4]),
  });
}

/** @param {string[]} argv */
async function main(argv) {
  const parsed = parseCli(argv);
  const cwd = process.cwd();
  const receipt = await createWindowsPackObservation({
    artifactPath: parsed.artifactPath,
    cwd,
    releaseEvidencePath: parsed.releaseEvidencePath,
    runnerArch: parsed.runnerArch,
    runnerImageOS: parsed.runnerImageOS,
    runnerImageVersion: parsed.runnerImageVersion,
    sourceSha: parsed.sourceSha,
  });
  await publishWindowsPackObservationOutput({
    artifactPath: parsed.artifactPath,
    bytes: canonicalWindowsPackObservationBytes(receipt),
    cwd,
    outputPath: parsed.outputPath,
  });
  console.log(canonicalWindowsReleaseValue({
    artifact: receipt.artifact.name,
    mode: receipt.mode,
    publicationAuthorized: receipt.publicationAuthorized,
    receiptDigest: receipt.receiptDigest,
    sourceSha: receipt.sourceSha,
  }));
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    const code = error instanceof WindowsReleaseAuthorityError
      ? error.code
      : WINDOWS_RELEASE_AUTHORITY_CODES.INPUT_INVALID;
    console.error(canonicalWindowsReleaseValue({ code, layer: WINDOWS_RELEASE_AUTHORITY_LAYER, ok: false }));
    process.exitCode = 1;
  });
}

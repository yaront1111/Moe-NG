import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";
import { spawnSync } from "node:child_process";

const TEST_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(TEST_FILE), "../../..");
const SUBJECT_PATH = join(REPOSITORY_ROOT, "scripts/release/windows-pack-observation.mjs");
const SUBJECT_URL = pathToFileURL(SUBJECT_PATH).href;
const OUTPUT_SUBJECT_URL = pathToFileURL(join(
  REPOSITORY_ROOT, "scripts/release/windows-pack-observation-output.mjs",
)).href;
const SOURCE_SHA = "ab".repeat(20);
const OTHER_SOURCE_SHA = "cd".repeat(20);
/** @type {string[]} */
const roots = [];

/** @typedef {{artifactBytes: Buffer, artifactPath: string, cwd: string, dist: string, releaseEvidenceBytes: Buffer, releaseEvidencePath: string}} Fixture */

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

/** @returns {Fixture} */
function fixture() {
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "moe-pack-observation-")));
  roots.push(cwd);
  const dist = join(cwd, "dist");
  mkdirSync(dist);
  const artifactPath = join(dist, "moe-windows.zip");
  const artifactBytes = Buffer.from("PK\u0003\u0004detached-test-artifact", "utf8");
  writeFileSync(artifactPath, artifactBytes);
  const releaseEvidencePath = join(dist, "release-evidence.json");
  const releaseEvidenceBytes = Buffer.from(canonical(releaseEvidence()));
  writeFileSync(releaseEvidencePath, releaseEvidenceBytes);
  return {
    artifactBytes,
    artifactPath,
    cwd,
    dist,
    releaseEvidenceBytes,
    releaseEvidencePath,
  };
}

/** @param {Record<string, unknown>} [overrides] */
function releaseEvidence(overrides = {}) {
  return {
    audit: {},
    buildCount: 2,
    builds: [],
    componentCount: 1,
    doctor: {},
    licenses: {},
    operation: "RECORDED",
    os: [],
    publicationAuthorized: false,
    releaseVerdict: "UNKNOWN",
    sbom: {},
    source: { objectFormat: "sha1", sourceSha: SOURCE_SHA },
    templateCount: 3,
    tools: {},
    ...overrides,
  };
}

/** @returns {Promise<typeof import("../../../scripts/release/windows-pack-observation.mjs")>} */
async function subject() {
  try {
    return await import(SUBJECT_URL);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : String(error);
    assert.fail(`windows pack observation implementation is required: ${code}`);
  }
}

/** @returns {Promise<typeof import("../../../scripts/release/windows-pack-observation-output.mjs")>} */
async function outputSubject() {
  try {
    return await import(OUTPUT_SUBJECT_URL);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : String(error);
    assert.fail(`windows pack observation output implementation is required: ${code}`);
  }
}

/** @param {string | Uint8Array} bytes */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** @param {unknown} value @returns {string} */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  const primitive = JSON.stringify(value);
  assert.notEqual(primitive, undefined);
  return /** @type {string} */ (primitive);
}

/** @param {Fixture} f @param {Record<string, unknown>} [overrides] */
function request(f, overrides = {}) {
  return {
    artifactPath: f.artifactPath,
    cwd: f.cwd,
    releaseEvidencePath: f.releaseEvidencePath,
    runnerArch: "X64",
    runnerImageOS: "win22",
    runnerImageVersion: "20250817.1",
    sourceSha: SOURCE_SHA,
    ...overrides,
  };
}

/** @param {() => Promise<unknown>} action @param {string} code */
async function expectRefusal(action, code) {
  const { WINDOWS_RELEASE_AUTHORITY_LAYER } = await subject();
  await assert.rejects(action, (error) => {
    assert.equal(error && typeof error === "object" && "code" in error ? error.code : undefined, code);
    assert.equal(error && typeof error === "object" && "layer" in error ? error.layer : undefined, WINDOWS_RELEASE_AUTHORITY_LAYER);
    return true;
  });
}

/** @param {Fixture} f @param {string} [outputPath] */
function cliArguments(f, outputPath = join(f.dist, "moe-windows.zip.provenance.json")) {
  return [
    "create",
    "--artifact", f.artifactPath,
    "--source-sha", SOURCE_SHA,
    "--release-evidence", f.releaseEvidencePath,
    "--runner-image-os", "win22",
    "--runner-image-version", "20250817.1",
    "--runner-arch", "X64",
    "--output", outputPath,
  ];
}

/** @param {Fixture} f @param {string[]} args @param {Record<string, string>} [environment] */
function runCli(f, args, environment = {}) {
  return spawnSync(process.execPath, [SUBJECT_PATH, ...args], {
    cwd: f.cwd,
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

/** @param {{status: number | null, stdout: string, stderr: string}} run */
function parseCliRefusal(run) {
  assert.notEqual(run.status, 0, `expected refusal, stdout=${run.stdout}`);
  return JSON.parse(run.stderr.trim());
}

/** @param {Fixture} f */
async function receiptBytes(f) {
  const { canonicalWindowsPackObservationBytes, createWindowsPackObservation } = await subject();
  return canonicalWindowsPackObservationBytes(await createWindowsPackObservation(request(f)));
}

/** @param {Fixture} f @param {Uint8Array} bytes @param {string} [outputPath] */
function outputRequest(f, bytes, outputPath = join(f.dist, "moe-windows.zip.provenance.json")) {
  return { artifactPath: f.artifactPath, bytes, cwd: f.cwd, outputPath };
}

/** @param {import("node:fs").BigIntStats} observed */
function changedInode(observed) {
  return new Proxy(observed, {
    get(target, property) {
      if (property === "ino") return target.ino + 1n;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("creates the exact canonical detached LOCAL_OBSERVED receipt with mandatory evidence", async () => {
  const f = fixture();
  const {
    WINDOWS_PACK_OBSERVATION_SCHEMA_VERSION,
    canonicalWindowsPackObservationBytes,
    createWindowsPackObservation,
  } = await subject();

  const receipt = await createWindowsPackObservation(request(f));
  const body = {
    artifact: {
      byteLength: f.artifactBytes.byteLength,
      name: "moe-windows.zip",
      sha256: sha256(f.artifactBytes),
    },
    isolationClass: "GITHUB_HOSTED_EPHEMERAL_JOB",
    mode: "LOCAL_OBSERVED",
    publicationAuthorized: false,
    releaseEvidenceDigest: sha256(f.releaseEvidenceBytes),
    runner: {
      arch: "X64",
      imageOS: "win22",
      imageVersion: "20250817.1",
    },
    schemaVersion: "moe-pack-observation/1",
    sourceSha: SOURCE_SHA,
  };
  const expected = {
    ...body,
    receiptDigest: sha256(Buffer.from(canonical(body))),
  };

  assert.equal(WINDOWS_PACK_OBSERVATION_SCHEMA_VERSION, "moe-pack-observation/1");
  assert.deepEqual(receipt, expected);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.artifact), true);
  assert.equal(Object.isFrozen(receipt.runner), true);
  const encoded = canonicalWindowsPackObservationBytes(receipt);
  assert.equal(Buffer.from(encoded).toString("utf8"), canonical(expected));
  assert.equal(Buffer.from(encoded).at(-1), "}".charCodeAt(0));
});

test("binds the raw release-evidence digest and refuses a different evidence source", async () => {
  const f = fixture();
  const { createWindowsPackObservation } = await subject();
  const receipt = await createWindowsPackObservation(request(f, {
    releaseEvidencePath: f.releaseEvidencePath,
  }));
  assert.equal(receipt.releaseEvidenceDigest, sha256(f.releaseEvidenceBytes));

  writeFileSync(f.releaseEvidencePath, canonical(releaseEvidence({
    source: { objectFormat: "sha1", sourceSha: OTHER_SOURCE_SHA },
  })));
  await expectRefusal(
    () => createWindowsPackObservation(request(f, { releaseEvidencePath: f.releaseEvidencePath })),
    "WINDOWS_RELEASE_SOURCE_MISMATCH",
  );
});

test("refuses release evidence that claims authority or is not the exact canonical schema", async () => {
  const f = fixture();
  const { createWindowsPackObservation } = await subject();
  const hostile = [
    {
      code: "WINDOWS_RELEASE_PUBLICATION_CONFLICT",
      name: "publication promoted",
      text: canonical(releaseEvidence({ publicationAuthorized: true })),
    },
    {
      code: "WINDOWS_RELEASE_PUBLICATION_CONFLICT",
      name: "release verdict promoted",
      text: canonical(releaseEvidence({ releaseVerdict: "ALLOW" })),
    },
    {
      code: "WINDOWS_RELEASE_INPUT_INVALID",
      name: "operation changed",
      text: canonical(releaseEvidence({ operation: "PUBLISHED" })),
    },
    {
      code: "WINDOWS_RELEASE_INPUT_INVALID",
      name: "extra authority key",
      text: canonical(releaseEvidence({ humanApproved: true })),
    },
    {
      code: "WINDOWS_RELEASE_INPUT_INVALID",
      name: "noncanonical bytes",
      text: `${canonical(releaseEvidence())}\n`,
    },
  ];
  assert.equal(hostile.length, 5);
  for (const attack of hostile) {
    writeFileSync(f.releaseEvidencePath, attack.text);
    await expectRefusal(
      () => createWindowsPackObservation(request(f, { releaseEvidencePath: f.releaseEvidencePath })),
      attack.code,
    ).catch((error) => {
      error.message = `${attack.name}: ${error.message}`;
      throw error;
    });
  }
});

test("refuses malformed input, noncanonical source identity, and invalid runner identity", async () => {
  const f = fixture();
  const { createWindowsPackObservation } = await subject();
  const cases = [
    { name: "missing key", value: { ...request(f), runnerArch: undefined } },
    { name: "extra key", value: { ...request(f), promote: true } },
    { name: "symbol key", value: { ...request(f), [Symbol("promote")]: true } },
    { name: "hostile proxy", value: new Proxy(request(f), {
      getPrototypeOf() { throw new Error("proxy trap must not escape"); },
    }) },
    { name: "symbolic source", value: request(f, { sourceSha: "HEAD" }) },
    { name: "uppercase source", value: request(f, { sourceSha: SOURCE_SHA.toUpperCase() }) },
    { name: "empty runner OS", value: request(f, { runnerImageOS: "" }) },
    { name: "runner newline", value: request(f, { runnerImageVersion: "20250817.1\nforged" }) },
    { name: "oversized runner", value: request(f, { runnerArch: "A".repeat(129) }) },
    { name: "missing release evidence", value: request(f, { releaseEvidencePath: null }) },
  ];
  assert.equal(cases.length, 10);
  for (const hostile of cases) {
    await expectRefusal(
      () => createWindowsPackObservation(hostile.value),
      "WINDOWS_RELEASE_INPUT_INVALID",
    ).catch((error) => {
      error.message = `${hostile.name}: ${error.message}`;
      throw error;
    });
  }
});

test("decodes data descriptors once instead of trusting mutable Proxy getters", async () => {
  const f = fixture();
  const { createWindowsPackObservation } = await subject();
  const hostile = new Proxy(request(f), {
    get(target, property, receiver) {
      if (property === "sourceSha") return OTHER_SOURCE_SHA;
      if (property === "runnerArch") return "FORGED";
      return Reflect.get(target, property, receiver);
    },
  });

  const receipt = await createWindowsPackObservation(hostile);
  assert.equal(receipt.sourceSha, SOURCE_SHA);
  assert.equal(receipt.runner.arch, "X64");
});

test("refuses nonregular, empty, oversized, misnamed, and escaping artifacts", async () => {
  const f = fixture();
  const { createWindowsPackObservation, MAX_WINDOWS_ARTIFACT_BYTES } = await subject();

  await expectRefusal(
    () => createWindowsPackObservation(request(f, { artifactPath: f.dist })),
    "WINDOWS_RELEASE_ARTIFACT_MISMATCH",
  );
  writeFileSync(f.artifactPath, Buffer.alloc(0));
  await expectRefusal(
    () => createWindowsPackObservation(request(f)),
    "WINDOWS_RELEASE_ARTIFACT_MISMATCH",
  );
  truncateSync(f.artifactPath, MAX_WINDOWS_ARTIFACT_BYTES + 1);
  await expectRefusal(
    () => createWindowsPackObservation(request(f)),
    "WINDOWS_RELEASE_ARTIFACT_MISMATCH",
  );

  const wrongName = join(f.dist, "renamed.zip");
  writeFileSync(wrongName, "not the fixed subject");
  await expectRefusal(
    () => createWindowsPackObservation(request(f, { artifactPath: wrongName })),
    "WINDOWS_RELEASE_ARTIFACT_MISMATCH",
  );

  const outside = mkdtempSync(join(tmpdir(), "moe-pack-observation-outside-"));
  roots.push(outside);
  writeFileSync(join(outside, "moe-windows.zip"), "outside");
  const redirect = join(f.dist, "redirect");
  symlinkSync(outside, redirect, process.platform === "win32" ? "junction" : "dir");
  await expectRefusal(
    () => createWindowsPackObservation(request(f, {
      artifactPath: join(redirect, "moe-windows.zip"),
    })),
    "WINDOWS_RELEASE_ARTIFACT_MISMATCH",
  );
});

test("refuses malformed, oversized, nonregular, and escaping release evidence", async () => {
  const f = fixture();
  const {
    createWindowsPackObservation,
    MAX_RELEASE_EVIDENCE_BYTES,
  } = await subject();

  const cases = [
    { name: "non-json", write: () => writeFileSync(f.releaseEvidencePath, "not-json") },
    { name: "missing source", write: () => writeFileSync(f.releaseEvidencePath, "{}") },
    { name: "oversized", write: () => truncateSync(f.releaseEvidencePath, MAX_RELEASE_EVIDENCE_BYTES + 1) },
  ];
  assert.equal(cases.length, 3);
  for (const hostile of cases) {
    hostile.write();
    await expectRefusal(
      () => createWindowsPackObservation(request(f, { releaseEvidencePath: f.releaseEvidencePath })),
      "WINDOWS_RELEASE_INPUT_INVALID",
    ).catch((error) => {
      error.message = `${hostile.name}: ${error.message}`;
      throw error;
    });
  }

  await expectRefusal(
    () => createWindowsPackObservation(request(f, { releaseEvidencePath: f.dist })),
    "WINDOWS_RELEASE_INPUT_INVALID",
  );

  const outside = mkdtempSync(join(tmpdir(), "moe-pack-evidence-outside-"));
  roots.push(outside);
  const outsideEvidence = join(outside, "evidence.json");
  writeFileSync(outsideEvidence, JSON.stringify({
    source: { objectFormat: "sha1", sourceSha: SOURCE_SHA },
  }));
  const redirect = join(f.dist, "evidence-redirect");
  symlinkSync(outside, redirect, process.platform === "win32" ? "junction" : "dir");
  await expectRefusal(
    () => createWindowsPackObservation(request(f, {
      releaseEvidencePath: join(redirect, "evidence.json"),
    })),
    "WINDOWS_RELEASE_INPUT_INVALID",
  );
});

test("output publication uses exclusive creation and persists the exact canonical bytes", async () => {
  const f = fixture();
  const bytes = await receiptBytes(f);
  const outputPath = join(f.dist, "moe-windows.zip.provenance.json");
  const { publishWindowsPackObservationOutput } = await outputSubject();
  let observedFlags = 0;

  const result = await publishWindowsPackObservationOutput(outputRequest(f, bytes, outputPath), {
    open(/** @type {string} */ path, /** @type {number} */ flags, /** @type {number} */ mode) {
      observedFlags = flags;
      return openSync(path, flags, mode);
    },
  });

  assert.equal(observedFlags & constants.O_EXCL, constants.O_EXCL);
  assert.deepEqual(result, { outputPath });
  assert.deepEqual(readFileSync(outputPath), Buffer.from(bytes));
});

test("output publication refuses parent canonical drift and removes its exact created file", async () => {
  const f = fixture();
  const bytes = await receiptBytes(f);
  const outputPath = join(f.dist, "moe-windows.zip.provenance.json");
  const outside = mkdtempSync(join(tmpdir(), "moe-pack-output-parent-drift-"));
  roots.push(outside);
  const { publishWindowsPackObservationOutput } = await outputSubject();
  let parentObservations = 0;

  await expectRefusal(
    () => publishWindowsPackObservationOutput(outputRequest(f, bytes, outputPath), {
      realpath(/** @type {string} */ path) {
        const actual = realpathSync.native(path);
        if (resolve(path) === resolve(f.dist)) {
          parentObservations += 1;
          if (parentObservations === 2) return realpathSync.native(outside);
        }
        return actual;
      },
    }),
    "WINDOWS_RELEASE_INPUT_INVALID",
  );

  assert.equal(parentObservations >= 3, true);
  assert.equal(existsSync(outputPath), false);
});

test("output publication removes its exact partial file after write or fsync failure", async () => {
  const f = fixture();
  const bytes = await receiptBytes(f);
  const outputPath = join(f.dist, "moe-windows.zip.provenance.json");
  const { publishWindowsPackObservationOutput } = await outputSubject();
  let writeCalls = 0;
  const failures = [
    {
      name: "write",
      ports: {
        write(
          /** @type {number} */ handle,
          /** @type {Uint8Array} */ value,
          /** @type {number} */ offset,
          /** @type {number} */ length,
        ) {
          writeCalls += 1;
          if (writeCalls > 1) throw new Error("injected write failure");
          return writeSync(handle, value, offset, Math.min(3, length));
        },
      },
    },
    {
      name: "fsync",
      ports: { fsync() { throw new Error("injected fsync failure"); } },
    },
  ];
  assert.equal(failures.length, 2);

  for (const failure of failures) {
    await expectRefusal(
      () => publishWindowsPackObservationOutput(outputRequest(f, bytes, outputPath), failure.ports),
      "WINDOWS_RELEASE_INPUT_INVALID",
    ).catch((error) => {
      error.message = `${failure.name}: ${error.message}`;
      throw error;
    });
    assert.equal(existsSync(outputPath), false, failure.name);
  }
});

test("output cleanup never unlinks a path whose identity differs from the opened file", async () => {
  const f = fixture();
  const bytes = await receiptBytes(f);
  const outputPath = join(f.dist, "moe-windows.zip.provenance.json");
  const { publishWindowsPackObservationOutput } = await outputSubject();
  let unlinkCalls = 0;

  await expectRefusal(
    () => publishWindowsPackObservationOutput(outputRequest(f, bytes, outputPath), {
      stat(/** @type {string} */ path) {
        const observed = statSync(path, { bigint: true });
        return resolve(path) === resolve(outputPath) ? changedInode(observed) : observed;
      },
      unlink() { unlinkCalls += 1; },
    }),
    "WINDOWS_RELEASE_INPUT_INVALID",
  );

  assert.equal(unlinkCalls, 0);
  assert.equal(existsSync(outputPath), true);
});

test("CLI accepts only the exact ordered grammar and cannot promote local observation through env", () => {
  const f = fixture();
  const outputPath = join(f.dist, "moe-windows.zip.provenance.json");
  const run = runCli(f, cliArguments(f, outputPath), {
    CI: "true",
    GITHUB_ACTIONS: "true",
    MOE_RELEASE_MODE: "CI_ATTESTED",
    MOE_RELEASE_PUBLICATION_AUTHORIZED: "true",
    WINDOWS_RELEASE_MODE: "CI_ATTESTED",
    WINDOWS_RELEASE_PUBLICATION_AUTHORIZED: "true",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(outputPath), true);
  const bytes = readFileSync(outputPath);
  const receipt = JSON.parse(bytes.toString("utf8"));
  assert.equal(receipt.mode, "LOCAL_OBSERVED");
  assert.equal(receipt.publicationAuthorized, false);
  assert.equal(receipt.artifact.name, "moe-windows.zip");
  assert.equal(receipt.releaseEvidenceDigest, sha256(f.releaseEvidenceBytes));
  assert.equal(bytes.toString("utf8"), canonical(receipt));
  const { receiptDigest, ...body } = receipt;
  assert.equal(receiptDigest, sha256(Buffer.from(canonical(body))));

  const summary = JSON.parse(run.stdout.trim());
  assert.deepEqual(summary, {
    artifact: "moe-windows.zip",
    mode: "LOCAL_OBSERVED",
    publicationAuthorized: false,
    receiptDigest,
    sourceSha: SOURCE_SHA,
  });
});

test("CLI refuses reordered, missing, extra, and escaping argv without creating output", async () => {
  const f = fixture();
  const { WINDOWS_RELEASE_AUTHORITY_LAYER } = await subject();
  const outputPath = join(f.dist, "moe-windows.zip.provenance.json");
  const exact = cliArguments(f, outputPath);
  const cases = [
    { name: "reordered", args: [exact[0] ?? "", ...exact.slice(3, 5), ...exact.slice(1, 3), ...exact.slice(5)] },
    { name: "missing", args: exact.slice(0, -2) },
    { name: "extra", args: [...exact, "--promote"] },
    { name: "outside output", args: cliArguments(f, join(dirname(f.cwd), "moe-windows.zip.provenance.json")) },
    { name: "wrong output name", args: cliArguments(f, join(f.dist, "receipt.json")) },
  ];
  assert.equal(cases.length, 5);
  for (const hostile of cases) {
    const run = runCli(f, hostile.args);
    const refusal = parseCliRefusal(run);
    assert.deepEqual(refusal, {
      code: "WINDOWS_RELEASE_INPUT_INVALID",
      layer: WINDOWS_RELEASE_AUTHORITY_LAYER,
      ok: false,
    }, hostile.name);
    assert.equal(existsSync(outputPath), false, hostile.name);
  }
});

test("CLI reports the artifact layer code when the fixed ZIP is absent", async () => {
  const f = fixture();
  const { WINDOWS_RELEASE_AUTHORITY_LAYER } = await subject();
  const outputPath = join(f.dist, "moe-windows.zip.provenance.json");
  rmSync(f.artifactPath);

  const run = runCli(f, cliArguments(f, outputPath));
  assert.deepEqual(parseCliRefusal(run), {
    code: "WINDOWS_RELEASE_ARTIFACT_MISMATCH",
    layer: WINDOWS_RELEASE_AUTHORITY_LAYER,
    ok: false,
  });
  assert.equal(existsSync(outputPath), false);
});

test("CLI preserves an existing detached receipt and reports publication conflict", async () => {
  const f = fixture();
  const { WINDOWS_RELEASE_AUTHORITY_LAYER } = await subject();
  const outputPath = join(f.dist, "moe-windows.zip.provenance.json");
  writeFileSync(outputPath, "operator-owned-existing-receipt");

  const run = runCli(f, cliArguments(f, outputPath));
  assert.deepEqual(parseCliRefusal(run), {
    code: "WINDOWS_RELEASE_PUBLICATION_CONFLICT",
    layer: WINDOWS_RELEASE_AUTHORITY_LAYER,
    ok: false,
  });
  assert.equal(readFileSync(outputPath, "utf8"), "operator-owned-existing-receipt");
});

// @ts-check
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { RELEASE_SUPPLY_CHAIN_CODE, RELEASE_SUPPLY_CHAIN_LAYER, buildReleaseSubject, releaseRefusal } from "./release-subject.mjs";
const exec = promisify(execFile); const PNPM_ENTRY = join(dirname(process.execPath), "node_modules", "corepack", "dist", "pnpm.js");
const MAX_OUTPUT = 16 * 1024 * 1024; const TIMEOUT = 180_000;
const SBOM_IGNORES = Object.freeze(["/annotations/timestamp", "/metadata/timestamp", "/serialNumber"]); const INPUT_KEYS = Object.freeze(["evidenceRoot", "platform", "repositoryRoot", "source"]); const SBOM_ROOT_TOKEN = "<SOURCE_ROOT>";
const sha256 = (/** @type {string | Uint8Array} */ value) => createHash("sha256").update(value).digest("hex");
/** @returns {string} */ function canonical(/** @type {unknown} */ value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value); return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
/** @template T @param {T} value @returns {T} */ function freeze(value) {
  if (value !== null && typeof value === "object" && !ArrayBuffer.isView(value)) {
    for (const nested of Object.values(/** @type {Record<string, unknown>} */ (value))) freeze(nested); Object.freeze(value);
  }
  return value;
}
function exactRecord(/** @type {unknown} */ value, /** @type {readonly string[]} */ keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const actual = Object.keys(value).sort(); const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  } catch { return false; }
}
function validSource(/** @type {unknown} */ value) {
  if (!exactRecord(value, ["objectFormat", "sourceSha"])) return false;
  const source = /** @type {Record<string, unknown>} */ (value);
  const length = source.objectFormat === "sha1" ? 40 : source.objectFormat === "sha256" ? 64 : 0;
  return typeof source.sourceSha === "string" && source.sourceSha.length === length
    && /^[0-9a-f]+$/u.test(source.sourceSha);
}
function validInput(/** @type {unknown} */ value) {
  if (!exactRecord(value, INPUT_KEYS)) return false;
  const input = /** @type {Record<string, unknown>} */ (value);
  return typeof input.evidenceRoot === "string" && isAbsolute(input.evidenceRoot) && typeof input.repositoryRoot === "string" && isAbsolute(input.repositoryRoot) && typeof input.platform === "string";
}
async function command(/** @type {string} */ file, /** @type {string[]} */ args, /** @type {string} */ cwd) {
  try {
    const result = await exec(file, args, { cwd, encoding: "utf8", maxBuffer: MAX_OUTPUT, timeout: TIMEOUT, windowsHide: true });
    return { exitCode: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    const failure = /** @type {{code?: number, stderr?: string, stdout?: string}} */ (error);
    return { exitCode: typeof failure.code === "number" ? failure.code : 1, stderr: failure.stderr ?? "", stdout: failure.stdout ?? "" };
  }
}
async function archiveSource(/** @type {Record<string, unknown>} */ request) {
  const repositoryRoot = String(request.repositoryRoot); const destination = String(request.destination);
  const sourceSha = String(request.sourceSha); const archive = `${destination}.tar`;
  mkdirSync(destination, { recursive: true });
  try {
    const packed = await command("git", ["archive", "--format=tar", `--output=${archive}`, sourceSha], repositoryRoot);
    if (packed.exitCode !== 0) return releaseRefusal("SOURCE_ARCHIVE_FAILED");
    const extracted = await command("tar", ["-xf", archive, "-C", destination], repositoryRoot);
    return extracted.exitCode === 0 ? { destination, ok: true } : releaseRefusal("SOURCE_ARCHIVE_FAILED");
  } finally { rmSync(archive, { force: true }); }
}
async function pnpmCommand(/** @type {string[]} */ args, /** @type {string} */ cwd) {
  try { const entry = realpathSync(PNPM_ENTRY); const nodeRoot = realpathSync(dirname(process.execPath));
    if (relative(nodeRoot, entry).startsWith("..") || basename(entry) !== "pnpm.js") return { exitCode: 1, stderr: "pnpm entry invalid", stdout: "" };
    return command(process.execPath, [entry, ...args], cwd); } catch { return { exitCode: 1, stderr: "pnpm entry missing", stdout: "" }; }
}
const frozenInstall = (/** @type {{sourceRoot: string}} */ request) =>
  pnpmCommand(["install", "--frozen-lockfile"], request.sourceRoot);
const generateAudit = (/** @type {{sourceRoot: string}} */ request) =>
  pnpmCommand(["audit", "--prod", "--json"], request.sourceRoot);
const generateLicenses = (/** @type {{sourceRoot: string}} */ request) =>
  pnpmCommand(["licenses", "list", "--prod", "--json"], request.sourceRoot);
async function generateSbom(/** @type {{sourceRoot: string}} */ request) {
  const executable = join(request.sourceRoot, "node_modules", "@cyclonedx", "cdxgen", "bin", "cdxgen.js"); const output = join(request.sourceRoot, "node_modules", ".release-bom.json");
  if (!existsSync(executable)) return { exitCode: 1, stderr: "cdxgen missing", stdout: "" };
  const run = await command(process.execPath, [executable, "-t", "js", "-o", output, request.sourceRoot], request.sourceRoot);
  return run.exitCode !== 0 ? run : existsSync(output) ? { exitCode: 0, stderr: run.stderr, stdout: readFileSync(output, "utf8") } : { exitCode: 1, stderr: "sbom output missing", stdout: "" };
}
async function resolveSource(/** @type {{repositoryRoot: string}} */ request) {
  const sha = await command("git", ["rev-parse", "HEAD"], request.repositoryRoot);
  const format = await command("git", ["rev-parse", "--show-object-format"], request.repositoryRoot);
  return sha.exitCode === 0 && format.exitCode === 0
    ? { objectFormat: format.stdout.trim(), sourceSha: sha.stdout.trim() }
    : undefined;
}
async function observeTools(/** @type {{repositoryRoot: string}} */ request) {
  const cdxgen = join(request.repositoryRoot, "node_modules", "@cyclonedx", "cdxgen", "bin", "cdxgen.js");
  if (!existsSync(cdxgen)) return undefined;
  const probes = await Promise.all([
    command(process.execPath, ["--version"], request.repositoryRoot),
    pnpmCommand(["--version"], request.repositoryRoot),
    command("git", ["--version"], request.repositoryRoot),
    command("tar", ["--version"], request.repositoryRoot),
    command(process.execPath, [cdxgen, "--version"], request.repositoryRoot),
  ]);
  if (probes.some((probe) => probe.exitCode !== 0)) return undefined;
  const cdxgenVersion = probes[4].stdout.match(/\b\d+\.\d+\.\d+\b/u)?.[0]; if (!cdxgenVersion) return undefined;
  return { node: probes[0].stdout.trim().replace(/^v/u, ""), pnpm: probes[1].stdout.trim(),
    git: probes[2].stdout.trim(), tar: probes[3].stdout.split(/\r?\n/u)[0], cdxgen: cdxgenVersion };
}
function unsafeExistingPath(/** @type {string} */ root) {
  try {
    let cursor = resolve(root);
    while (!existsSync(cursor)) { const parent = dirname(cursor); if (parent === cursor) break; cursor = parent; }
    while (existsSync(cursor)) {
      if (lstatSync(cursor).isSymbolicLink()) return true;
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
    return false;
  } catch { return true; }
}
function publishEvidence(/** @type {{bytes: Uint8Array, evidencePath: string, evidenceRoot: string}} */ request) {
  const root = resolve(request.evidenceRoot); const target = resolve(request.evidencePath);
  if (relative(root, target).startsWith("..") || unsafeExistingPath(root)) return releaseRefusal("OUTPUT_PATH_INVALID");
  if (existsSync(target)) {
    return Buffer.from(readFileSync(target)).equals(Buffer.from(request.bytes))
      ? { ok: true, reused: true } : releaseRefusal("EVIDENCE_PUBLICATION_CONFLICT");
  }
  const targetDir = dirname(target); const temporary = `${targetDir}.tmp-${process.pid}-${randomUUID()}`;
  try {
    mkdirSync(dirname(targetDir), { recursive: true });
    mkdirSync(temporary, { recursive: false });
    writeFileSync(join(temporary, basename(target)), request.bytes, { flag: "wx" });
    renameSync(temporary, targetDir);
    return { ok: true, reused: false };
  } catch {
    rmSync(temporary, { force: true, recursive: true });
    if (existsSync(target) && Buffer.from(readFileSync(target)).equals(Buffer.from(request.bytes))) return { ok: true, reused: true };
    return releaseRefusal("EVIDENCE_WRITE_INTERRUPTED");
  }
}
const SYSTEM_PORTS = Object.freeze({ archiveSource, buildSubject: buildReleaseSubject, frozenInstall,
  generateAudit, generateLicenses, generateSbom, observeTools, publishEvidence,
  readSourceFile: (/** @type {string} */ root, /** @type {string} */ path) => readFileSync(join(root, path)),
  resolveSource });
function parseJson(/** @type {{exitCode: number, stdout: string}} */ result) {
  if (result.exitCode !== 0) return undefined;
  try { return JSON.parse(result.stdout); } catch { return undefined; }
}
function sbomComponentCount(/** @type {unknown} */ value) {
  const sbom = /** @type {Record<string, unknown>} */ (value);
  return sbom?.bomFormat === "CycloneDX" && Array.isArray(sbom.components)
    ? sbom.components.length : 0;
}
function reports(/** @type {unknown} */ sbom, /** @type {unknown} */ audit, /** @type {unknown} */ licenses) {
  const s = /** @type {Record<string, unknown>} */ (sbom); const a = /** @type {Record<string, unknown>} */ (audit);
  const l = /** @type {Record<string, unknown>} */ (licenses); const metadata = /** @type {Record<string, unknown>} */ (a?.metadata);
  const components = sbomComponentCount(s);
  const dependencies = Number(metadata?.dependencies ?? metadata?.totalDependencies ?? 0);
  const licenseGroups = l && typeof l === "object" ? Object.keys(l) : [];
  const packageCount = licenseGroups.reduce((sum, key) => sum + (Array.isArray(l[key]) ? l[key].length : 0), 0);
  if (components === 0) return releaseRefusal("SBOM_REPORT_INVALID");
  if (!a || dependencies <= 0 || !a.advisories || typeof a.advisories !== "object") return releaseRefusal("DEPENDENCY_AUDIT_INVALID");
  if (Object.keys(/** @type {object} */ (a.advisories)).length > 0) return releaseRefusal("DEPENDENCY_AUDIT_FAILED");
  if (licenseGroups.length === 0 || packageCount === 0) return releaseRefusal("LICENSE_REPORT_INVALID");
  return { audit: { advisoryCount: 0, dependencyCount: dependencies }, licenses: { licenseGroupCount: licenseGroups.length, packageCount }, sbom: { componentCount: components } };
}
function normalizedSbom(/** @type {unknown} */ sbom, /** @type {string} */ sourceRoot) {
  const value = /** @type {Record<string, unknown>} */ (structuredClone(sbom));
  delete value.serialNumber;
  const metadata = /** @type {Record<string, unknown>} */ (value.metadata);
  if (metadata && typeof metadata === "object") delete metadata.timestamp;
  for (const entry of Array.isArray(value.annotations) ? value.annotations : []) delete entry.timestamp;
  return [JSON.stringify(sourceRoot).slice(1, -1), sourceRoot.split("\\").join("/")]
    .reduce((text, path) => text.split(path).join(SBOM_ROOT_TOKEN), canonical(value));
}
function buildReceipt(/** @type {Record<string, unknown>} */ subject, /** @type {number} */ buildIndex,
  /** @type {Record<string, string>} */ sourceDigests, /** @type {string} */ sbomRaw, /** @type {unknown} */ sbom, /** @type {string} */ sourceRoot) {
  const containers = /** @type {Array<Record<string, unknown>>} */ (subject.containers).map((entry) => ({
    assetDigests: entry.assetDigests, componentId: entry.componentId,
    containerDigest: sha256(/** @type {Uint8Array} */ (entry.containerBytes)),
    manifestDigest: sha256(/** @type {Uint8Array} */ (entry.manifestBytes)),
  })).sort((left, right) => String(left.componentId).localeCompare(String(right.componentId)));
  return { buildIndex, containers, sourceDigests, subjectReceipt: subject.receipt,
    sbomNormalizedDigest: sha256(normalizedSbom(sbom, sourceRoot)), sbomRawDigest: sha256(sbomRaw), verificationKeyUse: subject.verificationKeyUse };
}
function cleanRoots(/** @type {string[]} */ roots) {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true }); rmSync(`${root}.tar`, { force: true });
  }
}
/** Run the Windows evidence recorder. Success records UNKNOWN release authority, never publication. */ export async function runReleaseSupplyChain(/** @type {unknown} */ value, /** @type {Record<string, unknown>} */ injected = {}) {
  if (!validInput(value)) return releaseRefusal("OUTPUT_PATH_INVALID");
  const input = /** @type {Record<string, unknown>} */ (value);
  if (!validSource(input.source)) return releaseRefusal("SOURCE_PROVENANCE_INVALID");
  if (input.platform !== "win32") return releaseRefusal("SUPPORTED_OS_EVIDENCE_MISSING");
  const ports = { ...SYSTEM_PORTS, ...injected }; const source = /** @type {{objectFormat: string, sourceSha: string}} */ (input.source);
  const observed = await ports.resolveSource({ repositoryRoot: String(input.repositoryRoot) });
  if (!observed || observed.objectFormat !== source.objectFormat || observed.sourceSha !== source.sourceSha) return releaseRefusal("SOURCE_PROVENANCE_INVALID");
  const tools = await ports.observeTools({ repositoryRoot: String(input.repositoryRoot) });
  if (!tools) return releaseRefusal("FROZEN_INSTALL_FAILED");
  if (tools.node !== "24.16.0" || tools.pnpm !== "11.0.8" || tools.cdxgen !== "12.8.2") return releaseRefusal("TOOLCHAIN_IDENTITY_MISMATCH");
  const { privateKey } = generateKeyPairSync("ed25519"); const roots = /** @type {string[]} */ ([]);
  const stop = () => { cleanRoots(roots); process.exit(130); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const builds = []; let firstAudit; let firstLicenses; let firstSbom; let firstSbomValue;
    for (let buildIndex = 1; buildIndex <= 2; buildIndex += 1) {
      const root = mkdtempSync(join(tmpdir(), "moe-release-build-")); roots.push(root);
      const archived = await ports.archiveSource({ destination: root, repositoryRoot: input.repositoryRoot, sourceSha: source.sourceSha });
      if (!archived?.ok) return "code" in archived ? archived : releaseRefusal("SOURCE_ARCHIVE_FAILED");
      const before = { lock: sha256(ports.readSourceFile(root, "pnpm-lock.yaml")), package: sha256(ports.readSourceFile(root, "package.json")) };
      const installed = await ports.frozenInstall({ sourceRoot: root });
      if (installed.exitCode !== 0) return releaseRefusal("FROZEN_INSTALL_FAILED");
      const after = { lock: sha256(ports.readSourceFile(root, "pnpm-lock.yaml")), package: sha256(ports.readSourceFile(root, "package.json")) };
      if (canonical(before) !== canonical(after)) return releaseRefusal("REPRODUCIBILITY_MISMATCH");
      const subject = await ports.buildSubject({ privateKey, signingKeyId: "ephemeral-release-verification", source, sourceRoot: root });
      if (!subject.ok) return subject;
      if (subject.componentCount !== 5 || subject.templateCount !== 3) return releaseRefusal("RELEASE_INVENTORY_EMPTY");
      const sbomRun = await ports.generateSbom({ sourceRoot: root });
      if (sbomRun.exitCode !== 0) return releaseRefusal("SBOM_GENERATION_FAILED");
      const sbomValue = parseJson(sbomRun); if (sbomComponentCount(sbomValue) === 0) return releaseRefusal("SBOM_REPORT_INVALID");
      if (buildIndex === 1) { firstSbom = sbomRun; firstSbomValue = sbomValue; firstAudit = await ports.generateAudit({ sourceRoot: root }); firstLicenses = await ports.generateLicenses({ sourceRoot: root }); }
      builds.push(buildReceipt(subject, buildIndex, { lockAfter: after.lock, lockBefore: before.lock, packageAfter: after.package, packageBefore: before.package }, sbomRun.stdout, sbomValue, root));
    }
    if (!firstSbom || !firstAudit || !firstLicenses) return releaseRefusal("RELEASE_INVENTORY_EMPTY");
    if (firstAudit.exitCode !== 0) return releaseRefusal("DEPENDENCY_AUDIT_FAILED");
    if (firstLicenses.exitCode !== 0) return releaseRefusal("LICENSE_REPORT_FAILED");
    const parsed = reports(firstSbomValue, parseJson(firstAudit), parseJson(firstLicenses)); if ("code" in parsed) return parsed;
    const [firstBuild, secondBuild] = builds;
    if (!firstBuild || !secondBuild || canonical(firstBuild.containers) !== canonical(secondBuild.containers)
      || firstBuild.sbomNormalizedDigest !== secondBuild.sbomNormalizedDigest) return releaseRefusal("REPRODUCIBILITY_MISMATCH");
    const evidence = freeze({ audit: { ...parsed.audit, digest: sha256(firstAudit.stdout) }, buildCount: 2, builds,
      componentCount: 5, doctor: { missingSymbol: "@moe/daemon.collectDoctorVersionReport", reason: "DOCTOR_COMPATIBILITY_UNAVAILABLE", status: "UNKNOWN" },
      licenses: { ...parsed.licenses, digest: sha256(firstLicenses.stdout) }, operation: "RECORDED",
      os: [{ platform: "win32", status: "PASS" }, { deferredTaskId: "task-e87a735386f643fe92c0eeff09bc4275", platform: "linux", reason: "SUPPORTED_OS_EVIDENCE_MISSING", status: "UNKNOWN" }, { deferredTaskId: "task-e94b2055e281489ea9e97820919f6856", platform: "darwin", reason: "SUPPORTED_OS_EVIDENCE_MISSING", status: "UNKNOWN" }],
      publicationAuthorized: false, releaseVerdict: "UNKNOWN", sbom: { ...parsed.sbom, digest: sha256(firstSbom.stdout), normalizedPointers: SBOM_IGNORES, normalizedSourceRootToken: SBOM_ROOT_TOKEN }, source, templateCount: 3, tools });
    const bytes = new TextEncoder().encode(canonical(evidence)); const evidenceDigest = sha256(bytes);
    const evidencePath = join(String(input.evidenceRoot), source.sourceSha, evidenceDigest, "evidence.json");
    const published = await ports.publishEvidence({ bytes, evidencePath, evidenceRoot: String(input.evidenceRoot) });
    if ("code" in published) return published;
    return freeze({ evidence, evidenceDigest, evidencePath, ok: true, reused: published.reused });
  } catch { return releaseRefusal("EVIDENCE_WRITE_INTERRUPTED"); }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); cleanRoots(roots); }
}
export function parseReleaseArguments(/** @type {string[]} */ argv) {
  if (argv.length === 1 && argv[0] === "--head") return Object.freeze({ mode: "HEAD", ok: true });
  if (argv.length !== 2 || argv[0] !== "--source-sha" || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u.test(argv[1] ?? "")) return releaseRefusal("CLI_ARGUMENT_INVALID");
  return Object.freeze({ ok: true, sourceSha: argv[1] });
}
async function main() {
  const parsed = parseReleaseArguments(process.argv.slice(2)); if (!parsed.ok) { console.error(JSON.stringify(parsed)); process.exitCode = 1; return; }
  const repositoryRoot = realpathSync(process.cwd()); const source = await resolveSource({ repositoryRoot });
  if (!source || ("sourceSha" in parsed && source.sourceSha !== parsed.sourceSha)) { console.error(JSON.stringify(releaseRefusal("SOURCE_PROVENANCE_INVALID"))); process.exitCode = 1; return; }
  const result = await runReleaseSupplyChain({ evidenceRoot: join(repositoryRoot, "dist", "release"), platform: process.platform, repositoryRoot, source });
  console.log(JSON.stringify(result.ok ? { componentCount: result.evidence.componentCount, evidencePath: result.evidencePath, operation: result.evidence.operation, publicationAuthorized: result.evidence.publicationAuthorized, releaseVerdict: result.evidence.releaseVerdict, reportCount: 3, sourceSha: source.sourceSha } : result));
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

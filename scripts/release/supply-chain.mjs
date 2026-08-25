// @ts-check
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { collectDoctorVersionReport } from "@moe/daemon";
import { RELEASE_COMPONENTS, RELEASE_SUPPLY_CHAIN_CODE, RELEASE_SUPPLY_CHAIN_LAYER, buildReleaseSubject, releaseRefusal } from "./release-subject.mjs";
const exec = promisify(execFile);
const MAX_OUTPUT = 16 * 1024 * 1024; const TIMEOUT = 180_000;
const RELEASE_COMPONENT_COUNT = RELEASE_COMPONENTS.length;
const SBOM_IGNORES = Object.freeze(["/annotations/timestamp", "/metadata/timestamp", "/serialNumber"]); const INPUT_KEYS = Object.freeze(["evidenceRoot", "platform", "repositoryRoot", "source"]); const SBOM_ROOT_TOKEN = "<SOURCE_ROOT>";
const DOCTOR_KEYS = Object.freeze(["componentCount", "componentInventory", "components", "declared", "observed", "pins", "reportVersion"]);
const DOCTOR_OBSERVED_KEYS = Object.freeze(["arch", "node", "platform", "pnpm"]);
const DOCTOR_DECLARED_KEYS = Object.freeze(["enginesNode", "enginesPnpm", "nodeVersionFile", "packageManager"]);
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
export async function archiveSource(
  /** @type {Record<string, unknown>} */ request,
  /** @type {{rmSync?: typeof rmSync}} */ dependencies = {},
) {
  const repositoryRoot = String(request.repositoryRoot); const destination = String(request.destination);
  const sourceSha = String(request.sourceSha); const archive = `${destination}.tar`; const removeArchive = dependencies.rmSync ?? rmSync;
  mkdirSync(destination, { recursive: true });
  try {
    const packed = await command("git", ["archive", "--format=tar", `--output=${archive}`, sourceSha], repositoryRoot);
    if (packed.exitCode !== 0) return releaseRefusal("SOURCE_ARCHIVE_FAILED");
    const extracted = await command("tar", ["-xf", archive, "-C", destination], repositoryRoot);
    return extracted.exitCode === 0 ? { destination, ok: true } : releaseRefusal("SOURCE_ARCHIVE_FAILED");
  } finally {
    // Subordinate cleanup must report without replacing the computed archive result.
    try { removeArchive(archive, { force: true }); }
    catch (error) { console.error(`release temporary cleanup failed: ${archive}: ${String(error)}`); }
  }
}
export function escapesRoot(/** @type {string} */ root, /** @type {string} */ path) { // Pure containment probe. On win32 a cross-drive `relative()` answers an ABSOLUTE path, which does not start with "..", so the classic startsWith test alone silently passes a target redirected to another drive.
  const rel = relative(root, path);
  return rel.startsWith("..") || isAbsolute(rel);
}
/** @typedef {{readonly file: string, readonly prefixArgs: readonly string[]}} PnpmLaunch */
const immutablePnpmLaunch = (/** @type {string} */ file, /** @type {readonly string[]} */ prefixArgs) =>
  Object.freeze({ file, prefixArgs: Object.freeze([...prefixArgs]) });
export function resolvePnpmLaunch(/** @type {NodeJS.ProcessEnv} */ environment = process.env) {
  const pnpmHome = environment.PNPM_HOME;
  if (typeof pnpmHome === "string" && pnpmHome.length > 0) {
    try {
      const home = realpathSync(pnpmHome); const installRoot = realpathSync(resolve(home, ".."));
      const packageRoot = realpathSync(join(installRoot, "pnpm"));
      const entryName = existsSync(join(packageRoot, "bin", "pnpm.mjs")) ? "pnpm.mjs" : "pnpm.cjs";
      const entry = realpathSync(join(packageRoot, "bin", entryName));
      if (basename(home) !== ".bin" || escapesRoot(installRoot, home) || escapesRoot(installRoot, packageRoot)
        || escapesRoot(packageRoot, entry) || basename(entry) !== entryName || !lstatSync(entry).isFile()) return undefined;
      return immutablePnpmLaunch(process.execPath, [entry]);
    } catch { return undefined; }
  }
  const pathValue = Object.entries(environment).find(([key]) => key.toUpperCase() === "PATH")?.[1];
  if (typeof pathValue !== "string") return undefined;
  for (const directory of pathValue.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const entry = realpathSync(join(directory, process.platform === "win32" ? "pnpm.exe" : "pnpm"));
      if (!lstatSync(entry).isFile()) continue;
      if (process.platform === "win32") {
        if (basename(entry).toLowerCase() === "pnpm.exe") return immutablePnpmLaunch(entry, []);
      } else if (basename(entry) === "pnpm.cjs" || basename(entry) === "pnpm.js") {
        return immutablePnpmLaunch(process.execPath, [entry]);
      } else return immutablePnpmLaunch(entry, []);
    } catch { /* Try the next absolute PATH entry. */ }
  }
  return undefined;
}
const pnpmCommand = (/** @type {PnpmLaunch} */ launch, /** @type {string[]} */ args,
  /** @type {string} */ cwd) => command(launch.file, [...launch.prefixArgs, ...args], cwd);
const frozenInstall = (/** @type {{pnpmLaunch: PnpmLaunch, sourceRoot: string}} */ request) =>
  pnpmCommand(request.pnpmLaunch, ["install", "--frozen-lockfile"], request.sourceRoot);
const generateAudit = (/** @type {{pnpmLaunch: PnpmLaunch, sourceRoot: string}} */ request) =>
  pnpmCommand(request.pnpmLaunch, ["audit", "--prod", "--json"], request.sourceRoot);
const generateLicenses = (/** @type {{pnpmLaunch: PnpmLaunch, sourceRoot: string}} */ request) =>
  pnpmCommand(request.pnpmLaunch, ["licenses", "list", "--prod", "--json"], request.sourceRoot);
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
async function observeTools(/** @type {{pnpmLaunch: PnpmLaunch, repositoryRoot: string}} */ request) {
  const cdxgen = join(request.repositoryRoot, "node_modules", "@cyclonedx", "cdxgen", "bin", "cdxgen.js");
  if (!existsSync(cdxgen)) return undefined;
  const probes = await Promise.all([
    command(process.execPath, ["--version"], request.repositoryRoot),
    pnpmCommand(request.pnpmLaunch, ["--version"], request.repositoryRoot),
    command("git", ["--version"], request.repositoryRoot),
    command("tar", ["--version"], request.repositoryRoot),
    command(process.execPath, [cdxgen, "--version"], request.repositoryRoot),
  ]);
  if (probes.some((probe) => probe.exitCode !== 0)) return undefined;
  const cdxgenVersion = probes[4].stdout.match(/\b\d+\.\d+\.\d+\b/u)?.[0]; if (!cdxgenVersion) return undefined;
  return { node: probes[0].stdout.trim().replace(/^v/u, ""), pnpm: probes[1].stdout.trim(),
    git: probes[2].stdout.trim(), tar: probes[3].stdout.split(/\r?\n/u)[0], cdxgen: cdxgenVersion };
}
function nearestExistingPath(/** @type {string} */ path) { // The deepest ancestor that exists, so the walk below only ever lstats real entries, PLUS whether the span skipped over a DANGLING link — one whose target is gone, so existsSync reads false while lstat still sees the reparse point. The walk never visits those, so without this probe a planted redirect passes containment and only surfaces later as a write error.
  let cursor = resolve(path); let dangling = false;
  while (!existsSync(cursor)) {
    try { if (lstatSync(cursor).isSymbolicLink()) dangling = true; } catch (error) { if (/** @type {{code?: string}} */ (error).code !== "ENOENT") dangling = true; }
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  return { cursor, dangling };
}
function unsafeExistingPath(/** @type {string} */ target, /** @type {string} */ ceiling) { // Bounded at the caller-frozen ceiling, INCLUSIVE. Above that boundary the caller controls nothing, so a legitimate symlinked ancestor there is not an escape (macOS $TMPDIR is /var/folders/..., and /var is itself a symlink to /private/var).
  try {
    const start = nearestExistingPath(target);
    if (start.dangling) return true; // Only the target's span is probed: it strictly contains the root's whenever the root is absent, and when the root exists its own span is empty.
    let cursor = start.cursor;
    while (existsSync(cursor)) {
      if (lstatSync(cursor).isSymbolicLink()) return true;
      if (cursor === ceiling) break;
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
    return false;
  } catch { return true; }
}
function containmentCeiling(/** @type {string} */ evidenceRoot, /** @type {string | undefined} */ repositoryRoot) { // Default bound: the evidence root's nearest EXISTING ancestor — it cannot be the root itself, because on a clean checkout dist/release does not exist yet, the cursor never equals it, and the walk would run to the filesystem root. But when the evidence root sits INSIDE the repository, the ceiling rises to the repository root: a junction standing BETWEEN them (production's evidenceRoot is <repo>/dist/release and dist/ is gitignored, so plantable) would otherwise sit ABOVE the near bound whenever its outside target contains the remaining segments, and the walk would break before ever lstat'ing it.
  const near = nearestExistingPath(evidenceRoot).cursor;
  if (repositoryRoot === undefined) return near;
  const repo = resolve(repositoryRoot);
  return escapesRoot(repo, evidenceRoot) || !existsSync(repo) ? near : repo;
}
export function publishEvidence(/** @type {{bytes: Uint8Array, evidencePath: string, evidenceRoot: string, repositoryRoot?: string}} */ request,
  /** @type {{mkdirSync?: typeof mkdirSync}} */ dependencies = {}) {
  const root = resolve(request.evidenceRoot); const target = resolve(request.evidencePath);
  const makeDirectory = dependencies.mkdirSync ?? mkdirSync;
  // Walk the TARGET chain, not just the root's: a junction planted between evidenceRoot and the
  // target (e.g. dist/release/<sha>), or one standing at the root itself, refuses instead of
  // silently redirecting durable evidence. The ceiling is FROZEN here: the post-write re-guards
  // below must walk the same span, not one shrunk onto directories this call just created.
  const ceiling = containmentCeiling(root, request.repositoryRoot);
  if (escapesRoot(root, target) || unsafeExistingPath(target, ceiling)) return releaseRefusal("OUTPUT_PATH_INVALID");
  if (existsSync(target)) {
    return Buffer.from(readFileSync(target)).equals(Buffer.from(request.bytes))
      ? { ok: true, reused: true } : releaseRefusal("EVIDENCE_PUBLICATION_CONFLICT");
  }
  const targetDir = dirname(target); const temporary = `${targetDir}.tmp-${process.pid}-${randomUUID()}`;
  try {
    makeDirectory(dirname(targetDir), { recursive: true });
    makeDirectory(temporary, { recursive: false });
    writeFileSync(join(temporary, basename(target)), request.bytes, { flag: "wx" });
    renameSync(temporary, targetDir);
    // Re-guard AFTER the write: a junction born between the guard above and the rename redirects
    // every byte outside the root while still answering ok. The bytes at this exit are OURS — the
    // wx write and the rename both succeeded — so best-effort unlink the escaped file before
    // refusing to adopt it. The catch below must NOT do the same: its comparison bytes belong to a
    // concurrent publisher whose rename won, and removing them would destroy real evidence.
    if (unsafeExistingPath(target, ceiling)) {
      try { rmSync(target, { force: true }); } catch (error) { console.error(`release escaped evidence cleanup failed: ${target}: ${String(error)}`); }
      return releaseRefusal("OUTPUT_PATH_INVALID");
    }
    return { ok: true, reused: false };
  } catch {
    rmSync(temporary, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    // Same window, third ok-exit: without this re-guard the comparison below reads the bytes back
    // THROUGH a planted junction and adopts foreign-redirected content as reused evidence.
    if (unsafeExistingPath(target, ceiling)) return releaseRefusal("OUTPUT_PATH_INVALID");
    if (existsSync(target) && Buffer.from(readFileSync(target)).equals(Buffer.from(request.bytes))) return { ok: true, reused: true };
    return releaseRefusal("EVIDENCE_WRITE_INTERRUPTED");
  }
}
const SYSTEM_PORTS = Object.freeze({ archiveSource, buildSubject: buildReleaseSubject, frozenInstall,
  collectDoctorVersionReport, generateAudit, generateLicenses, generateSbom, observeTools, publishEvidence,
  readSourceFile: (/** @type {string} */ root, /** @type {string} */ path) => readFileSync(join(root, path)),
  resolvePnpmLaunch, resolveSource });
function jsonTree(/** @type {unknown} */ value, /** @type {Set<object>} */ stack = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== "object" || stack.has(value)) return false;
  const array = Array.isArray(value); const prototype = Object.getPrototypeOf(value);
  if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) return false;
  const keys = Reflect.ownKeys(value); const expected = array ? value.length + 1 : keys.length;
  if (keys.length !== expected || keys.some((key) => typeof key !== "string")) return false;
  stack.add(value);
  try {
    if (array) {
      if (!keys.includes("length")) return false;
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor) || !jsonTree(descriptor.value, stack)) return false;
      }
      return true;
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor) || !jsonTree(descriptor.value, stack)) return false;
    }
    return true;
  } finally { stack.delete(value); }
}
function validDoctorReport(/** @type {unknown} */ value) {
  if (!jsonTree(value) || !exactRecord(value, DOCTOR_KEYS)) return false;
  const report = /** @type {Record<string, unknown>} */ (value);
  if (!exactRecord(report.observed, DOCTOR_OBSERVED_KEYS)
    || !exactRecord(report.declared, DOCTOR_DECLARED_KEYS)) return false;
  const count = report.componentCount;
  return report.reportVersion === "moe-doctor-version-report/1"
    && Array.isArray(report.pins) && report.pins.length === 4
    && Array.isArray(report.components) && Number.isSafeInteger(count)
    && !Object.is(count, -0) && Number(count) >= 0 && count === report.components.length;
}
async function observeDoctor(/** @type {() => Promise<unknown>} */ collect) {
  try {
    const snapshot = structuredClone(await collect());
    if (!validDoctorReport(snapshot)) return undefined;
    canonical(snapshot);
    return freeze(snapshot);
  } catch { return undefined; }
}
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
function cleanRoots(/** @type {string[]} */ roots) { // Subordinate: a throw here escapes the caller's finally and REPLACES the real refusal or success (Windows EBUSY on a held handle), so report each failure and keep removing the remaining roots.
  for (const root of roots.splice(0)) {
    try { rmSync(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }); rmSync(`${root}.tar`, { force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) { console.error(`release temporary cleanup failed: ${root}: ${String(error)}`); }
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
  const pnpmLaunch = await ports.resolvePnpmLaunch(process.env);
  if (!pnpmLaunch) return releaseRefusal("TOOLCHAIN_OBSERVATION_FAILED");
  const tools = await ports.observeTools({ pnpmLaunch, repositoryRoot: String(input.repositoryRoot) });
  if (!tools) return releaseRefusal("TOOLCHAIN_OBSERVATION_FAILED");
  if (tools.node !== "24.16.0" || tools.pnpm !== "11.0.8" || tools.cdxgen !== "12.8.2") return releaseRefusal("TOOLCHAIN_IDENTITY_MISMATCH");
  const doctor = await observeDoctor(ports.collectDoctorVersionReport);
  if (!doctor) return releaseRefusal("TOOLCHAIN_OBSERVATION_FAILED");
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
      const installed = await ports.frozenInstall({ pnpmLaunch, sourceRoot: root });
      if (installed.exitCode !== 0) return releaseRefusal("FROZEN_INSTALL_FAILED");
      const after = { lock: sha256(ports.readSourceFile(root, "pnpm-lock.yaml")), package: sha256(ports.readSourceFile(root, "package.json")) };
      if (canonical(before) !== canonical(after)) return releaseRefusal("REPRODUCIBILITY_MISMATCH");
      const subject = await ports.buildSubject({ privateKey, signingKeyId: "ephemeral-release-verification", source, sourceRoot: root });
      if (!subject.ok) return subject;
      if (subject.componentCount !== RELEASE_COMPONENT_COUNT || subject.templateCount !== 3) return releaseRefusal("RELEASE_INVENTORY_EMPTY");
      const sbomRun = await ports.generateSbom({ sourceRoot: root });
      if (sbomRun.exitCode !== 0) return releaseRefusal("SBOM_GENERATION_FAILED");
      const sbomValue = parseJson(sbomRun); if (sbomComponentCount(sbomValue) === 0) return releaseRefusal("SBOM_REPORT_INVALID");
      if (buildIndex === 1) { firstSbom = sbomRun; firstSbomValue = sbomValue; firstAudit = await ports.generateAudit({ pnpmLaunch, sourceRoot: root }); firstLicenses = await ports.generateLicenses({ pnpmLaunch, sourceRoot: root }); }
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
      componentCount: RELEASE_COMPONENT_COUNT, doctor,
      licenses: { ...parsed.licenses, digest: sha256(firstLicenses.stdout) }, operation: "RECORDED",
      os: [{ platform: "win32", status: "PASS" }, { deferredTaskId: "task-e87a735386f643fe92c0eeff09bc4275", platform: "linux", reason: "SUPPORTED_OS_EVIDENCE_MISSING", status: "UNKNOWN" }, { deferredTaskId: "task-e94b2055e281489ea9e97820919f6856", platform: "darwin", reason: "SUPPORTED_OS_EVIDENCE_MISSING", status: "UNKNOWN" }],
      publicationAuthorized: false, releaseVerdict: "UNKNOWN", sbom: { ...parsed.sbom, digest: sha256(firstSbom.stdout), normalizedPointers: SBOM_IGNORES, normalizedSourceRootToken: SBOM_ROOT_TOKEN }, source, templateCount: 3, tools });
    const bytes = new TextEncoder().encode(canonical(evidence)); const evidenceDigest = sha256(bytes);
    const evidencePath = join(String(input.evidenceRoot), source.sourceSha, evidenceDigest, "evidence.json");
    const published = await ports.publishEvidence({ bytes, evidencePath, evidenceRoot: String(input.evidenceRoot), repositoryRoot: String(input.repositoryRoot) });
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

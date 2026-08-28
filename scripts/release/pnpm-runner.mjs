// @ts-check
/**
 * Verified launcher for the pnpm that `pnpm/action-setup` installs.
 *
 * The action publishes its destination as `PNPM_HOME=<dest>/node_modules/.bin`, which is NOT
 * adjacent to the Node installation, so a node-adjacent Corepack lookup cannot find it. A bare
 * PATH hit is equally unusable here: whatever entry happens to come first would silently become
 * release supply-chain authority. This module therefore accepts exactly one source of truth -
 * the action handoff - proves its location and complete package-tree bytes against tracked pins,
 * and runs the verified JavaScript entry through `process.execPath` with `shell:false`. Location
 * and bytes are both re-proved immediately before spawn, closing the resolve-to-run swap window.
 */
import { execFile } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { promisify } from "node:util";
import {
  capturePackTreeIdentity, normalizedTreeSha256,
} from "../../tools/packaging/pack-tool-identity.ts";
import { readToolchainPins } from "../../tools/packaging/toolchain-pins.ts";
import { releaseRefusal } from "./release-subject.mjs";

const exec = promisify(execFile);
const MAX_OUTPUT = 16 * 1024 * 1024;
const TIMEOUT = 180_000;
const PACKAGE_NAME = "pnpm";
const ACTION_BIN_DIRECTORY = ".bin";
const ACTION_INSTALL_DIRECTORY = "node_modules";
const JS_ENTRY = /\.(?:cjs|mjs|js)$/u;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/u;

/**
 * @typedef {{readonly destination: string, readonly entry: string, readonly ok: true,
 *   readonly packageRoot: string, readonly shim: string, readonly version: string}} ActionPnpmLocation
 * @typedef {ActionPnpmLocation & {readonly packageTreeSha256: string}} ActionPnpm
 * @typedef {{readonly exitCode: number, readonly stderr: string, readonly stdout: string}} CommandResult
 */

/** No path, environment value, or raw identity error survives either stable refusal. */
const refuse = (/** @type {"TOOLCHAIN_IDENTITY_MISMATCH" | "TOOLCHAIN_OBSERVATION_FAILED"} */
  reason = "TOOLCHAIN_OBSERVATION_FAILED") => releaseRefusal(reason);

/** Sanitized failed command result: no path, environment value, or raw child error survives it. */
const failedCommand = () => ({ exitCode: 1, stderr: "", stdout: "" });

export function escapesRoot(/** @type {string} */ root, /** @type {string} */ path) {
  // On win32 a cross-drive `relative()` answers an ABSOLUTE path, which does not start with
  // "..", so the classic startsWith test alone would pass a target redirected to another volume.
  const rel = relative(root, path);
  return rel.startsWith("..") || isAbsolute(rel);
}

function regularFile(/** @type {string} */ path) {
  // lstat, not stat: a symlink standing where the target belongs must never read as a regular
  // file. Contained links are resolved by realpath BEFORE this check, never around it.
  try { return lstatSync(path).isFile(); } catch { return false; }
}

/** @returns {Record<string, unknown> | undefined} */
function readManifest(/** @type {string} */ root) {
  try {
    const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? /** @type {Record<string, unknown>} */ (parsed)
      : undefined;
  } catch { return undefined; }
}

/**
 * The repository is the version authority. `packageManager` and `engines.pnpm` must agree
 * EXACTLY; a repository that disagrees with itself pins nothing, so it can authorize nothing.
 * @returns {string | undefined}
 */
function repositoryPin(/** @type {string} */ repositoryRoot) {
  const manifest = readManifest(repositoryRoot);
  if (!manifest) return undefined;
  const declared = manifest.packageManager;
  const engines = manifest.engines;
  if (typeof declared !== "string" || engines === null || typeof engines !== "object" || Array.isArray(engines)) return undefined;
  const [name, version, ...extra] = declared.split("@");
  if (name !== PACKAGE_NAME || extra.length > 0 || typeof version !== "string" || !EXACT_VERSION.test(version)) return undefined;
  return /** @type {Record<string, unknown>} */ (engines).pnpm === version ? version : undefined;
}

/**
 * The installed bin map is the only source for the entry path: a guessed filename would keep
 * working after the package it claims to describe was replaced. This resolves the mapping and
 * decides its KIND; containment of the result is proved exactly once, in `verifiedIdentity`, so
 * a traversing or absolute mapping cannot pass by weakening either check alone.
 * @returns {string | undefined}
 */
function binEntry(/** @type {string} */ packageRoot, /** @type {Record<string, unknown>} */ manifest) {
  const bin = manifest.bin;
  if (bin === null || typeof bin !== "object" || Array.isArray(bin)) return undefined;
  const mapped = /** @type {Record<string, unknown>} */ (bin)[PACKAGE_NAME];
  if (typeof mapped !== "string" || mapped.length === 0) return undefined;
  const target = resolve(packageRoot, mapped);
  return JS_ENTRY.test(basename(target)) ? target : undefined;
}

/**
 * Identity of an already-resolved descriptor, re-read from disk. Called once during resolution
 * and again immediately before spawn, so a package, shim, or entry swapped inside that window
 * refuses instead of executing.
 */
function verifiedIdentity(/** @type {ActionPnpmLocation} */ descriptor) {
  try {
    if (realpathSync(descriptor.packageRoot) !== descriptor.packageRoot) return false;
    if (realpathSync(descriptor.entry) !== descriptor.entry) return false;
    if (escapesRoot(descriptor.destination, descriptor.packageRoot)) return false;
    if (escapesRoot(descriptor.packageRoot, descriptor.entry)) return false;
    if (!regularFile(descriptor.entry) || !regularFile(descriptor.shim)) return false;
    const manifest = readManifest(descriptor.packageRoot);
    if (!manifest || manifest.name !== PACKAGE_NAME || manifest.version !== descriptor.version) return false;
    return binEntry(descriptor.packageRoot, manifest) === descriptor.entry;
  } catch { return false; }
}

function treeDigestMatches(
  /** @type {ActionPnpmLocation} */ descriptor,
  /** @type {string} */ expected,
) {
  return normalizedTreeSha256(capturePackTreeIdentity(descriptor.packageRoot)) === expected;
}

/**
 * Resolve the action-installed pnpm from the action handoff alone.
 * @param {{environment: NodeJS.ProcessEnv, repositoryRoot: string}} request
 * @param {{expectedPackageTreeSha256?: string, platform?: NodeJS.Platform | string}} dependencies
 * @returns {ActionPnpm | ReturnType<typeof releaseRefusal>}
 */
export function resolveActionPnpm(request, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  // A malformed request refuses like any other unresolvable install. Reading through it first
  // would throw a raw TypeError past this layer, carrying a stack trace instead of a code.
  const environment = /** @type {NodeJS.ProcessEnv | undefined} */ (request?.environment);
  if (environment === null || typeof environment !== "object") return refuse();
  const home = environment.PNPM_HOME;
  if (typeof home !== "string" || home.length === 0 || !isAbsolute(home)) return refuse();
  if (typeof request.repositoryRoot !== "string" || request.repositoryRoot.length === 0) return refuse();
  const pin = repositoryPin(request.repositoryRoot);
  if (!pin) return refuse();
  try {
    const binDirectory = realpathSync(home);
    const installRoot = dirname(binDirectory);
    // Only the action's own layout is authority. Anything else - a user pnpm home, a bare bin
    // directory, the destination itself - is a different installation wearing the same variable.
    if (basename(binDirectory) !== ACTION_BIN_DIRECTORY || basename(installRoot) !== ACTION_INSTALL_DIRECTORY) return refuse();
    const destination = dirname(installRoot);
    // The host shim must EXIST - its absence means this is not a completed action install - but
    // it is never executed: shim parsing and shell quoting are exactly the injection surface.
    // Its presence, like every other identity property, is proved once, by `verifiedIdentity`.
    const shim = join(binDirectory, platform === "win32" ? "pnpm.cmd" : PACKAGE_NAME);
    const packageRoot = realpathSync(join(installRoot, PACKAGE_NAME));
    const manifest = readManifest(packageRoot);
    if (!manifest) return refuse();
    const mapped = binEntry(packageRoot, manifest);
    if (!mapped) return refuse();
    const location = Object.freeze({
      destination, entry: realpathSync(mapped), ok: /** @type {const} */ (true), packageRoot, shim, version: pin,
    });
    if (!verifiedIdentity(location)) return refuse();
    const expected = dependencies.expectedPackageTreeSha256
      ?? readToolchainPins().pnpmPackageTreeSha256;
    if (!treeDigestMatches(location, expected)) return refuse("TOOLCHAIN_IDENTITY_MISMATCH");
    return Object.freeze({ ...location, packageTreeSha256: expected });
  } catch { return refuse(); }
}

/**
 * Execute the verified entry. Never the shim, never a shell, never a command string.
 * @param {{args: readonly string[], cwd: string, descriptor: ActionPnpm}} request
 * @param {{exec?: typeof exec, expectedPackageTreeSha256?: string}} dependencies
 * @returns {Promise<CommandResult>}
 */
export async function runActionPnpm(request, dependencies = {}) {
  const run = dependencies.exec ?? exec;
  const descriptor = /** @type {ActionPnpm | undefined} */ (request?.descriptor);
  if (descriptor === null || typeof descriptor !== "object" || descriptor.ok !== true) return failedCommand();
  if (!Array.isArray(request.args) || typeof request.cwd !== "string") return failedCommand();
  try {
    if (!verifiedIdentity(descriptor)
      || !treeDigestMatches(descriptor,
        dependencies.expectedPackageTreeSha256 ?? descriptor.packageTreeSha256)) {
      return failedCommand();
    }
  } catch { return failedCommand(); }
  try {
    const result = await run(process.execPath, [descriptor.entry, ...request.args], {
      cwd: request.cwd, encoding: "utf8", maxBuffer: MAX_OUTPUT, shell: false, timeout: TIMEOUT, windowsHide: true,
    });
    return { exitCode: 0, stderr: String(result.stderr), stdout: String(result.stdout) };
  } catch (error) {
    // Bounded translation: a later `pnpm install` failure must still reach its own release code,
    // so a nonzero child exit is a RESULT here, not a refusal - and the raw error never escapes.
    const failure = /** @type {{code?: unknown, stderr?: unknown, stdout?: unknown}} */ (error);
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stderr: typeof failure.stderr === "string" ? failure.stderr : "",
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
    };
  }
}

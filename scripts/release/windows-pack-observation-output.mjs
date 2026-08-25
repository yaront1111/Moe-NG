import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import {
  exactDataRecordSnapshot,
  isPlainRecord,
  refuseWindowsRelease,
  WINDOWS_RELEASE_AUTHORITY_CODES,
  WindowsReleaseAuthorityError,
} from "./windows-pack-observation-contract.mjs";

const ARTIFACT_NAME = "moe-windows.zip";
const OUTPUT_NAME = `${ARTIFACT_NAME}.provenance.json`;
const MAX_OUTPUT_BYTES = 64 * 1024;
const PATH_LIMIT = 4_096;
const INPUT_KEYS = Object.freeze(["artifactPath", "bytes", "cwd", "outputPath"]);
const PORT_KEYS = Object.freeze([
  "close", "fstat", "fsync", "lstat", "open", "realpath", "stat", "unlink", "write",
]);

/** @typedef {import("node:fs").BigIntStats} BigIntStats */
/**
 * @typedef {{
 * close: (handle: number) => void,
 * fstat: (handle: number) => BigIntStats,
 * fsync: (handle: number) => void,
 * lstat: (path: string) => BigIntStats,
 * open: (path: string, flags: number, mode: number) => number,
 * realpath: (path: string) => string,
 * stat: (path: string) => BigIntStats,
 * unlink: (path: string) => void,
 * write: (handle: number, bytes: Uint8Array, offset: number, length: number) => number,
 * }} OutputPorts
 */

/** @type {Readonly<OutputPorts>} */
const SYSTEM_OUTPUT_PORTS = Object.freeze({
  close: (handle) => closeSync(handle),
  fstat: (handle) => fstatSync(handle, { bigint: true }),
  fsync: (handle) => fsyncSync(handle),
  lstat: (path) => lstatSync(path, { bigint: true }),
  open: (path, flags, mode) => openSync(path, flags, mode),
  realpath: (path) => realpathSync.native(path),
  stat: (path) => statSync(path, { bigint: true }),
  unlink: (path) => unlinkSync(path),
  write: (handle, bytes, offset, length) => writeSync(handle, bytes, offset, length),
});

/** @param {unknown} value */
function validPathText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= PATH_LIMIT
    && !value.includes("\0");
}

/** @param {unknown} value */
function decodeInput(value) {
  const input = exactDataRecordSnapshot(value, INPUT_KEYS);
  if (input === null || !validPathText(input.artifactPath) || !validPathText(input.cwd)
    || !validPathText(input.outputPath) || !(input.bytes instanceof Uint8Array)
    || input.bytes.byteLength <= 0 || input.bytes.byteLength > MAX_OUTPUT_BYTES) {
    refuseWindowsRelease(WINDOWS_RELEASE_AUTHORITY_CODES.INPUT_INVALID);
  }
  return /** @type {{artifactPath: string, bytes: Uint8Array, cwd: string, outputPath: string}} */ (input);
}

/** @param {unknown} injected */
function outputPorts(injected) {
  if (injected === undefined) return SYSTEM_OUTPUT_PORTS;
  try {
    if (!isPlainRecord(injected)) throw new Error("invalid ports");
    const descriptors = Object.getOwnPropertyDescriptors(injected);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string" || !PORT_KEYS.includes(key))) {
      throw new Error("invalid ports");
    }
    const overrides = /** @type {Partial<OutputPorts>} */ ({});
    for (const key of /** @type {string[]} */ (keys)) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
        || typeof descriptor.value !== "function") throw new Error("invalid port");
      Object.defineProperty(overrides, key, {
        enumerable: true,
        value: descriptor.value,
      });
    }
    return /** @type {Readonly<OutputPorts>} */ (Object.freeze({ ...SYSTEM_OUTPUT_PORTS, ...overrides }));
  } catch {
    refuseWindowsRelease(WINDOWS_RELEASE_AUTHORITY_CODES.INPUT_INVALID);
  }
}

/** @param {string} root @param {string} candidate */
function contained(root, candidate) {
  const child = relative(root, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && !isAbsolute(child);
}

/** @param {BigIntStats} left @param {BigIntStats} right */
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

/** @param {string} cwd @param {Readonly<OutputPorts>} ports */
function canonicalRoot(cwd, ports) {
  const lexical = resolve(cwd);
  const lexicalInfo = ports.lstat(lexical);
  const canonicalPath = ports.realpath(lexical);
  const canonicalInfo = ports.stat(canonicalPath);
  if (!lexicalInfo.isDirectory() || lexicalInfo.isSymbolicLink() || !canonicalInfo.isDirectory()
    || !sameIdentity(lexicalInfo, canonicalInfo)) throw new Error("invalid root");
  return canonicalPath;
}

/** @param {string} root @param {string} parentPath @param {Readonly<OutputPorts>} ports */
function observeParent(root, parentPath, ports) {
  const lexical = ports.lstat(parentPath);
  const canonicalPath = ports.realpath(parentPath);
  const canonical = ports.stat(canonicalPath);
  if (!lexical.isDirectory() || lexical.isSymbolicLink() || !canonical.isDirectory()
    || !contained(root, canonicalPath) || !sameIdentity(lexical, canonical)) {
    throw new Error("invalid output parent");
  }
  return Object.freeze({ canonicalPath, dev: canonical.dev, ino: canonical.ino });
}

/** @param {{canonicalPath: string, dev: bigint, ino: bigint}} left @param {{canonicalPath: string, dev: bigint, ino: bigint}} right */
function sameParent(left, right) {
  return left.canonicalPath === right.canonicalPath && left.dev === right.dev && left.ino === right.ino;
}

/**
 * @param {string} outputPath
 * @param {{canonicalPath: string, dev: bigint, ino: bigint}} parent
 * @param {BigIntStats} opened
 * @param {Readonly<OutputPorts>} ports
 */
function pathMatchesOpenedFile(outputPath, parent, opened, ports) {
  const lexical = ports.lstat(outputPath);
  const canonicalPath = ports.realpath(outputPath);
  const canonical = ports.stat(canonicalPath);
  return lexical.isFile() && !lexical.isSymbolicLink() && canonical.isFile()
    && dirname(canonicalPath) === parent.canonicalPath
    && sameIdentity(lexical, canonical) && sameIdentity(canonical, opened);
}

/**
 * @param {string} root
 * @param {string} parentPath
 * @param {string} outputPath
 * @param {{canonicalPath: string, dev: bigint, ino: bigint}} expectedParent
 * @param {BigIntStats | undefined} opened
 * @param {Readonly<OutputPorts>} ports
 */
function removeExactCreatedFile(root, parentPath, outputPath, expectedParent, opened, ports) {
  if (opened === undefined) return;
  try {
    const currentParent = observeParent(root, parentPath, ports);
    if (!sameParent(expectedParent, currentParent)
      || !pathMatchesOpenedFile(outputPath, expectedParent, opened, ports)) return;
    ports.unlink(outputPath);
  } catch {
    // Fail closed. Never broaden cleanup when the exact created identity cannot be re-established.
  }
}

/** @param {unknown} error */
function isExistingPath(error) {
  return error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST";
}

/**
 * Atomically claims a final receipt path, validates the parent and opened-file
 * identities around the claim, and never overwrites an existing path.
 * @param {unknown} value
 * @param {unknown} [injected]
 */
export async function publishWindowsPackObservationOutput(value, injected) {
  const input = decodeInput(value);
  const ports = outputPorts(injected);
  let root = "";
  let parentPath = "";
  let outputPath = "";
  let expectedParent;
  let handle;
  let opened;
  /** @type {unknown} */
  let failure;

  try {
    root = canonicalRoot(input.cwd, ports);
    const artifactPath = resolve(root, input.artifactPath);
    outputPath = resolve(root, input.outputPath);
    parentPath = dirname(outputPath);
    if (basename(artifactPath) !== ARTIFACT_NAME || basename(outputPath) !== OUTPUT_NAME
      || dirname(artifactPath) !== parentPath || !contained(root, outputPath)) {
      refuseWindowsRelease(WINDOWS_RELEASE_AUTHORITY_CODES.INPUT_INVALID);
    }

    expectedParent = observeParent(root, parentPath, ports);
    try {
      handle = ports.open(outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (error) {
      if (isExistingPath(error)) {
        refuseWindowsRelease(WINDOWS_RELEASE_AUTHORITY_CODES.PUBLICATION_CONFLICT);
      }
      throw error;
    }
    opened = ports.fstat(handle);
    const afterCreateParent = observeParent(root, parentPath, ports);
    if (!opened.isFile() || !sameParent(expectedParent, afterCreateParent)
      || !pathMatchesOpenedFile(outputPath, expectedParent, opened, ports)) {
      throw new Error("output identity changed during exclusive creation");
    }

    let offset = 0;
    while (offset < input.bytes.byteLength) {
      const written = ports.write(handle, input.bytes, offset, input.bytes.byteLength - offset);
      if (!Number.isSafeInteger(written) || written <= 0 || written > input.bytes.byteLength - offset) {
        throw new Error("short output write");
      }
      offset += written;
    }
    ports.fsync(handle);

    const afterWrite = ports.fstat(handle);
    const afterWriteParent = observeParent(root, parentPath, ports);
    if (!afterWrite.isFile() || !sameIdentity(opened, afterWrite)
      || afterWrite.size !== BigInt(input.bytes.byteLength)
      || !sameParent(expectedParent, afterWriteParent)
      || !pathMatchesOpenedFile(outputPath, expectedParent, afterWrite, ports)) {
      throw new Error("output identity changed during persistence");
    }
  } catch (error) {
    failure = error;
  }

  if (handle !== undefined) {
    try {
      ports.close(handle);
    } catch (error) {
      failure ??= error;
    }
  }

  if (failure !== undefined) {
    if (expectedParent !== undefined) {
      removeExactCreatedFile(root, parentPath, outputPath, expectedParent, opened, ports);
    }
    if (failure instanceof WindowsReleaseAuthorityError) throw failure;
    refuseWindowsRelease(WINDOWS_RELEASE_AUTHORITY_CODES.INPUT_INVALID);
  }

  return Object.freeze({ outputPath });
}

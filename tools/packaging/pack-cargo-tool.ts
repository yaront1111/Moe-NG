import { spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertPackToolIdentity, captureNativePackTool, PACK_STEP_FAILED, pathInside,
  sameCanonicalPath, type PackToolLaunch,
} from "./pack-tool-identity.js";

export const PACKAGING_TOOLCHAIN_LAYER = "PACKAGING_TOOLCHAIN" as const;
const MAX_PIN_BYTES = 8_192;
const MAX_VERSION_BYTES = 8_192;
const VERSION_TIMEOUT_MS = 5_000;
const PIN_PATH = fileURLToPath(new URL("./cargo-toolchain-pins.json", import.meta.url));
const PIN_KEYS = Object.freeze([
  "arch", "cargoSha256", "cargoVersionLine", "platform", "schemaVersion", "toolchain",
] as const);

export interface CargoToolchainPin {
  readonly arch: "x64";
  readonly cargoSha256: string;
  readonly cargoVersionLine: "cargo 1.96.0 (30a34c682 2026-05-25)";
  readonly platform: "win32";
  readonly schemaVersion: "cargo-toolchain-pins/1";
  readonly toolchain: "1.96.0-x86_64-pc-windows-msvc";
}

const TRACKED_PIN: CargoToolchainPin = Object.freeze({
  arch: "x64",
  cargoSha256: "122f18d28a63fa358f3db266abee1ff1d8aabf0ab7f2dd9ac38a38da99977ae5",
  cargoVersionLine: "cargo 1.96.0 (30a34c682 2026-05-25)",
  platform: "win32",
  schemaVersion: "cargo-toolchain-pins/1",
  toolchain: "1.96.0-x86_64-pc-windows-msvc",
});

export interface CargoSpawnResult {
  readonly error?: unknown;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

export type CargoSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => CargoSpawnResult;

export interface CargoAdmissionDependencies {
  readonly architecture?: string;
  readonly platform?: NodeJS.Platform;
  readonly spawn?: CargoSpawn;
}

export class PackCargoToolError extends Error {
  public readonly code = PACK_STEP_FAILED;
  public readonly layer = PACKAGING_TOOLCHAIN_LAYER;

  public constructor() {
    super(PACK_STEP_FAILED);
    this.name = "PackCargoToolError";
    Object.freeze(this);
  }
}

function refuse(): never {
  throw new PackCargoToolError();
}

function mapRefusal<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof PackCargoToolError) throw error;
    return refuse();
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function pinFromRecord(value: unknown, tracked: boolean): CargoToolchainPin {
  if (!isRecord(value) || !sameStrings(Object.keys(value).sort(), [...PIN_KEYS].sort())) refuse();
  const pin = value as Readonly<Record<(typeof PIN_KEYS)[number], unknown>>;
  if (pin.schemaVersion !== TRACKED_PIN.schemaVersion || pin.platform !== TRACKED_PIN.platform
    || pin.arch !== TRACKED_PIN.arch || pin.toolchain !== TRACKED_PIN.toolchain
    || pin.cargoVersionLine !== TRACKED_PIN.cargoVersionLine
    || typeof pin.cargoSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(pin.cargoSha256)
    || (tracked && pin.cargoSha256 !== TRACKED_PIN.cargoSha256)) refuse();
  return Object.freeze({
    arch: pin.arch, cargoSha256: pin.cargoSha256,
    cargoVersionLine: pin.cargoVersionLine, platform: pin.platform,
    schemaVersion: pin.schemaVersion, toolchain: pin.toolchain,
  });
}

function boundedPinBytes(bytes: string | Uint8Array): Uint8Array {
  if (typeof bytes !== "string") {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PIN_BYTES) refuse();
    return Uint8Array.from(bytes);
  }
  if (bytes.length === 0 || bytes.length > MAX_PIN_BYTES) refuse();
  const encoded = Buffer.from(bytes, "utf8");
  if (encoded.byteLength > MAX_PIN_BYTES) refuse();
  return encoded;
}
const pinDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function skipJsonWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && " \t\r\n".includes(text[index] ?? "")) index += 1;
  return index;
}
function readJsonString(
  text: string, start: number,
): Readonly<{ readonly next: number; readonly value: string }> {
  if (text[start] !== "\"") refuse();
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20) refuse();
    if (escaped) {
      escaped = false;
      continue;
    }
    if (code === 0x5c) {
      escaped = true;
      continue;
    }
    if (code !== 0x22) continue;
    const value = JSON.parse(text.slice(start, index + 1)) as unknown;
    if (typeof value !== "string") refuse();
    return Object.freeze({ next: index + 1, value });
  }
  return refuse();
}

function parsePinDocument(bytes: Uint8Array): Readonly<Record<string, unknown>> {
  const text = pinDecoder.decode(bytes);
  let index = skipJsonWhitespace(text, 0);
  if (text[index] !== "{") refuse();
  index = skipJsonWhitespace(text, index + 1);
  const value = Object.create(null) as Record<string, string>;
  const keys = new Set<string>();
  if (text[index] === "}") index += 1;
  else {
    while (true) {
      const key = readJsonString(text, index);
      if (keys.has(key.value)) refuse();
      keys.add(key.value);
      index = skipJsonWhitespace(text, key.next);
      if (text[index] !== ":") refuse();
      index = skipJsonWhitespace(text, index + 1);
      const member = readJsonString(text, index);
      Object.defineProperty(value, key.value, {
        configurable: false, enumerable: true, value: member.value, writable: false,
      });
      index = skipJsonWhitespace(text, member.next);
      if (text[index] === "}") {
        index += 1;
        break;
      }
      if (text[index] !== ",") refuse();
      index = skipJsonWhitespace(text, index + 1);
    }
  }
  if (skipJsonWhitespace(text, index) !== text.length) refuse();
  return Object.freeze(value);
}

export function parseCargoToolchainPins(bytes: string | Uint8Array): CargoToolchainPin {
  return mapRefusal(() => {
    return pinFromRecord(parsePinDocument(boundedPinBytes(bytes)), true);
  });
}

export function readCargoToolchainPins(): CargoToolchainPin {
  return mapRefusal(() => parseCargoToolchainPins(readFileSync(PIN_PATH)));
}

function canonicalPath(rawPath: string): string {
  if (!isAbsolute(rawPath)) refuse();
  const absolute = resolve(rawPath);
  if (!sameCanonicalPath(rawPath, absolute)) refuse();
  const canonical = realpathSync(absolute);
  if (!sameCanonicalPath(canonical, absolute)) refuse();
  return canonical;
}

function assertCargoPath(repository: string, executable: string, pin: CargoToolchainPin): void {
  const bin = dirname(executable);
  const toolchain = dirname(bin);
  if (pathInside(repository, executable) || basename(executable) !== "cargo.exe"
    || basename(bin) !== "bin" || basename(toolchain) !== pin.toolchain
    || basename(dirname(toolchain)) !== "toolchains") refuse();
}

const systemSpawn: CargoSpawn = (command, args, options) => {
  const result = spawnSync(command, [...args], options);
  return {
    ...(result.error === undefined ? {} : { error: result.error }),
    status: result.status,
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
};

export function admitCargoPackTool(
  repositoryRoot: string,
  explicitExecutable: string,
  rawPin: CargoToolchainPin,
  dependencies: CargoAdmissionDependencies = {},
): PackToolLaunch {
  return mapRefusal(() => {
    const pin = pinFromRecord(rawPin, false);
    if ((dependencies.platform ?? process.platform) !== pin.platform
      || (dependencies.architecture ?? process.arch) !== pin.arch) refuse();
    const repository = canonicalPath(repositoryRoot);
    const executable = canonicalPath(explicitExecutable);
    assertCargoPath(repository, executable, pin);
    const tool = captureNativePackTool("cargo", executable);
    if (tool.executable.sha256 !== pin.cargoSha256) refuse();
    const result = (dependencies.spawn ?? systemSpawn)(executable, Object.freeze(["--version"]), {
      cwd: repository,
      encoding: "utf8",
      env: Object.freeze({}),
      maxBuffer: MAX_VERSION_BYTES,
      shell: false,
      stdio: "pipe",
      timeout: VERSION_TIMEOUT_MS,
      windowsHide: true,
    });
    assertPackToolIdentity(tool);
    if (result.error !== undefined || result.status !== 0 || result.stderr !== ""
      || Buffer.byteLength(result.stdout, "utf8") > MAX_VERSION_BYTES
      || result.stdout !== `${pin.cargoVersionLine}\n`) refuse();
    return tool;
  });
}

#!/usr/bin/env node
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { packWindows } from "./pack-windows.js";
import { parseWindowsPackToolchain } from "./pack-toolchain-codec.js";
import { PACK_STEP_FAILED } from "./pack-tool-identity.js";

const SOURCE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const INPUT_ERROR = "PACK_SOURCE_INPUT_INVALID" as const;
const MAX_TOOLCHAIN_MANIFEST_BYTES = 32 * 1024 * 1024;

interface MaterializedPackArguments {
  readonly outputRoot: string;
  readonly sourceSha: string;
  readonly toolchainDigest: string;
  readonly toolchainManifest: string;
}

function parseArguments(argv: readonly string[]): MaterializedPackArguments {
  if (argv.length !== 8 || argv[0] !== "--output-root" || argv[2] !== "--source-sha"
    || argv[4] !== "--toolchain-manifest" || argv[6] !== "--toolchain-digest"
  ) {
    throw new Error(INPUT_ERROR);
  }
  const outputRoot = argv[1];
  const sourceSha = argv[3];
  const toolchainManifest = argv[5];
  const toolchainDigest = argv[7];
  if (outputRoot === undefined || !isAbsolute(outputRoot)
    || sourceSha === undefined || !SOURCE_SHA.test(sourceSha)
    || toolchainManifest === undefined || !isAbsolute(toolchainManifest)
    || toolchainDigest === undefined || !/^[0-9a-f]{64}$/u.test(toolchainDigest)) {
    throw new Error(INPUT_ERROR);
  }
  return Object.freeze({ outputRoot, sourceSha, toolchainDigest, toolchainManifest });
}

export const PACKAGING_BROKER_LAYER = "PACKAGING_BROKER" as const;
export const BROKER_SOURCE_UNUSABLE = "BROKER_SOURCE_UNUSABLE" as const;
export const BROKER_DIGEST_MISMATCH = "BROKER_DIGEST_MISMATCH" as const;

export type BrokerRefusalReason =
  | typeof BROKER_DIGEST_MISMATCH
  | typeof BROKER_SOURCE_UNUSABLE;

/**
 * Artifact-relative, forward-slash, and deliberately the exact location
 * `PACKAGED_BROKER_RELATIVE_PATH` resolves to in packages/runner. An extracted
 * artifact must satisfy the packaged layout with no workspace marker present.
 */
export const PACKAGED_BROKER_ARTIFACT_PATH =
  "packages/runner/bin/moe-windows-job-broker.exe" as const;

const MAX_BROKER_BYTES = 64 * 1024 * 1024;

/**
 * `code` and `layer` follow the packaging idiom; `reason` is what makes the two
 * refusal paths DISTINGUISHABLE. Without it a test asserting only the shared code
 * cannot tell the shape fence from the digest pin, and would stay green after the
 * pin was loosened. The value is produced here and never taken from a caller.
 */
export class PackBrokerError extends Error {
  public readonly code = PACK_STEP_FAILED;
  public readonly layer = PACKAGING_BROKER_LAYER;
  public readonly reason: BrokerRefusalReason;

  public constructor(reason: BrokerRefusalReason) {
    super(`${PACK_STEP_FAILED}: ${reason}`);
    this.name = "PackBrokerError";
    this.reason = reason;
    Object.freeze(this);
  }
}

export interface BrokerPin {
  readonly bytes: number;
  /** Artifact-relative, forward-slash. */
  readonly path: string;
  readonly sha256: string;
}

function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function usableFileAt(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    // lstat THROWS on absence; an unresolvable broker must refuse, never escape
    // as an exception from a seam whose contract is to refuse.
    throw new PackBrokerError(BROKER_SOURCE_UNUSABLE);
  }
  if (!stat.isFile() || stat.isSymbolicLink()
    || stat.size <= 0 || stat.size > MAX_BROKER_BYTES) {
    throw new PackBrokerError(BROKER_SOURCE_UNUSABLE);
  }
}

/**
 * Copies the locked-build broker into the artifact and pins the bytes that
 * actually LANDED — re-read from disk rather than hashed from the source buffer,
 * so the pin names what shipped instead of what was handed to the copier.
 */
export function stageArtifactBroker(brokerSource: string, artifactRoot: string): BrokerPin {
  if (!isAbsolute(brokerSource) || !isAbsolute(artifactRoot)) {
    throw new PackBrokerError(BROKER_SOURCE_UNUSABLE);
  }
  usableFileAt(brokerSource);
  const source = readFileSync(brokerSource);
  const destination = join(artifactRoot, ...PACKAGED_BROKER_ARTIFACT_PATH.split("/"));
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, source);
  const written = readFileSync(destination);
  // A SHORT WRITE would otherwise be pinned as though it were the whole binary:
  // the pin is measured on what landed, so truncated bytes would hash consistently
  // and verify would agree with them. This is the only place the two lengths are
  // independently known, so it is the only place the check can mean anything. It
  // lives HERE and not in verifyArtifactBroker on purpose — see that docstring.
  if (written.byteLength !== source.byteLength) {
    throw new PackBrokerError(BROKER_SOURCE_UNUSABLE);
  }
  return Object.freeze({
    bytes: written.byteLength,
    path: PACKAGED_BROKER_ARTIFACT_PATH,
    sha256: digestOf(written),
  });
}

/**
 * Re-reads the staged broker and refuses unless it still hashes to the pin.
 *
 * NO SIZE COMPARISON HERE, and that is deliberate. A length check would be a
 * SECOND mechanism able to refuse a substitution, and the drill that grades this
 * pin feeds a same-length substitute precisely so the digest is the only thing
 * that can answer. Adding a size fence would make that drill pass for the wrong
 * reason and hide a loosened digest.
 */
export function verifyArtifactBroker(pin: BrokerPin, artifactRoot: string): void {
  // Resolved from the LAYOUT CONSTANT, never from pin.path. The pin is caller-
  // supplied data, and a `..` segment in it would walk this read straight out of
  // the artifact root. The packaged location is a property of the layout, so
  // pin.path stays informational and only pin.sha256 is authority here.
  const staged = join(artifactRoot, ...PACKAGED_BROKER_ARTIFACT_PATH.split("/"));
  usableFileAt(staged);
  if (digestOf(readFileSync(staged)) !== pin.sha256) {
    throw new PackBrokerError(BROKER_DIGEST_MISMATCH);
  }
}

/**
 * The locked-build output inside the materialized checkout, matching
 * `BROKER_RELATIVE_PATH` — WORKSPACE-ROOT relative, not packages/runner relative.
 *
 * The build itself is the caller's precondition rather than a step taken here:
 * `cargo` is admitted and leased into the pack's child PATH by the toolchain
 * boundary, but running it needs the hardened child-launch path (packChildEnvironment
 * and the trusted-directory PATH rebuild) that lives outside this module's owned
 * paths. Duplicating that authority here would fork it. Absent bytes therefore
 * REFUSE via stageArtifactBroker rather than being skipped.
 */
function brokerSourcePath(sourceRoot: string): string {
  return join(sourceRoot, "dist", "windows-job-native", "release", "moe-windows-job-broker.exe");
}

export function runMaterializedWindowsPack(argv: readonly string[]): number {
  const arguments_ = parseArguments(argv);
  const manifestStat = lstatSync(arguments_.toolchainManifest);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()
    || manifestStat.size <= 0 || manifestStat.size > MAX_TOOLCHAIN_MANIFEST_BYTES) {
    throw new Error(INPUT_ERROR);
  }
  const manifest = readFileSync(arguments_.toolchainManifest);
  const digest = createHash("sha256").update(manifest).digest("hex");
  if (digest !== arguments_.toolchainDigest) throw new Error(INPUT_ERROR);
  const toolchain = parseWindowsPackToolchain(manifest.toString("utf8"));
  const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
  // FAIL-CLOSED, and unconditional on purpose. DoD 1 forbids silently skipping a
  // broker, so an unbuilt one must stop the pack rather than yield an artifact whose
  // runner cannot prove a process tree dead. The locked build that produces this
  // path is the caller's precondition — see the note on brokerSourcePath.
  const brokerPin = stageArtifactBroker(brokerSourcePath(sourceRoot), sourceRoot);
  verifyArtifactBroker(brokerPin, sourceRoot);
  const status = packWindows({
    log: (line) => process.stdout.write(`${line}\n`),
    outputRoot: arguments_.outputRoot,
    sourceRoot,
    sourceSha: arguments_.sourceSha,
    toolchain,
  });
  return status;
}

const meta = import.meta as ImportMeta & { readonly main?: boolean };
if (meta.main === true) {
  try {
    process.exitCode = runMaterializedWindowsPack(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}

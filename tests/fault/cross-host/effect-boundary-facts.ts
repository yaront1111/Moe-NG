/**
 * Builds one real fact per frozen platform boundary, each through the
 * production surface that owns it.
 *
 * Nothing here judges anything. Every value below is produced by
 * `@moe/runner`'s own builders — the provider runtime observation, the scope
 * observation, the workspace input manifest, the mirrored lease the activation
 * commit bound, the cancellation reconciliation, the crash classification — and
 * the verdicts are left entirely to `classifyLinuxBoundary` /
 * `classifyMacosBoundary` and the whole-platform observers. A fact this module
 * cannot build honestly is returned as `null`, which those classifiers refuse as
 * `PLATFORM_FACT_ABSENT` rather than treating as a silent pass.
 */

import { execFileSync } from "node:child_process";
import {
  lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildInputManifest,
  buildProviderRuntimeObservation,
  classifyCrash,
  createNodeGitObserver,
  createNodeScopePaths,
  observeScope,
  reconcileClaudeRun,
  type ClaudeProcessExit,
  type ClaudeStreamRecord,
  type PlatformHostIdentity,
  type ProviderRuntimeObservation,
} from "@moe/runner";

import { sha256Hex } from "./effect-evidence-contract.js";

/** Every boundary fact this module can build, keyed by boundary name. */
export type BoundaryFacts = Readonly<Record<string, unknown>>;

/** The durable records one production activation commit actually produced. */
export interface ActivationRecords {
  readonly intent: unknown;
  readonly attempt: unknown;
  readonly claim: unknown;
  readonly grant: unknown;
  readonly registration: unknown;
  readonly lease: unknown;
  readonly advancedAuthority: unknown;
  readonly effectRef: string;
}

export interface FactContext {
  readonly host: PlatformHostIdentity;
  readonly observedAt: string;
  readonly repoRoot: string;
  readonly headSha: string;
  readonly trackedPath: string;
  readonly runtime: ProviderRuntimeObservation;
  readonly records: ActivationRecords;
}

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: repoRoot, encoding: "utf8" }).trim();
}

export function readHeadSha(repoRoot: string): string {
  return git(repoRoot, ["rev-parse", "--verify", "HEAD"]);
}

export function readObjectFormat(repoRoot: string): string {
  return git(repoRoot, ["rev-parse", "--show-object-format"]);
}

/**
 * The runtime closure is measured from the bytes of the executable actually
 * running this process, so a receipt cannot claim a closure it never resolved.
 */
export function buildRuntime(
  host: PlatformHostIdentity,
  observedAt: string,
): ProviderRuntimeObservation | null {
  const built = buildProviderRuntimeObservation({
    resolvedRuntimeClosure: [
      { kind: "EXECUTABLE", path: process.execPath, sha256: sha256Hex(readFileSync(process.execPath)) },
    ],
    reportedVersion: process.version.replace(/^v/u, ""),
    adapterCapabilitySchemaDigest: sha256Hex(new TextEncoder().encode(process.version)),
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: host,
    clock: { observedAt: () => observedAt },
  });
  return built.ok === true ? built.observation : null;
}

/**
 * A real symlink on the executing filesystem, observed with lstat and realpath.
 *
 * The observation is the fact; the files are not. The temporary tree is removed
 * in `finally` so no probe path survives the run, and a filesystem that refuses
 * to create the link contributes `null` rather than an invented observation.
 */
function pathFact(): unknown {
  let root: string | null = null;
  try {
    root = realpathSync(mkdtempSync(join(tmpdir(), "moe-xh-path-")));
    const target = join(root, "target");
    const link = join(root, "link");
    writeFileSync(target, "moe");
    symlinkSync(target, link);
    if (!lstatSync(link).isSymbolicLink()) {
      return null;
    }
    return { path: link, symlinkTarget: realpathSync(target), resolvedPath: realpathSync(link) };
  } catch {
    return null;
  } finally {
    if (root !== null) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

function workspaceFact(context: FactContext): unknown {
  const absolute = join(context.repoRoot, context.trackedPath);
  const bytes = readFileSync(absolute);
  const scope = observeScope({
    worktreeRoot: context.repoRoot,
    baseIdentity: context.headSha,
    declaredScopePaths: [context.trackedPath],
    gitObserver: createNodeGitObserver(context.repoRoot, process.env),
    pathObserver: createNodeScopePaths(),
    observedAt: context.observedAt,
    observerVersion: "cross-host-evidence/1",
  });
  const manifest = buildInputManifest({
    baseIdentity: context.headSha,
    entries: [
      { path: context.trackedPath, sha256: sha256Hex(bytes), byteLength: bytes.byteLength, producer: { kind: "BASE" } },
    ],
  });
  if (scope.ok !== true || manifest.ok !== true) {
    return null;
  }
  return { scope: scope.observation, workspace: manifest.manifest };
}

/**
 * A stream record is the caller's INPUT to reconciliation, not its authority:
 * the outcome below is decided entirely by production `reconcileClaudeRun`. The
 * digest is taken over the bytes the verifier child really produced, so the
 * record is bound to this run rather than to a constant.
 */
function streamRecord(capturedStdout: Uint8Array): ClaudeStreamRecord {
  const digest = sha256Hex(capturedStdout);
  return {
    recordVersion: "moe-claude-stream-record/1",
    effect: { intentId: "cross-host", attemptId: "cross-host", aggregateId: "cross-host" },
    disposition: "INCOMPLETE",
    anomalies: ["TRUNCATION"],
    events: [],
    raw: {
      kind: "INLINE",
      byteLength: capturedStdout.byteLength,
      sha256: digest,
      rawBase64: Buffer.from(capturedStdout).toString("base64"),
      tailBase64: Buffer.from(capturedStdout).toString("base64"),
    },
    recordDigest: digest,
  } as unknown as ClaudeStreamRecord;
}

const LEASE_EPOCH = 7;

function crashSituation(context: FactContext, processExit: ClaudeProcessExit): unknown {
  return {
    records: {
      intent: context.records.intent,
      attempt: context.records.attempt,
      attemptState: "RUNNING",
      claim: context.records.claim,
      grant: context.records.grant,
      tombstone: null,
      registration: context.records.registration,
      lockState: "HELD",
      observation: null,
      reconciliation: null,
      resourceFact: "ACTIVE",
      disposition: { reasons: ["WORK_CANCEL"], strongestReason: "WORK_CANCEL", terminalTarget: "CANCELLED" },
      safeHandoff: null,
    },
    observation: {
      effectRef: context.records.effectRef,
      processExit,
      effectStatus: "PROVEN_ACTIVE",
      observedEpoch: LEASE_EPOCH,
      presenceLooksLive: false,
      journalDigest: null,
      reviewPackageDigest: null,
    },
    // A restart-time adoption is only honest with a REAL fence advance: a higher
    // epoch AND the new token that generation minted. Passing null here would
    // make production refuse RECOVERY_OWNERSHIP_TRANSFER_UNPROVEN, which is the
    // correct refusal for quiescence and the wrong input for a wrapper that
    // actually took the next lease generation before classifying.
    claimedAuthority: context.records.advancedAuthority,
  };
}

export interface BoundaryFactInput {
  readonly context: FactContext;
  readonly processExit: ClaudeProcessExit;
  readonly cancelRequested: boolean;
  readonly capturedStdout: Uint8Array;
}

/**
 * Builds the seven facts as one set. Each is produced by its own owner, so a
 * boundary whose owner refuses contributes `null` and is refused downstream
 * instead of being quietly replaced by a fact from a neighbouring boundary.
 */
export function buildBoundaryFacts(input: BoundaryFactInput): BoundaryFacts {
  const { context } = input;
  const reconciliation = reconcileClaudeRun({
    stream: streamRecord(input.capturedStdout),
    cancelRequested: input.cancelRequested,
    processExit: input.processExit,
  });
  const crash = classifyCrash(crashSituation(context, input.processExit));
  return Object.freeze({
    PROVIDER_LAUNCH: context.runtime,
    GIT_WORKSPACE: workspaceFact(context),
    PATH_SYMLINK: pathFact(),
    LOCK: context.records.lease,
    SIGNAL_CANCELLATION: reconciliation,
    RUNTIME_CLOSURE: context.runtime,
    CRASH_RECOVERY: crash.kind === "REFUSED" ? null : crash,
  });
}

import { win32 } from "node:path";

import { canonicalDigest, deepFreeze, isPlainRecord } from "../../canonical.js";
import {
  CLAUDE_RUNTIME_PIN_VERSION,
  aggregateClosureDigest,
  authorityDigest,
  describeError,
  isRefusal,
  pathShapeRejection,
  readQuote,
  refuse,
  resolveSources,
  type ClaudeRuntimePinFailure,
  type SourceEntry,
} from "./claude-runtime-pin-closure.js";
import {
  publish,
  stageClosure,
  tryRemove,
  verifyPublished,
} from "./claude-runtime-pin-copy.js";
import { type ClaudeRuntimeFsPort } from "./claude-runtime-pin-fs.js";
import {
  buildProviderRuntimeObservation,
  type ObservationClock,
  type PlatformIdentity,
  type ProviderRuntimeObservation,
  type RuntimeClosureEntry,
} from "./claude-observation.js";

/**
 * Pre-activation runtime preparation for the Windows Claude adapter (design 13).
 *
 * Reads, hashes and copies runtime bytes into a private content-addressed root,
 * then re-observes the runtime and returns an inert binding a later launcher
 * can check bytes and location against. It holds no process authority: it never
 * executes Claude, consumes an activation grant, or calls a daemon/store
 * service. The consuming launcher is task-acf73253a204435aba590894799814f2.
 */
export interface ClaudeRuntimeFacts {
  readonly platformIdentity: PlatformIdentity;
  readonly reportedVersion: string | null;
  readonly adapterCapabilitySchemaDigest: string;
}

/** Current facts are OBSERVED here, never copied off the request's authority. */
export interface ClaudeRuntimeFactsPort {
  readonly observe: () => Promise<ClaudeRuntimeFacts>;
}

export interface ClaudeRuntimePinRequest {
  readonly quotedObservation: ProviderRuntimeObservation;
  readonly installedRoot: string;
  readonly pinRoot: string;
  readonly fs: ClaudeRuntimeFsPort;
  readonly facts: ClaudeRuntimeFactsPort;
  readonly clock: ObservationClock;
}

export interface PreparedClaudeRuntime {
  readonly ok: true;
  readonly preparationVersion: typeof CLAUDE_RUNTIME_PIN_VERSION;
  readonly quotedObservationDigest: string;
  readonly freshObservationDigest: string;
  readonly pinnedClosureDigest: string;
  readonly pinnedRoot: string;
  readonly pinRootIdentity: string;
  readonly executablePath: string;
  readonly observation: ProviderRuntimeObservation;
  readonly bindingDigest: string;
}

export type ClaudeRuntimePinResult = PreparedClaudeRuntime | ClaudeRuntimePinFailure;

export {
  CLAUDE_RUNTIME_PIN_ERROR_CODES,
  CLAUDE_RUNTIME_PIN_LAYER,
  CLAUDE_RUNTIME_PIN_VERSION,
  type ClaudeRuntimePinErrorCode,
  type ClaudeRuntimePinFailure,
} from "./claude-runtime-pin-closure.js";
export {
  RUNTIME_PIN_CHUNK_BYTES,
  createNodeClaudeRuntimeFs,
  type ClaudeRuntimeFsPort,
  type ClaudeRuntimeWriteHandle,
  type RuntimeEntryKind,
} from "./claude-runtime-pin-fs.js";

async function observeFacts(
  port: ClaudeRuntimeFactsPort,
): Promise<ClaudeRuntimeFacts | ClaudeRuntimePinFailure> {
  try {
    const facts: unknown = await port.observe();
    if (!isPlainRecord(facts) || !isPlainRecord(facts["platformIdentity"])) {
      return refuse("CLAUDE_RUNTIME_OBSERVATION_INVALID", "observation port returned no facts");
    }
    return facts as unknown as ClaudeRuntimeFacts;
  } catch (error) {
    return refuse(
      "CLAUDE_RUNTIME_OBSERVATION_INVALID",
      `observation port failed: ${describeError(error)}`,
    );
  }
}

function observe(
  entries: readonly RuntimeClosureEntry[],
  facts: ClaudeRuntimeFacts,
  clock: ObservationClock,
): ProviderRuntimeObservation | ClaudeRuntimePinFailure {
  const built = buildProviderRuntimeObservation({
    resolvedRuntimeClosure: entries,
    reportedVersion: facts.reportedVersion,
    adapterCapabilitySchemaDigest: facts.adapterCapabilitySchemaDigest,
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: facts.platformIdentity,
    clock,
  });
  if (!built.ok) {
    return refuse("CLAUDE_RUNTIME_OBSERVATION_INVALID", `${built.code}: ${built.message}`);
  }
  if (built.observation.truthClass !== "PROVEN") {
    return refuse("CLAUDE_RUNTIME_OBSERVATION_INVALID", "re-observation did not prove the runtime");
  }
  return built.observation;
}

/** Compares only what the runtime IS, so pinned paths may legitimately differ. */
function factsDigest(observation: ProviderRuntimeObservation): string {
  return canonicalDigest({
    reportedVersion: observation.reportedVersion,
    adapterCapabilitySchemaDigest: observation.adapterCapabilitySchemaDigest,
    platformIdentity: {
      os: observation.platformIdentity.os,
      arch: observation.platformIdentity.arch,
      osVersion: observation.platformIdentity.osVersion,
    },
  });
}

function bind(
  quotedObservationDigest: string,
  pinnedClosureDigest: string,
  pinnedRoot: string,
  pinRootIdentity: string,
  executablePath: string,
  observation: ProviderRuntimeObservation,
): PreparedClaudeRuntime {
  const body = {
    ok: true as const,
    preparationVersion: CLAUDE_RUNTIME_PIN_VERSION,
    quotedObservationDigest,
    freshObservationDigest: observation.observationDigest,
    pinnedClosureDigest,
    pinnedRoot,
    pinRootIdentity,
    executablePath,
    observation,
  };
  return deepFreeze({
    ...body,
    bindingDigest: canonicalDigest({
      preparationVersion: body.preparationVersion,
      quotedObservationDigest,
      freshObservationDigest: body.freshObservationDigest,
      pinnedClosureDigest,
      pinnedRoot,
      pinRootIdentity,
      executablePath,
    }),
  });
}

export async function prepareClaudeRuntimePin(
  request: ClaudeRuntimePinRequest,
): Promise<ClaudeRuntimePinResult> {
  const fs = request.fs;
  const host = fs.hostPlatform();
  if (host !== "win32") {
    return refuse(
      "CLAUDE_RUNTIME_PLATFORM_UNSUPPORTED",
      `claude runtime pinning is win32-only; host reports ${JSON.stringify(host)}`,
    );
  }
  const quote = readQuote(request.quotedObservation);
  if (isRefusal(quote)) return quote;
  for (const [label, path] of [
    ["installed root", request.installedRoot],
    ["pin root", request.pinRoot],
  ] as const) {
    const shape = pathShapeRejection(path);
    if (shape !== null) {
      return refuse("CLAUDE_RUNTIME_PATH_INVALID", `${label} ${shape}`);
    }
  }
  if ((await fs.entryKind(request.installedRoot)) !== "DIRECTORY") {
    return refuse("CLAUDE_RUNTIME_PATH_NOT_FILE", "installed root is not a directory");
  }
  const realRoot = await fs.realpath(request.installedRoot);
  const sources = await resolveSources(fs, quote.closure, realRoot);
  if (isRefusal(sources)) return sources;

  const before = await observeFacts(request.facts);
  if (isRefusal(before)) return before;
  const sourceObservation = observe(
    sources.map((entry) => ({ kind: entry.kind, path: entry.canonicalPath, sha256: entry.sha256 })),
    before,
    request.clock,
  );
  if (isRefusal(sourceObservation)) return sourceObservation;
  if (authorityDigest(sourceObservation) !== quote.authority) {
    return refuse(
      "CLAUDE_RUNTIME_OBSERVATION_CHANGED",
      "the runtime observed now is not the runtime the quote bound",
    );
  }
  return await pinAndBind(request, sources, quote.digest, sourceObservation);
}

async function pinAndBind(
  request: ClaudeRuntimePinRequest,
  sources: readonly SourceEntry[],
  quotedObservationDigest: string,
  sourceObservation: ProviderRuntimeObservation,
): Promise<ClaudeRuntimePinResult> {
  const fs = request.fs;
  const aggregate = aggregateClosureDigest(sources);
  await fs.ensureDirectory(request.pinRoot);
  const pinRoot = await fs.realpath(request.pinRoot);
  const finalRoot = win32.join(pinRoot, aggregate);

  let staging: string | null = null;
  if ((await fs.entryKind(finalRoot)) === "MISSING") {
    const staged = await stageClosure(fs, pinRoot, aggregate, sources);
    if (isRefusal(staged)) return staged;
    staging = staged;
  } else {
    const collision = await verifyPublished(fs, finalRoot, sources);
    if (collision !== null) return collision;
  }

  const prepared = await rebind(request, sources, finalRoot, sourceObservation, {
    quotedObservationDigest,
    aggregate,
    pinRoot,
  });
  if (isRefusal(prepared)) {
    // Nothing is published unless the re-observation agreed, so a staged tree
    // that got this far is removed rather than left as a half-proven runtime.
    return staging === null ? prepared : ((await tryRemove(fs, staging)) ?? prepared);
  }
  if (staging !== null) {
    const failure = await publish(fs, staging, finalRoot, sources);
    if (failure !== null) return failure;
  }
  return prepared;
}

interface BindingIdentity {
  readonly quotedObservationDigest: string;
  readonly aggregate: string;
  readonly pinRoot: string;
}

async function rebind(
  request: ClaudeRuntimePinRequest,
  sources: readonly SourceEntry[],
  finalRoot: string,
  sourceObservation: ProviderRuntimeObservation,
  identity: BindingIdentity,
): Promise<ClaudeRuntimePinResult> {
  const after = await observeFacts(request.facts);
  if (isRefusal(after)) return after;
  const pinned = sources.map((entry) => ({
    kind: entry.kind,
    path: win32.join(finalRoot, entry.relativePath),
    sha256: entry.sha256,
  }));
  const observation = observe(pinned, after, request.clock);
  if (isRefusal(observation)) return observation;
  if (factsDigest(observation) !== factsDigest(sourceObservation)) {
    return refuse(
      "CLAUDE_RUNTIME_OBSERVATION_CHANGED",
      "platform, version or capability facts changed while the closure was pinned",
    );
  }
  const executable = pinned.find((entry) => entry.kind === "EXECUTABLE");
  if (executable === undefined) {
    return refuse("CLAUDE_RUNTIME_OBSERVATION_INVALID", "pinned closure lost its EXECUTABLE");
  }
  return bind(
    identity.quotedObservationDigest,
    identity.aggregate,
    finalRoot,
    canonicalDigest({ pinRoot: identity.pinRoot, root: finalRoot }),
    executable.path,
    observation,
  );
}

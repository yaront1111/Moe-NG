import type { SqliteEventStore } from "@moe/store";

import { createFoundationDispatchHandler, foundationSyncHandler }
  from "./daemon-foundation-command.js";
import { createFoundationVerificationHandler }
  from "./daemon-foundation-verification-command.js";
import { FOUNDATION_VERIFICATION_COMMAND_KIND }
  from "./evidence/foundation-verification-contracts.js";
import type { CommandRegistryEntry } from "./http/http-contract.js";
import { createFoundationCaptureLifecycle } from "./work/foundation-capture-lifecycle.js";
import { unconfiguredFoundationContextSealPort } from "./work/foundation-context-record.js";
import type { FoundationContextSealPort } from "./work/foundation-context-record.js";
import type { FoundationCaptureLifecycle } from "./work/foundation-capture-lifecycle.js";
import { FOUNDATION_DISPATCH_COMMAND_KIND } from "./work/foundation-attempt-contracts.js";
import { LAUNCH_RUNTIME_PIN_ROOT_ENV_KEY } from "./work/launch-runtime-section.js";
import { CAPABILITIES, PAYLOAD_KEYS } from "./daemon-command-vocabulary.js";
import { createNodeProjectCatalogRegistrar } from "./projects/project-catalog-registrar.js";
import { createRepositoryBootstrapHandler } from "./repository/repository-bootstrap-command.js";
import type { BootstrapCatalogPort } from "./repository/repository-bootstrap-command.js";
import { REPOSITORY_BOOTSTRAP_COMMAND_KIND }
  from "./repository/repository-bootstrap-contracts.js";
import type { BootstrapGhPort } from "./repository/repository-bootstrap-contracts.js";

/**
 * The registry entries whose services are genuinely ASYNCHRONOUS. They are kept apart
 * from the synchronous wiring because none of it applies to them: each carries an async
 * handler and they share one synchronous handler that refuses, since the seam refuses
 * above it before it can be called.
 */
export type AsyncCommandKind =
  | typeof FOUNDATION_DISPATCH_COMMAND_KIND
  | typeof FOUNDATION_VERIFICATION_COMMAND_KIND
  // `repository.bootstrap` runs `git`, optionally the `gh` CLI and a filesystem tree write, so a
  // synchronous `CommandHandler` cannot express it. It is registered HERE rather than in
  // `daemon-command-registry.ts` for the reason that file's own comment gives: the registry is
  // past its size cap, and this module is exactly the seam it spreads for async kinds.
  | typeof REPOSITORY_BOOTSTRAP_COMMAND_KIND;

/** The two injectable halves of the bootstrap command. Production passes NEITHER and gets the
 *  real `gh` CLI and the real manager catalog; a test passes both and touches no network and no
 *  home directory. */
export interface RepositoryBootstrapSeams {
  readonly catalog?: BootstrapCatalogPort;
  readonly clock?: () => string;
  readonly gh?: BootstrapGhPort;
}

export interface AsyncCommandEntryOptions {
  /** The daemon-startup workspace catalog, shared with the capture lifecycle so the
   *  dispatch-time derivation resolves the SAME repository scope authority. */
  readonly foundationCatalogSource?: () => unknown;
  /** The pre-launch context seal. ABSENT means unconfigured, which is not the same as
   *  "skip the seal": the fallback below refuses every seal, so an unconfigured daemon
   *  cannot launch a provider with no durably recorded context manifest. */
  readonly foundationContextSeal?: FoundationContextSealPort;
  readonly foundationLifecycle?: FoundationCaptureLifecycle;
  /** The configured operator principal, forwarded to the kinds that fence themselves on it. */
  readonly operatorPrincipalId: string;
  readonly projectId: string;
  /** ABSENT means production: the real `gh` CLI and the real manager catalog on this host. */
  readonly repositoryBootstrap?: RepositoryBootstrapSeams;
  readonly store: SqliteEventStore;
  readonly verificationCatalogSource?: () => unknown;
}

/** The two async entries, keyed by kind so the registry can answer one lookup and stop. */
export function createAsyncCommandEntries(
  options: AsyncCommandEntryOptions,
): Readonly<Record<AsyncCommandKind, CommandRegistryEntry>> {
  const { projectId, store } = options;
  const foundationCatalogSource = options.foundationCatalogSource ?? ((): unknown => undefined);
  // HOST-SCOPED DAEMON-PROCESS CONFIGURATION, read once at the composition root and passed
  // down RAW. The runtime producer owns the absent and non-absolute rules and answers
  // LAUNCH_RUNTIME_PIN_ROOT_UNCONFIGURED / _INVALID itself, so pre-validating or substituting
  // a default here would be a second place for those rules to live. An unconfigured daemon
  // therefore REFUSES the dispatch under the producer's own code — the same fail-closed
  // posture `unconfiguredFoundationContextSealPort()` takes for the seal below.
  const runtimePinRoot = process.env[LAUNCH_RUNTIME_PIN_ROOT_ENV_KEY];
  const dispatchFoundationAttempt = createFoundationDispatchHandler({
    catalogSource: foundationCatalogSource,
    contextSeal: options.foundationContextSeal ?? unconfiguredFoundationContextSealPort(),
    lifecycle: options.foundationLifecycle
      ?? createFoundationCaptureLifecycle({ catalogSource: foundationCatalogSource, store }),
    // Spread rather than assigned: under exactOptionalPropertyTypes an explicit `undefined`
    // is a DIFFERENT thing from an absent key, and only the absent key means "unconfigured".
    ...(runtimePinRoot === undefined ? {} : { pinRoot: runtimePinRoot }),
    store,
  });
  const verifyFoundationAttempt = createFoundationVerificationHandler({
    projectId, store,
    // Spread rather than assigned: under exactOptionalPropertyTypes an explicit
    // `undefined` is a DIFFERENT thing from an absent key, and only the absent
    // key means "no catalog configured".
    ...(options.verificationCatalogSource === undefined
      ? {} : { verificationCatalogSource: options.verificationCatalogSource }),
  });
  // The manager catalog is resolved ONCE at composition. `createNodeProjectCatalogRegistrar`
  // reads a path and builds ports; it performs no I/O until the command actually registers.
  const bootstrapSeams = options.repositoryBootstrap ?? {};
  const bootstrapRepositoryCommand = createRepositoryBootstrapHandler({
    catalog: bootstrapSeams.catalog ?? createNodeProjectCatalogRegistrar(),
    operatorPrincipalId: options.operatorPrincipalId,
    projectId,
    store,
    // Spread rather than assigned: under exactOptionalPropertyTypes an explicit `undefined` is a
    // DIFFERENT thing from an absent key, and only the absent key means "use the real one".
    ...(bootstrapSeams.clock === undefined ? {} : { clock: bootstrapSeams.clock }),
    ...(bootstrapSeams.gh === undefined ? {} : { gh: bootstrapSeams.gh }),
  });
  return Object.freeze({
    [REPOSITORY_BOOTSTRAP_COMMAND_KIND]: Object.freeze({
      asyncHandler: bootstrapRepositoryCommand, handler: foundationSyncHandler,
      kind: REPOSITORY_BOOTSTRAP_COMMAND_KIND,
      payloadKeys: PAYLOAD_KEYS[REPOSITORY_BOOTSTRAP_COMMAND_KIND],
      requiredCapability: CAPABILITIES.ADMIN,
    }),
    [FOUNDATION_DISPATCH_COMMAND_KIND]: Object.freeze({
      asyncHandler: dispatchFoundationAttempt, handler: foundationSyncHandler,
      kind: FOUNDATION_DISPATCH_COMMAND_KIND,
      payloadKeys: PAYLOAD_KEYS[FOUNDATION_DISPATCH_COMMAND_KIND],
      requiredCapability: CAPABILITIES.WORK,
    }),
    [FOUNDATION_VERIFICATION_COMMAND_KIND]: Object.freeze({
      asyncHandler: verifyFoundationAttempt, handler: foundationSyncHandler,
      kind: FOUNDATION_VERIFICATION_COMMAND_KIND,
      payloadKeys: PAYLOAD_KEYS[FOUNDATION_VERIFICATION_COMMAND_KIND],
      requiredCapability: CAPABILITIES.WORK,
    }),
  });
}

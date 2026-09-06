import type { SqliteEventStore } from "@moe/store";

import { createFoundationDispatchHandler, foundationSyncHandler }
  from "./daemon-foundation-command.js";
import { createFoundationVerificationHandler }
  from "./daemon-foundation-verification-command.js";
import { FOUNDATION_VERIFICATION_COMMAND_KIND }
  from "./evidence/foundation-verification-contracts.js";
import type { CommandRegistryEntry } from "./http/http-contract.js";
import { DomainRefusal, domainRefusalOf } from "./daemon-command-dispatch.js";
import { RELEASE_DECIDE_COMMAND_KIND, releaseRefusal }
  from "./release/release-decide-contracts.js";
import { createFoundationCaptureLifecycle } from "./work/foundation-capture-lifecycle.js";
import { unconfiguredFoundationContextSealPort } from "./work/foundation-context-record.js";
import type { FoundationContextSealPort } from "./work/foundation-context-record.js";
import type { FoundationCaptureLifecycle } from "./work/foundation-capture-lifecycle.js";
import { FOUNDATION_DISPATCH_COMMAND_KIND } from "./work/foundation-attempt-contracts.js";
import { LAUNCH_RUNTIME_PIN_ROOT_ENV_KEY } from "./work/launch-runtime-section.js";
import { CAPABILITIES, OPERATOR_PRINCIPAL_KINDS, PAYLOAD_KEYS } from "./daemon-command-vocabulary.js";
import { createDeployCommandHandler, DEPLOY_BUILD_CONTEXT_ENV_KEY }
  from "./deployment/deploy-command.js";
import type { DeployPorts } from "./deployment/deploy-ports.js";
import { DEPLOYMENT_DEPLOY_COMMAND_KIND } from "./deployment/deploy-target-contracts.js";
import { PREVIEW_START_COMMAND_KIND } from "./preview/preview-contracts.js";
import { createPreviewStartHandler } from "./preview/preview-start-command.js";
import type { PreviewSupervisor } from "./preview/preview-supervisor.js";
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
  | typeof RELEASE_DECIDE_COMMAND_KIND
  | typeof FOUNDATION_DISPATCH_COMMAND_KIND
  | typeof FOUNDATION_VERIFICATION_COMMAND_KIND
  // `repository.bootstrap` runs `git`, optionally the `gh` CLI and a filesystem tree write, so a
  // synchronous `CommandHandler` cannot express it. It is registered HERE rather than in
  // `daemon-command-registry.ts` for the reason that file's own comment gives: the registry is
  // past its size cap, and this module is exactly the seam it spreads for async kinds.
  | typeof REPOSITORY_BOOTSTRAP_COMMAND_KIND
  // `deployment.deploy` runs `docker build`, an optional `docker save | ssh docker load`, and a
  // health poll that waits out docker's own start-period before the candidate replaces the
  // incumbent. A `CommandHandler` answers with a `ServiceOutcome` synchronously, so a sync
  // adapter could only answer BEFORE the deploy happened, and every receipt downstream of it
  // would describe an intention rather than a deployed product. Registered HERE for the same
  // reason as the kind above: the registry is past its size cap and this module is the seam it
  // spreads for async kinds.
  | typeof DEPLOYMENT_DEPLOY_COMMAND_KIND
  // `preview.start` spawns a dev server, waits for it to become answerable and drives a browser
  // through Playwright, so a synchronous `CommandHandler` could only answer BEFORE the preview
  // existed. Registered HERE for the same reason as the two kinds above: the registry is past
  // its size cap and this module is the seam it spreads for async kinds.
  | typeof PREVIEW_START_COMMAND_KIND;

/** The injectable half of the deploy. Production passes NOTHING and gets the real docker and ssh
 *  runners on this host; a test passes `ports` and touches no docker daemon and no network.
 *  `buildContext` overrides the host-scoped directory read from the environment at composition,
 *  which is how a test names a context without exporting a variable into the process. */
export interface DeploymentDeploySeams {
  readonly buildContext?: string;
  readonly clock?: () => string;
  /** Health-poll timing, forwarded untouched to the engine: an arm proving the timeout refusal
   *  must not wait out docker's real start-period in wall clock. */
  readonly healthBudgetMs?: number;
  readonly pollMs?: number;
  readonly ports?: DeployPorts;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The two injectable halves of the bootstrap command. Production passes NEITHER and gets the
 *  real `gh` CLI and the real manager catalog; a test passes both and touches no network and no
 *  home directory. */
export interface RepositoryBootstrapSeams {
  readonly catalog?: BootstrapCatalogPort;
  readonly clock?: () => string;
  readonly gh?: BootstrapGhPort;
}

export interface AsyncCommandEntryOptions {
  /** ABSENT means production: the real docker and ssh runners, and the build context this
   *  daemon was configured with. */
  readonly deploymentDeploy?: DeploymentDeploySeams;
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
  /** The daemon's ONE preview supervisor, taken off `PreviewDaemonRuntime.supervisor` rather
   *  than constructed here: a second instance would hold half the live roster, so
   *  `preview.decide` would find nothing to stop for one half and shutdown would sweep only the
   *  other. ABSENT is a REFUSING state (PREVIEW_COMMAND_MISSING @ RUNNER), never a skipped one. */
  readonly previewSupervisor?: PreviewSupervisor;
  /** The daemon's own bound product workspace, forwarded RAW. Deliberately NOT a payload key:
   *  the runner reads `<workspace>/package.json` and spawns a script out of it, so a
   *  caller-supplied path would be arbitrary command execution on this host. ABSENT refuses. */
  readonly previewWorkspace?: string | null;
  /** ABSENT means production: the real `gh` CLI and the real manager catalog on this host. */
  readonly repositoryBootstrap?: RepositoryBootstrapSeams;
  readonly store: SqliteEventStore;
  readonly verificationCatalogSource?: () => unknown;
}

/** Async entries bypass the registry's synchronous fence, so release fences at entry. */
function unconfiguredReleaseHandler(
  operatorPrincipalId: string,
): NonNullable<CommandRegistryEntry["asyncHandler"]> {
  return async (input) => {
    if (OPERATOR_PRINCIPAL_KINDS.has(RELEASE_DECIDE_COMMAND_KIND)
      && input.principal.principalId !== operatorPrincipalId) {
      throw new DomainRefusal("OPERATOR_PRINCIPAL_REQUIRED", "DAEMON_AUTHORIZATION",
        "this command requires the configured operator principal", 403);
    }
    throw domainRefusalOf(releaseRefusal("RELEASE_PR_FAILED",
      "no release port is composed for this daemon"));
  };
}

/** Async entries, keyed by kind so the registry can answer one lookup and stop. */
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
  // HOST-SCOPED DAEMON-PROCESS CONFIGURATION, read once here and passed down RAW, exactly as the
  // runtime pin root above is. The build context is deliberately NOT a payload key: a
  // caller-supplied path would let any operator-authenticated request build an arbitrary
  // directory on this host. An unconfigured daemon REFUSES the deploy under the edge's own
  // DEPLOY_BUILD_CONTEXT_UNCONFIGURED rather than building a directory nobody named.
  const deploySeams = options.deploymentDeploy ?? {};
  const buildContext = deploySeams.buildContext ?? process.env[DEPLOY_BUILD_CONTEXT_ENV_KEY];
  const deployEnvironment = createDeployCommandHandler({
    operatorPrincipalId: options.operatorPrincipalId, projectId, store,
    // Spread rather than assigned: under exactOptionalPropertyTypes an explicit `undefined` is a
    // DIFFERENT thing from an absent key, and only the absent key means "unconfigured".
    ...(buildContext === undefined ? {} : { buildContext }),
    ...(deploySeams.clock === undefined ? {} : { clock: deploySeams.clock }),
    ...(deploySeams.healthBudgetMs === undefined
      ? {} : { healthBudgetMs: deploySeams.healthBudgetMs }),
    ...(deploySeams.pollMs === undefined ? {} : { pollMs: deploySeams.pollMs }),
    ...(deploySeams.ports === undefined ? {} : { ports: deploySeams.ports }),
    ...(deploySeams.sleep === undefined ? {} : { sleep: deploySeams.sleep }),
  });
  const startPreviewCommand = createPreviewStartHandler({
    operatorPrincipalId: options.operatorPrincipalId, projectId, store,
    // Spread rather than assigned: under exactOptionalPropertyTypes an explicit `undefined` is a
    // DIFFERENT thing from an absent key, and only the absent key means "unwired".
    ...(options.previewSupervisor === undefined
      ? {} : { supervisor: options.previewSupervisor }),
    ...(options.previewWorkspace === undefined
      ? {} : { workspace: options.previewWorkspace }),
  });
  return Object.freeze({
    [PREVIEW_START_COMMAND_KIND]: Object.freeze({
      asyncHandler: startPreviewCommand, handler: foundationSyncHandler,
      kind: PREVIEW_START_COMMAND_KIND,
      payloadKeys: PAYLOAD_KEYS[PREVIEW_START_COMMAND_KIND],
      // REVIEW, matching `preview.decide`: the capability fences REACH only, and the operator
      // fence at the handler's own entry is what makes asking for a preview a human act.
      requiredCapability: CAPABILITIES.REVIEW,
    }),
    [DEPLOYMENT_DEPLOY_COMMAND_KIND]: Object.freeze({
      asyncHandler: deployEnvironment, handler: foundationSyncHandler,
      kind: DEPLOYMENT_DEPLOY_COMMAND_KIND,
      payloadKeys: PAYLOAD_KEYS[DEPLOYMENT_DEPLOY_COMMAND_KIND],
      // GOAL-scoped, read off BOOTSTRAP_FAMILY's own reasoning: the capability fences REACH
      // only, and the operator fence at the handler's entry is what makes deploying a human act.
      requiredCapability: CAPABILITIES.GOAL,
    }),
    [RELEASE_DECIDE_COMMAND_KIND]: Object.freeze({
      asyncHandler: unconfiguredReleaseHandler(options.operatorPrincipalId),
      handler: foundationSyncHandler, kind: RELEASE_DECIDE_COMMAND_KIND,
      payloadKeys: PAYLOAD_KEYS[RELEASE_DECIDE_COMMAND_KIND], requiredCapability: CAPABILITIES.GOAL,
    }),
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

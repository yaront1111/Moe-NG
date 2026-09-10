import { randomUUID } from "node:crypto";
import { createAncestryFactory, createProductionReleaseSeams } from "./release/release-production-wiring.js";
import { RELEASE_AUTO_DECIDE_JOB_ID, RELEASE_BASE_ENV_KEY, registerReleaseAutoDecide }
  from "./release/release-auto-decide.js";
import type { ReleasePublisher } from "./release/release-decide-service.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DurableStoreError } from "@moe/store";
import { readSubscriptionPage } from "@moe/store/subscriptions/subscription-read-page.js";
import {
  acknowledge, reseatToSnapshot,
} from "@moe/store/subscriptions/subscription-writes.js";
import { OPERATOR_CAPABILITIES, createDaemonCommandPorts } from "./daemon-command-registry.js";
import type { DeploymentDeploySeams } from "./daemon-command-async-entries.js";
import type { ReleasePrPort } from "./release/release-pr-port.js";
import { cutoverActivationWiringOf } from "./daemon-store-cutover-wiring.js";
import { createDaemonV2CommandPorts } from "./daemon-v2-command-registry.js";
import type { DaemonDependencyProvider } from "./daemon-entry.js";
import {
  createDeliveryV2SourceSnapshotPublisher,
  type DeliveryV2SourceSnapshotPublisher,
} from "./delivery-v2/source-snapshot-publisher.js";
import { acquireFoundationStore } from "./daemon-store-acquisition.js";
import { createSessionAuthenticator } from "./identity/session-authenticator.js";
import {
  OPERATOR_SESSION_TTL_MS, createOperatorSessionHandshakePort,
} from "./identity/session-handshake.js";
import type { SessionHandshakePort } from "./identity/session-handshake.js";
import { createCompiledNodeSource } from "./orchestrator/compiled-node-source.js";
import { COMPILED_EXECUTION_REF_PREFIX } from "./orchestrator/compiled-execution-ref.js";
import { isRepositoryWorkflowRef } from "./repository/repository-workflow-ref.js";
import { createBoardProjectionService } from "./projections/board-projection-service.js";
import type { BoardProjectionService } from "./projections/board-projection-contracts.js";
import { readLatestDocumentWorkDossier } from "./documents/document-work-service.js";
import { createBootReconciliationPort } from "./recovery/boot-reconciliation.js";
import type { BootReconciliationPort } from "./recovery/boot-reconciliation.js";
import { readCurrentActiveGraph } from "./planning/active-graph-projection.js";
import type { GraphQueryPort } from "./planning/graph-query.js";
import { createPreviewDaemonPort } from "./preview/preview-daemon-edge.js";
import type { PreviewDaemonPort } from "./preview/preview-daemon-edge.js";
import { createRestorePort } from "./recovery/restore-controller-commands.js";
import type { RestorePort } from "./recovery/restore-controller-commands.js";
import type { DesignReadInput } from "./design/design-store.js";
import { readDesignRevision } from "./design/design-store.js";
import type { DesignReadPort } from "./http/design-read.js";
import type { EnvironmentsReadPort } from "./http/environments-read.js";
import { createPreviewReadPort } from "./http/preview-read.js";
import { createReleaseReadPort } from "./http/release-evidence-read.js";
import type { PreviewCapturePort } from "./http/preview-capture-route.js";
import { launchDelivery } from "./environment/environment-launch-resolver.js";
import { readEnvironmentVariables } from "./environment/environment-store.js";
import { createAffordancePort } from "./http/affordance-read.js";
import type { NodeSpec } from "./http/affordance-contract.js";
import type { DocumentCoverageReadPort } from "./http/document-coverage-contract.js";
import { createDocumentCoverageReadPort } from "./http/document-coverage-read.js";
import { createRunsReadPort } from "./http/runs-read.js";
import type { RunsReadPort } from "./http/runs-read-contract.js";
import {
  activationReceiptInput, activationReceiptPorts,
} from "./bootstrap/activation-command-entry.js";
import { createActivationReadPort } from "./http/activation-read.js";
import type { ActivationReadPort } from "./http/activation-read.js";
import { createPolicyReadPort } from "./http/policy-read.js";
import type { PolicyReadPort } from "./http/policy-read.js";
import { createHealthReadPort } from "./http/health-read.js";
import type { HealthReadPort } from "./http/health-read.js";
import { createRepositoryExecutionPort } from "./repository/repository-execution-port.js";
import { createActivityReadPort } from "./http/activity-read.js";
import type { ActivityReadPort } from "./http/activity-read.js";
import { createSessionsReadPort } from "./http/sessions-read.js";
import type { SessionsReadPort } from "./http/sessions-read.js";
import { readWrapperKnobs } from "./orchestrator/wrapper-knobs.js";
import { createRepositoryRemoteReadPort } from "./http/repository-remote-read.js";
import type { RepositoryRemoteReadPort } from "./http/repository-remote-read.js";
import type { DocumentDossierReadPort } from "./http/document-dossier-read.js";
import { createDocumentIngestPort } from "./http/document-ingest-route.js";
import type { DocumentIngestPort } from "./http/document-ingest-route.js";
import { createGoalCatalogReadPort } from "./http/goal-catalog-read.js";
import { createProductContractPendingReadPort } from "./http/product-contract-pending-read.js";
import type { ProductContractPendingReadPort } from "./http/product-contract-pending-read.js";
import {
  createProductContractV2CurrentReadPort,
  type ProductContractV2CurrentReadPort,
} from "./http/product-contract-v2-current-read.js";
import {
  createProductContractV2PendingReadPort,
  type ProductContractV2PendingReadPort,
} from "./http/product-contract-v2-pending-read.js";
import { createGoalSourceReadPort } from "./documents/document-source-full-read.js";
import type { GoalSourceReadPort } from "./documents/document-source-full-read.js";
import type { GoalCatalogReadPort } from "./http/goal-catalog-read.js";
import { createPlanningRunReadPort } from "./http/planning-run-read.js";
import type { PlanningRunReadPort } from "./http/planning-run-read.js";
import { createBudgetCommitmentReadPort,
  type BudgetCommitmentReadPort } from "./http/budget-commitment-read.js";
import { createProductContractGate1ReadPort,
  type ProductContractGate1ReadPort } from "./http/product-contract-gate-1-read.js";
import { createSessionChallengeOperandsReadPort,
  type SessionChallengeOperandsReadPort } from "./http/session-challenge-operands-read.js";
import { createSessionAuthority } from "./identity/session-authority.js";
import type { PairingOpenSessionPort } from "./http/pairing-open-completion.js";
import { createEventStreamAccessPort, createEventStreamSubscriberResolver } from "./http/event-stream-access.js";
import type { CommandAdapterDeps, CommandAuthorityPlanePort } from "./http/http-contract.js";
import { admitV2ActiveInstallation } from "./cutover/cutover-v2-authority.js";
import type { StreamAcknowledgeRequest, StreamPageRequest, StreamReseatRequest,
  SubscriptionPort } from "./http/event-stream-contract.js";
import { enrollDecisionLedgerMemo } from "./decision-ledger-memo.js";
import { createRepositoryWorkflowWiring } from "./daemon-repository-workflow-wiring.js";
import { createDurableSchedule } from "./orchestrator/durable-schedule.js";
import type { ScheduleRefusal } from "./orchestrator/durable-schedule.js";
import type { DurableSchedule, ScheduleConfig } from "./orchestrator/durable-schedule.js";
import { createEnvironmentHealthProbeJob, createHealthProbeJob, createHealthProbeRing } from "./monitoring/health-probe-ring.js";
import type { HealthHttpPort } from "./monitoring/health-probe-ring.js";
import { HEALTH_PROBE_JOB_ID, HEALTH_PROBE_SIDECAR_SUFFIX, healthProbeJobEnvironment, healthProbeJobId }
  from "./monitoring/health-probe-contracts.js";
import { DEFAULT_PROBE_INTERVAL_MS, createProbeIntervalRecord } from "./monitoring/probe-interval-record.js";
import { createEnvironmentRetirementRecord } from "./monitoring/environment-retirement-record.js";
import { readDeployLedger } from "./deployment/deploy-ledger.js";
import type { DeploymentsHealthReadPort } from "./http/deployments-health-read.js";
import {
  BACKUP_RESTORE_PROOF_SIDECAR_SUFFIX, createBackupRestoreProofStore,
} from "./backups/backup-restore-proof.js";
import type { BackupsReadPort } from "./http/backups-read.js";

export interface StoreDependencyConfig {
  readonly deploymentDeploy?: DeploymentDeploySeams;
  /**
   * Replaces ONLY the pull-request spawn of the release edge; every other release collaborator
   * (the publisher, the dossier facts, the workspace, the clock) stays the production one.
   * Absent is the real `gh`, which is what any daemon nobody configured keeps getting.
   *
   * The same shape and the same reason as `deploymentDeploy` above: a lane that wants to prove
   * the release chain end to end cannot spawn `gh` against a real repository on every run, and
   * a lane that faked the whole seam would prove only that its own double answers.
   */
  readonly releasePrPort?: ReleasePrPort;
  readonly healthProbeHttp?: HealthHttpPort;
  readonly schedule?: Pick<ScheduleConfig, "timer" | "resolve">;
  readonly repositoryWorkspace?: string | null;
  /** Optional deterministic command identity source for bounded harness composition. */
  readonly affordanceMintId?: ((kind: string) => string) | undefined;
  readonly clock?: () => string;
  readonly credential: string;
  /** OPTIONAL. Where `cutover.activate` reads the live-quiesce evidence; absent means the
   *  kind refuses CUTOVER_ACTIVATE_UNCONFIGURED (see daemon-store-cutover-wiring.ts). */
  readonly cutoverEvidenceRoot?: string | undefined;
  readonly nodeSpecsDir?: string | undefined;
  readonly principalId: string;
  readonly projectConfigurationDigest?: string | undefined;
  readonly projectId: string;
  readonly storePath: string;
  /** OPTIONAL, same rule as the workspace catalog: absent is a valid state, and
   *  recipe sealing then refuses at use time rather than blocking boot. */
  readonly verificationCatalogPath?: string | undefined;
  /** OPTIONAL. Absent is a valid state: Foundation preparation then refuses at
   *  dispatch time and the daemon still boots and serves every other kind. */
  readonly workspaceCatalogPath?: string | undefined;
}

function nodeSpecLoader(directory: string): () => readonly NodeSpec[] {
  return () => {
    let entries: string[];
    try {
      entries = readdirSync(directory).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const specs: NodeSpec[] = [];
    for (const name of entries.sort()) {
      try {
        const parsed = JSON.parse(readFileSync(join(directory, name), "utf8")) as {
          nodeRef?: unknown; title?: unknown;
        };
        if (typeof parsed.nodeRef === "string" && parsed.nodeRef.length > 0
          && !parsed.nodeRef.startsWith(COMPILED_EXECUTION_REF_PREFIX)
          && !isRepositoryWorkflowRef(parsed.nodeRef)
          && typeof parsed.title === "string") {
          // A file-authored spec carries no sealed build order — this format has
          // no dependency field to read — so it declares none rather than
          // inventing one. Only compiled-graph nodes can gate on dependencies.
          specs.push({ dependsOn: [], nodeRef: parsed.nodeRef, title: parsed.title });
        }
      } catch { /* skipped, never invented */ }
    }
    return specs;
  };
}

export type StoreDependencyProvider = DaemonDependencyProvider & {
  releasePublisher(): ReleasePublisher;
  close(): void;
  schedules(): DurableSchedule;
  restore(): RestorePort;
  sourceSnapshotPublisher(): DeliveryV2SourceSnapshotPublisher;
};

export function createStoreDependencies(
  config: StoreDependencyConfig,
): StoreDependencyProvider {
  const clock = config.clock ?? ((): string => new Date().toISOString());
  // One composition clock for every authority decision. Mixing an injected
  // command clock with Date.now() lets a session be current to the command
  // ledger and expired to authentication during the same request.
  const epochClock = (): number => Date.parse(clock());
  const { foundation, store } = acquireFoundationStore({
    clock, projectConfigurationDigest: config.projectConfigurationDigest,
    projectId: config.projectId, storePath: config.storePath,
    verificationCatalogPath: config.verificationCatalogPath, workspaceCatalogPath: config.workspaceCatalogPath,
  });
  // A long-lived handle keeps its decoded decision ledger: every read model over it tops up
  // from the last position instead of re-walking the whole ledger per request.
  enrollDecisionLedgerMemo(store);
  const repositoryWorkspace = config.repositoryWorkspace === undefined ? process.env["MOE_NODE_WORKSPACE"] ?? null : config.repositoryWorkspace;
  // The runner and capture reader share the same startup binding; no store-directory or CWD fallback.
  const previewCaptures = (): PreviewCapturePort => Object.freeze({
    projectDirectory: () => {
      if (repositoryWorkspace === null || repositoryWorkspace === "") throw new Error("preview workspace unavailable");
      return repositoryWorkspace;
    },
  });
  const releaseDecide = {
    ...createProductionReleaseSeams({ store, projectId: config.projectId,
      storePath: config.storePath, workspace: repositoryWorkspace === "" ? null : repositoryWorkspace, clock }),
    // Spread rather than assigned: under exactOptionalPropertyTypes an explicit `undefined` is a
    // DIFFERENT thing from an absent key, and only the absent key means "spawn the real gh".
    ...(config.releasePrPort === undefined ? {} : { prPort: config.releasePrPort }),
  };
  const workflows = createRepositoryWorkflowWiring({ store, projectId: config.projectId, storePath: config.storePath,
    workspace: repositoryWorkspace === "" ? null : repositoryWorkspace, nodeSpecsDir: config.nodeSpecsDir, clock });
  const sourceSnapshotPublisher = createDeliveryV2SourceSnapshotPublisher({
    catalogSource: foundation.foundationCatalogSource,
    clock,
    projectId: config.projectId,
    store,
  });
  let subscriptionDatabase: DatabaseSync | null = null;
  const DEFAULT_READER = "control-room-1";
  const resolveSubscriberId = createEventStreamSubscriberResolver({
    clock: () => Date.parse(clock()), operatorCapabilities: OPERATOR_CAPABILITIES,
    operatorPrincipalId: config.principalId, operatorSubscriberId: DEFAULT_READER, store,
    projectId: config.projectId,
  });
  const cutoverWiring = cutoverActivationWiringOf(config.cutoverEvidenceRoot);
  /**
   * THE DAEMON'S ONE PREVIEW SUPERVISOR, constructed HERE and nowhere else. It holds live
   * preview processes in memory, so a second instance would hold half the roster: the decide
   * edge would find nothing to stop for one half and shutdown would sweep only the other. The
   * SAME object is handed to the command registry below and returned as `previews` for the
   * entry's shutdown sweep, which is what makes "stop it once between them" true.
   */
  /**
   * THE PREVIEW'S ENVIRONMENT DELIVERY. A preview runs the product's OWN dev server, so it is the
   * one child in this process that legitimately needs the operator's variables.
   *
   * RESOLVED HERE BECAUSE THIS IS WHERE THE CREDENTIAL IS A FACT. `PreviewRunnerConfig` carries
   * `projectId` and `store` but no credential; threading one down would put a SECOND
   * `EnvironmentStoreConfig` construction inside the runner - a second place a value could be
   * assembled, which is exactly what the environments READ port below refuses to do. This root
   * already owns the same thunk (`environmentCredential`, a few lines down).
   *
   * The resolver takes a purpose and no environment name, so a preview cannot be pointed at
   * `production` by a payload or a later edit here. `undefined` - no credential, or no `preview`
   * variables - makes `deliverEnvironment` return the allowlisted object BY REFERENCE, so such a
   * preview spawns byte-identically to before this line existed. Collisions are that module's
   * call: the allowlisted runtime value wins, because the store admits names like `PATH`.
   */
  const previewDelivered = launchDelivery({
    credential: () => config.credential, now: clock, projectId: config.projectId, store,
  }, "PREVIEW");
  const previewPort = createPreviewDaemonPort({
    ...(previewDelivered === undefined ? {} : { process: { delivered: previewDelivered } }),
    projectId: config.projectId, store,
  });
  const { decisions, registry } = createDaemonCommandPorts({
    ...(config.deploymentDeploy === undefined ? {} : { deploymentDeploy: config.deploymentDeploy }),
    releaseDecide,
    criterionEvidence: workflows.criterionEvidence, repositoryRecovery: workflows.repositoryRecovery,
    readPublicationCandidate: workflows.readPublicationCandidate,
    clock,
    ...cutoverWiring,
    eventSubscriberId: DEFAULT_READER,
    // The SAME key the environments READ port seals under below, handed in as a thunk for the
    // same reason: `resolveCredential` treats a throw as an absent key rather than letting an
    // error naming a credential path escape. Without this the two environment WRITE kinds would
    // register and then refuse every dispatch ENV_STORE_KEY_UNAVAILABLE -- served but unusable.
    environmentCredential: () => config.credential,
    foundationCatalogSource: foundation.foundationCatalogSource,
    ...(foundation.foundationContextSeal === undefined
      ? {} : { foundationContextSeal: foundation.foundationContextSeal }),
    foundationLifecycle: foundation.foundationLifecycle,
    operatorPrincipalId: config.principalId, preview: previewPort,
    // THE SAME supervisor object, in the half the async `preview.start` entry needs. Taken off
    // the runtime rather than constructed a second time: two supervisors would each hold half
    // the live roster, so the decide edge would find nothing to stop for one half and shutdown
    // would sweep only the other. The workspace is the daemon's OWN bound one -- never a
    // payload value, because the runner spawns a script out of it.
    previewSupervisor: previewPort.supervisor, previewWorkspace: repositoryWorkspace,
    projectId: config.projectId,
    store,
    verificationCatalogSource: foundation.verificationCatalogSource,
  });
  const v2Ports = createDaemonV2CommandPorts({
    ...(config.deploymentDeploy === undefined ? {} : { deploymentDeploy: config.deploymentDeploy }),
    releaseDecide,
    clock,
    ...cutoverWiring,
    eventSubscriberId: DEFAULT_READER,
    foundationCatalogSource: foundation.foundationCatalogSource,
    ...(foundation.foundationContextSeal === undefined
      ? {} : { foundationContextSeal: foundation.foundationContextSeal }),
    foundationLifecycle: foundation.foundationLifecycle,
    operatorPrincipalId: config.principalId, projectId: config.projectId, store,
    verificationCatalogSource: foundation.verificationCatalogSource,
  });

  const authenticator = createSessionAuthenticator(store, {
    clock: epochClock,
    operatorCapabilities: OPERATOR_CAPABILITIES,
    operatorCredential: config.credential,
    operatorPrincipalId: config.principalId,
    projectId: config.projectId,
  });
  const eventStreamAccess = createEventStreamAccessPort({
    operatorCapabilities: OPERATOR_CAPABILITIES, operatorPrincipalId: config.principalId,
    projectId: config.projectId, resolveSubscriberId, store,
  });

  const provide = (): CommandAdapterDeps =>
    Object.freeze({ authenticator, decisions, eventStreamAccess, registry });
  const provideV2 = (): CommandAdapterDeps => Object.freeze({
    authenticator,
    decisions: v2Ports.decisions,
    eventStreamAccess,
    registry: v2Ports.registry,
  });

  /** One acquisition = one handle plus the board built over it; the pair travels
   *  together because a board fold is only meaningful over the handle it read. */
  type SubscriptionHandles = Readonly<{ board: BoardProjectionService; database: DatabaseSync }>;

  const subscriptions = (): SubscriptionPort => {
    /** This port's view of the shared handle. Dropped on quarantine, so staleness
     *  is per port: a sibling that never saw the ambiguity re-acquires on its next
     *  operation because its pair no longer matches the module cache. */
    let cached: SubscriptionHandles | null = null;

    const acquire = (): SubscriptionHandles => {
      if (cached !== null && cached.database === subscriptionDatabase) return cached;
      const database = subscriptionDatabase ?? new DatabaseSync(config.storePath);
      subscriptionDatabase = database;
      database.exec("PRAGMA busy_timeout = 5000;");
      const board = createBoardProjectionService({ database, store });
      const baseline = board.ensureBaseline("daemon provider startup");
      if (baseline.outcome === "BASELINE_READY") board.registerReader(DEFAULT_READER);
      cached = Object.freeze({ board, database });
      return cached;
    };

    /**
     * OUTCOME_UNKNOWN means the COMMIT threw after the transaction already ended:
     * the write may have durably landed, so every in-memory assumption held over
     * this handle (board fold, cursor positions) may now diverge from the durable
     * rows. The handle is QUARANTINED — both caches are dropped so the NEXT
     * operation re-acquires fresh and re-reads durable state — and the error is
     * rethrown unchanged, following the decision ledger's poison() precedent of
     * discarding state on ambiguity. The superseded handle is deliberately NOT
     * close()d: sibling port instances (http listener, mcp, mcp-http can coexist)
     * legitimately hold it, and closing under them would convert one ambiguous
     * write into permanent failures everywhere; it is left to GC.
     */
    const quarantining = <Result>(run: (handles: SubscriptionHandles) => Result): Result => {
      const handles = acquire();
      try {
        return run(handles);
      } catch (error) {
        if (error instanceof DurableStoreError && error.code === "OUTCOME_UNKNOWN") {
          if (subscriptionDatabase === handles.database) subscriptionDatabase = null;
          if (cached?.database === handles.database) cached = null;
        }
        throw error;
      }
    };

    // Eager: boot-time baseline/reader-registration semantics are unchanged.
    acquire();
    return Object.freeze({
      acknowledge: (request: StreamAcknowledgeRequest) =>
        quarantining(({ database }) => acknowledge(database, request)),
      readPage: (request: StreamPageRequest) => {
        // Re-acquired through the same gate, so a quarantined port heals on its
        // next read too; reads never produce OUTCOME_UNKNOWN, so no wrap here.
        const { board, database } = acquire();
        const folded = board.foldOnce();
        if (folded.outcome !== "FOLDED") return folded;
        return readSubscriptionPage(store, database, request);
      },
      reseat: (request: StreamReseatRequest) =>
        quarantining(({ database }) => reseatToSnapshot(database, request)),
    });
  };

  // Board nodes come from BOTH sources: the operator's spec dir (which wins on
  // a nodeRef collision — a hand-authored spec is an explicit override) and the
  // durable ACTIVE graph's sealed execution nodes, so an approved COMPILED plan
  // surfaces its own buildable work with no spec file ever written.
  const compiledNodes = createCompiledNodeSource({
    projectId: config.projectId,
    store,
    // Listing needs no host facts; briefs are the wrapper's concern.
    testCommand: null,
    workspace: null,
  });
  const specNodes = config.nodeSpecsDir === undefined
    ? (): readonly NodeSpec[] => []
    : nodeSpecLoader(config.nodeSpecsDir);
  const mergedNodes = (): readonly NodeSpec[] => {
    const specs = specNodes();
    const listed = new Set(specs.map((spec) => spec.nodeRef));
    return [
      ...specs,
      ...compiledNodes.nodes().filter((node) => !listed.has(node.nodeRef)),
    ];
  };
  const affordances = () => createAffordancePort({
    mintId: config.affordanceMintId ?? (() => randomUUID()),
    nodes: mergedNodes,
    principalId: config.principalId,
    projectId: config.projectId,
    store,
  });

  /**
   * Both fields are SERVER facts held by this root: the already-open store and
   * the project this daemon was started for. Neither is reachable from a
   * request, which is what makes `boundProjectId` a bound rather than a hint.
   */
  const graph = (): GraphQueryPort => Object.freeze({
    boundProjectId: config.projectId,
    readCurrentActiveGraph: (projectId: string) => readCurrentActiveGraph(store, projectId),
  });

  const documentDossiers = (): DocumentDossierReadPort => Object.freeze({
    readLatest: (projectId: string) => readLatestDocumentWorkDossier(store, projectId),
  });

  const goalCatalog = (): GoalCatalogReadPort =>
    createGoalCatalogReadPort({ projectId: config.projectId, store });

  const goalSource = (): GoalSourceReadPort =>
    createGoalSourceReadPort({ projectId: config.projectId, store });

  /**
   * The versioned design aggregate, read. Closed over THIS root's store and NOTHING ELSE --
   * `projectId` deliberately stays out of the closure even though every neighbouring port binds
   * it. `readDesignRevision` matches the stored record's projectId against its INPUT, and the
   * HTTP handler feeds that input from the AUTHENTICATED PRINCIPAL; binding a second project
   * here would make the check agree with itself and hide a principal/project mismatch rather
   * than refuse it. `design-read.ts:24` records the same rule from the consuming side.
   */
  const designReads = (): DesignReadPort => Object.freeze({
    read: (input: DesignReadInput) => readDesignRevision(store, input),
  });

  /**
   * The per-environment variable table, read. Delegates WHOLE to child 1's
   * `readEnvironmentVariables`, which resolves the credential, proves the existing seals open,
   * folds the aggregate and projects `{name, isSet, fingerprintSha256, updatedAt}`. Nothing is
   * re-derived here: a second read path would be a second place a value could be assembled.
   *
   * The credential is the SAME `MOE_DAEMON_CREDENTIAL` the operator plane authenticates with
   * (daemon-store-dependencies.ts:42), handed in as a THUNK because `resolveCredential` treats a
   * throw as an absent key rather than letting an error naming a credential path escape. An
   * empty string is ABSENT, so a daemon booted without it answers ENV_STORE_KEY_UNAVAILABLE
   * instead of listing an environment it cannot actually decrypt.
   *
   * `projectId` IS bound here, unlike the design read's deliberate omission: the environment
   * aggregate id is `environment/<projectId>/<name>`, so the project is the composition root's
   * own fact and there is no request field that could name another one.
   */
  const environmentReads = (): EnvironmentsReadPort => Object.freeze({
    read: (input: { readonly environment: string }) => readEnvironmentVariables(
      { credential: () => config.credential, now: clock, projectId: config.projectId, store },
      input.environment,
    ),
  });

  /**
   * The pending-plan read and the operator document ingest, both bound to this root's own store
   * and project - the only place those are FACTS rather than request input. The ingest mints its
   * correlation id and decision time per call, here, for the same reason.
   */
  const planningRuns = (): PlanningRunReadPort =>
    createPlanningRunReadPort({ projectId: config.projectId, store });
  /**
   * The budget commitment answers from THIS root's store and project; a caller names only a
   * run. The value is the shared builder's, so a storeless client gets exactly what the
   * activation bind-back will later verify against.
   */
  const budgetCommitment = (): BudgetCommitmentReadPort =>
    createBudgetCommitmentReadPort({ projectId: config.projectId, store });
  /** PRD coverage: the bound goals, contracts and verified criteria of one source document. */
  const documentCoverage = (): DocumentCoverageReadPort =>
    createDocumentCoverageReadPort({ projectId: config.projectId, store });
  /** Runs and leases: every bound goal, its run, its sealed nodes and their durable state. */
  const runs = (): RunsReadPort => createRunsReadPort({ projectId: config.projectId, store });
  /** Installed policy, its evaluations and the verifier standing, from this root store. */
  const policy = (): PolicyReadPort => createPolicyReadPort({ projectId: config.projectId, store });
  /**
   * The six activation receipts as a READ. Constructed once — `readActivation` re-measures on
   * every call, and caching the RESULT would certify a tree the operator has since changed.
   * The two DURABLE readers are handed in deliberately: without them `nodeActivationReceiptPorts`
   * defaults `committedProbeRef` to null and `installedPolicySliceRefs` to [], so provider and
   * policy would read UNMEASURED forever on a project that has in fact probed and installed.
   * `createActivationReadPort` then applies `readOnlyActivationPorts`, which neuters `backup`
   * and `fs.mkdir` — so this stays a read and never creates `<projectRoot>/.moe-next/backups/`.
   */
  const activation = (): ActivationReadPort => createActivationReadPort({
    input: activationReceiptInput(config.projectId),
    ports: activationReceiptPorts(store, config.projectId),
  });
  /** The process facts this composition holds, plus the ledger it reads; the plane is read live. */
  const composedAt = (config.clock ?? (() => new Date().toISOString()))();
  // This is the wrapper's configured compiled-workspace binding, captured for this daemon.
  // No CWD fallback: an unconfigured or spec-only workspace remains UNKNOWN on Health.
  const repositoryExecution = createRepositoryExecutionPort();
  const health = (): HealthReadPort => createHealthReadPort({
    // The SAME clock every authority decision reads, so a provider pause and the decisions the
    // daemon takes while it holds agree on what "now" is.
    clock,
    nodeSpecsDir: config.nodeSpecsDir ?? null,
    projectId: config.projectId,
    readPlane: () => commandAuthorityPlane().readPlane(),
    readRepository: repositoryWorkspace === null || repositoryWorkspace === ""
      ? undefined : () => repositoryExecution.inspect(repositoryWorkspace),
    startedAt: composedAt,
    store,
    storePath: config.storePath,
  });
  /** What the daemon decided, latest first, for the project or one goal. */
  const activity = (): ActivityReadPort => createActivityReadPort({ projectId: config.projectId, store });
  /**
   * Who holds a seat and what it claims, at this root clock — plus the agent limit this
   * daemon was LAUNCHED with (configured, not observed; see SessionsConcurrency). Taken from
   * the wrapper's own strict parser, never re-parsed here: wrapper-knobs.ts:1-8 says why a
   * lenient read is catastrophic. Read here, not inside the port, so the port stays testable.
   */
  const sessions = (): SessionsReadPort => createSessionsReadPort({
    configuredAgentLimit: readWrapperKnobs(process.env).maxAgents,
    projectId: config.projectId,
    store,
  });
  /** The remote the first publish bound for this project, at this root clock. */
  const repositoryRemote = (): RepositoryRemoteReadPort =>
    createRepositoryRemoteReadPort({ clock, projectId: config.projectId, store, readPublicationCandidate: workflows.readPublicationCandidate });
  /** Gate 1 answers from THIS root's store and project; a caller names only a revision triple. */
  const productContractGate1 = (): ProductContractGate1ReadPort =>
    createProductContractGate1ReadPort({ projectId: config.projectId, store });
  /** The Gate 1 CARD's read: the pending revision for one goal, template minted per read. */
  const productContractPending = (): ProductContractPendingReadPort =>
    createProductContractPendingReadPort({
      mintId: () => `gate1-${randomUUID()}`, projectId: config.projectId, store,
    });
  /** Activated `/2` current-contract state, bound to this root's store and project. */
  const productContractV2Current = (): ProductContractV2CurrentReadPort =>
    createProductContractV2CurrentReadPort({ projectId: config.projectId, store });
  /** `/2` pending work with command and correlation identities minted only by this daemon. */
  const productContractV2Pending = (): ProductContractV2PendingReadPort =>
    createProductContractV2PendingReadPort({
      mintCommandId: () => `product-contract-v2-command:${randomUUID()}`,
      mintCorrelationId: () => `product-contract-v2-correlation:${randomUUID()}`,
      projectId: config.projectId,
      store,
    });
  /**
   * The plane `/bootstrap` tells a browser to write to, derived from the durable
   * cutover marker on EVERY read and never cached, so the answer flips the moment
   * `cutover.activate` commits. The same marker read the V1 gate uses: an
   * unreadable or readiness-divergent marker answers V1 here, and `/command` then
   * refuses that write itself with V1_AUTHORITY_STATUS_UNKNOWN, so the browser is
   * routed to the plane that names the fault rather than to one that is silent.
   */
  const commandAuthorityPlane = (): CommandAuthorityPlanePort => Object.freeze({
    boundProjectId: config.projectId,
    readPlane: () =>
      admitV2ActiveInstallation(store, { projectId: config.projectId }).ok ? "V2" : "V1",
  });
  /**
   * The OPEN_SESSION challenge operands, bound to THIS root's store and project.
   * A caller names nothing: the principal is the authenticated one.
   */
  const sessionChallengeOperands = (): SessionChallengeOperandsReadPort =>
    createSessionChallengeOperandsReadPort({ projectId: config.projectId, store });

  /**
   * The session authority the pairing OPEN COMPLETION composes. Same store and same
   * project as the operand port above, and deliberately the same construction the
   * authenticator uses: a completion that verified against a DIFFERENT authority than
   * the one authenticating later would mint a session nothing could then use.
   */
  const pairingOpenSessions = (): PairingOpenSessionPort =>
    createSessionAuthority(store, { clock: epochClock, projectId: config.projectId });

  const documentIngest = (): DocumentIngestPort => createDocumentIngestPort({
    clock,
    mintCorrelationId: () => `document-ingest:${randomUUID()}`,
    operatorPrincipalId: config.principalId,
    projectId: config.projectId,
    store,
  });

  /**
   * The operator credential mint. Built over this root's own store, project and
   * operator principal - the only place they are FACTS rather than request input -
   * so a minted session authenticates through the very authenticator wired above.
   * The clock is epoch ms because the expiry it stamps is compared numerically.
   */
  const sessionHandshake = (): SessionHandshakePort => createOperatorSessionHandshakePort({
    capabilities: OPERATOR_CAPABILITIES,
    clock: epochClock,
    operatorPrincipalId: config.principalId,
    projectId: config.projectId,
    reservedPrincipalIds: [config.principalId],
    sessionTtlMs: OPERATOR_SESSION_TTL_MS,
    store,
  });

  /**
   * Built over the store and the durable configuration this root already holds —
   * the only place where the project and the operator principal are FACTS rather
   * than something a caller passed to `startDaemon`. The correlation and the
   * decision time are minted per sweep, here, for the same reason.
   */
  const reconciliation = (): BootReconciliationPort => createBootReconciliationPort({
    clock,
    correlationId: () => `daemon-boot-reconcile:${randomUUID()}`,
    principalId: config.principalId,
    projectId: config.projectId,
    store,
  });

  const probeOptions = { store, projectId: config.projectId, clock,
    ...(config.healthProbeHttp === undefined ? {} : { http: config.healthProbeHttp }) };
  const probeIntervals = createProbeIntervalRecord({ store, projectId: config.projectId, now: epochClock });
  const probeRetirements = createEnvironmentRetirementRecord({ store, projectId: config.projectId, now: epochClock });
  /**
   * The environments an operator has given their OWN probe interval. Read from the durable record
   * on every call rather than captured once, so setting or clearing an interval takes effect on the
   * next tick instead of at the next restart. A store that cannot answer yields the EMPTY set, which
   * hands every environment back to the sweep at the default rate — never no probing at all.
   */
  const dedicated = (): ReadonlySet<string> => {
    const intervals = probeIntervals.stored();
    return new Set(intervals.ok ? intervals.value.keys() : []);
  };
  /** Only verified retirement suppresses monitoring. An unreadable record yields no exclusions:
   * this may probe a retired URL, but inventing "all retired" would silently blind live environments.
   * Read fresh each time; a new successful receipt can end retirement without a restart. */
  const retired = (): ReadonlySet<string> => {
    const snapshot = probeRetirements.stored();
    return new Set(snapshot.ok ? snapshot.value.keys() : []);
  };
  const dedicatedJob = (environment: string): ReturnType<typeof createHealthProbeJob> =>
    createEnvironmentHealthProbeJob(probeOptions, environment, () => dedicated().has(environment) && !retired().has(environment));
  /**
   * Brings the armed schedules in line with the durable record. `register` is idempotent - an
   * unchanged interval neither re-persists (durable-schedule.ts:93) nor re-arms (`arm()` :77) - so
   * this is safe to run on every sweep tick, and running it there is what makes a NEW or CHANGED
   * interval take effect WITHOUT a daemon restart. A CLEARED one needs no drop: its job's `active`
   * predicate goes false on the same tick the sweep reclaims the environment, so neither probes twice.
   * Retired entries are not armed. Existing arms stay inert until reactivation or close() releases
   * them: the scheduler has no scoped stop, and a global rebuild would drop unrelated live callbacks
   * lacking restore resolvers. This deliberately retains a reactivation watcher, not a live probe.
   */
  const reconcileProbeSchedules = (): ScheduleRefusal | null => {
    const intervals = probeIntervals.stored();
    if (!intervals.ok) return null;
    const excluded = retired();
    for (const [environment, intervalMs] of intervals.value) {
      if (excluded.has(environment)) continue;
      const armed = schedules.register(healthProbeJobId(environment), dedicatedJob(environment), intervalMs);
      if (!armed.ok) return armed;
    }
    return null;
  };
  const sweepProbe = createHealthProbeJob(probeOptions, dedicated, retired);
  /** Reconcile BEFORE sweeping, so an environment that just gained its own interval is excluded
   * from this very tick rather than being probed twice on the way to being right. */
  const healthProbe = async (signal: AbortSignal): Promise<void> => {
    reconcileProbeSchedules();
    await sweepProbe(signal);
  };
  /**
   * The operator-facing read over what the probe job WRITES. It opens the SAME sidecar the job
   * does — one shared suffix constant, so the writer and the reader cannot come to disagree about
   * which file the ring lives in — and it re-derives the state on every call rather than caching
   * one, because a cached verdict is a stored status field by another name.
   *
   * The project is bound HERE, never from a request: the ring rows and the deploy ledger are both
   * scoped by projectId, and a route-supplied one would let a caller read another project's
   * outage. A store with no durable path refuses as PROBE_STORE_UNAVAILABLE rather than serving
   * an empty history that would read as "nothing wrong".
   */
  const deploymentsHealth = (): DeploymentsHealthReadPort => {
    const databasePath = store.getHealth().databasePath;
    const ring = databasePath === null
      ? null : createHealthProbeRing(`${databasePath}${HEALTH_PROBE_SIDECAR_SUFFIX}`, config.projectId);
    return Object.freeze({
      read: (input: { readonly environment: string }) => {
        if (ring === null) {
          return Object.freeze({ code: "PROBE_STORE_UNAVAILABLE" as const, layer: "DAEMON_INGRESS" as const, ok: false as const });
        }
        const probes = ring.read(input.environment);
        if (!probes.ok) return probes;
        const incidents = ring.incidents(input.environment);
        if (!incidents.ok) return incidents;
        /**
         * THE EFFECTIVE INTERVAL, RESOLVED BY THE RECORD THAT OWNS IT — the SAME `probeIntervals`
         * the scheduler reconciles against above, so the rate an operator is shown and the rate
         * the daemon actually probes at cannot come to disagree. `read` answers the stored value
         * or `DEFAULT_PROBE_INTERVAL_MS`; this composition never applies a default of its own.
         *
         * A REFUSAL IS RETURNED, NEVER LAUNDERED INTO THE DEFAULT. Serving 60000 for an
         * environment whose interval record could not be read would show an operator a rate
         * nobody stored, indistinguishable from one deliberately left unset. It travels out
         * verbatim with its own `PROBE_INTERVAL_*` code and its `DAEMON_INGRESS` layer.
         *
         * It is consulted AFTER the ring, because the ring's history is what this read is ABOUT:
         * an unreadable ring is the more fundamental fault and answers first.
         */
        const probeIntervalMs = probeIntervals.read(input.environment);
        if (!probeIntervalMs.ok) return probeIntervalMs;
        return Object.freeze({
          ok: true as const,
          value: Object.freeze({
            deploys: readDeployLedger(store, config.projectId).get(input.environment) ?? null,
            incidents: incidents.value,
            probeIntervalMs: probeIntervalMs.value,
            probes: probes.value,
          }),
        });
      },
    });
  };
  /**
   * Rebinds a job id persisted by a previous boot. A per-environment id whose interval record has
   * since been cleared, or whose environment is retired, resolves to NOTHING on purpose: the
   * scheduler refuses SCHEDULE_TARGET_UNRESOLVED and drops the arm. The sweep reclaims cleared
   * intervals at the default rate but still excludes retired environments. Manufacturing a callback
   * here would leave a job probing an environment at a rate no operator can still see.
   *
   * The rebound job carries the SAME per-tick `active` predicate as a freshly registered one
   * (`dedicatedJob`, not a bare factory). Resolution happens once, at restore; a record cleared
   * AFTER that would otherwise leave a restored arm probing an environment the sweep has already
   * reclaimed — the double schedule this row exists to prevent, reintroduced through the boot path.
   */
  const resolveProbe = (id: string): ReturnType<typeof createHealthProbeJob> | null => {
    if (id === HEALTH_PROBE_JOB_ID) return healthProbe;
    const environment = healthProbeJobEnvironment(id);
    return environment !== null && dedicated().has(environment) && !retired().has(environment) ? dedicatedJob(environment) : null;
  };
  /**
   * The operator-facing read over the durable restore-proof records. It opens the SAME sidecar
   * the scheduled backup run writes - one shared suffix constant, so the writer and the reader
   * cannot come to disagree about which file the records live in - and it derives NOTHING: the
   * three states travel off the stored rows exactly as written.
   *
   * The project is bound HERE, never from a request: the rows are project-scoped and a
   * route-supplied project would let a caller read another project's backups. A store with no
   * durable path refuses as BACKUP_PROOF_STORE_UNAVAILABLE rather than answering an empty list,
   * which would read as "no backups exist" on a daemon that can see none of them.
   */
  const backupReads = (): BackupsReadPort => {
    const databasePath = store.getHealth().databasePath;
    const records = databasePath === null ? null
      : createBackupRestoreProofStore(
        `${databasePath}${BACKUP_RESTORE_PROOF_SIDECAR_SUFFIX}`, config.projectId,
      );
    return Object.freeze({
      read: () => records === null
        ? Object.freeze({
          code: "BACKUP_PROOF_STORE_UNAVAILABLE" as const,
          layer: "DAEMON_INGRESS" as const, ok: false as const,
        })
        : records.read(),
    });
  };
  const schedules = createDurableSchedule({ ...config.schedule, store, projectId: config.projectId, now: epochClock,
    // Reserved probe IDs never fall through to an external resolver that could re-arm retirement.
    // `release/auto-decide` is RESERVED TO NULL here, never delegated: the constructor rebuild runs
    // BEFORE the registration below re-arms it, and naming it here would need the deps that do not
    // exist yet. Delegating it would be worse than useless -- a host resolver that answers unknown
    // ids would bind THIS job to a foreign callback at rebuild, and `arm()` KEEPS the existing
    // callback when `register` arrives at the same interval (durable-schedule.ts:76-77), so the
    // reconciler would never run while the release schedule fired someone else's code. Reserving
    // makes rebuild drop the arm; the transient SCHEDULE_TARGET_UNRESOLVED notice is cleared by
    // `register`, which then owns the callback outright.
    resolve: (id) => id === HEALTH_PROBE_JOB_ID || healthProbeJobEnvironment(id) !== null
      ? resolveProbe(id)
      : id === RELEASE_AUTO_DECIDE_JOB_ID ? null : config.schedule?.resolve?.(id) ?? null });
  const close = (): void => { schedules.release(); subscriptionDatabase?.close(); store.close(); };
  /**
   * ORDER IS LOAD-BEARING, and getting it wrong is the defect DoD 3 names. The stored intervals are
   * read BEFORE any register call: `durable-schedule.ts:93` persists whenever the incoming interval
   * differs from the stored one, so registering first would write the default over an operator's
   * value and a read afterwards would only see the default it had just clobbered.
   *
   * The sweep is always registered, at the record's own default, so an environment that appears for
   * the first time between boots is still probed. Environments with a stored interval get their own
   * id at that value — re-persisting it unchanged, which `:93` then skips.
   */
  const sweep = schedules.register(HEALTH_PROBE_JOB_ID, healthProbe, DEFAULT_PROBE_INTERVAL_MS);
  if (!sweep.ok) { close(); throw new Error(`${sweep.code}@${sweep.layer}`); }
  // GATE 3 UNATTENDED. The SAME registry and the SAME dossier facts the release command holds, and
  // the SAME operator id boot reconciliation acts under -- a `daemon:*` id is refused 403 by the
  // release fence, so only this one passes. `MOE_RELEASE_BASE` is host config passed RAW; absent,
  // the reconciler releases nothing and the gate stays with a human.
  const autoRelease = registerReleaseAutoDecide(schedules, {
    base: process.env[RELEASE_BASE_ENV_KEY] ?? null, clock, dossierFacts: releaseDecide.dossierFacts,
    operatorPrincipalId: config.principalId, projectId: config.projectId, registry, store,
  });
  if (!autoRelease.ok) { close(); throw new Error(`${autoRelease.code}@${autoRelease.layer}`); }
  const boot = reconcileProbeSchedules();
  if (boot !== null) { close(); throw new Error(`${boot.code}@${boot.layer}`); }
  return Object.freeze({
    activation,
    activity,
    affordances,
    backupReads,
    budgetCommitment,
    close,
    commandAuthorityPlane,
    deploymentsHealth,
    designReads,
    documentCoverage,
    documentDossiers,
    documentIngest,
    environmentReads,
    graph,
    goalCatalog,
    goalSource,
    health,
    planningRuns,
    policy,
    previewCaptures,
    previewReads: () => createPreviewReadPort(store),
    // The SAME workspace and the SAME ancestry measurement `createProductionReleaseSeams` above
    // hands the decide edge. Resolving a second one here is how a card and the command it feeds
    // come to disagree about which landings are re-measurable at the release sha.
    releaseReads: () => createReleaseReadPort(
      store, createAncestryFactory(repositoryWorkspace === "" ? null : repositoryWorkspace),
    ),
    // The SAME instance the command registry above holds. Returned as a factory like every
    // other optional port, so the entry can sweep it from its already-async shutdown without
    // widening `close()` — which is SYNC and has six call sites outside this file.
    previews: (): PreviewDaemonPort => previewPort,
    productContractGate1,
    productContractPending,
    productContractV2Current,
    productContractV2Pending,
    provide,
    provideV2,
    reconciliation,
    schedules: (): DurableSchedule => schedules,
    repositoryRemote,
    repositoryWorkflows: workflows.repositoryWorkflows,
    releasePublisher: () => releaseDecide.publisher,
    runs,
    restore: () => createRestorePort(store, config.projectId),
    pairingOpenSessions,
    sessionChallengeOperands,
    sessions,
    sessionHandshake,
    sourceSnapshotPublisher: () => sourceSnapshotPublisher,
    subscriptions,
  });
}

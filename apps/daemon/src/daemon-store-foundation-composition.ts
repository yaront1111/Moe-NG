import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DurableStoreError } from "@moe/store";
import { readSubscriptionPage } from "@moe/store/subscriptions/subscription-read-page.js";
import {
  acknowledge, reseatToSnapshot,
} from "@moe/store/subscriptions/subscription-writes.js";
import { OPERATOR_CAPABILITIES, createDaemonCommandPorts } from "./daemon-command-registry.js";
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
import { createBoardProjectionService } from "./projections/board-projection-service.js";
import type { BoardProjectionService } from "./projections/board-projection-contracts.js";
import { readLatestDocumentWorkDossier } from "./documents/document-work-service.js";
import { createBootReconciliationPort } from "./recovery/boot-reconciliation.js";
import type { BootReconciliationPort } from "./recovery/boot-reconciliation.js";
import { readCurrentActiveGraph } from "./planning/active-graph-projection.js";
import type { GraphQueryPort } from "./planning/graph-query.js";
import { createRestorePort } from "./recovery/restore-controller-commands.js";
import type { RestorePort } from "./recovery/restore-controller-commands.js";
import { createAffordancePort } from "./http/affordance-read.js";
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

export interface StoreDependencyConfig {
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

function nodeSpecLoader(directory: string): () => readonly { nodeRef: string; title: string }[] {
  return () => {
    let entries: string[];
    try {
      entries = readdirSync(directory).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const specs: { nodeRef: string; title: string }[] = [];
    for (const name of entries.sort()) {
      try {
        const parsed = JSON.parse(readFileSync(join(directory, name), "utf8")) as {
          nodeRef?: unknown; title?: unknown;
        };
        if (typeof parsed.nodeRef === "string" && parsed.nodeRef.length > 0
          && typeof parsed.title === "string") {
          specs.push({ nodeRef: parsed.nodeRef, title: parsed.title });
        }
      } catch { /* skipped, never invented */ }
    }
    return specs;
  };
}

export type StoreDependencyProvider = DaemonDependencyProvider & {
  close(): void;
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
  const { decisions, registry } = createDaemonCommandPorts({
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
  const v2Ports = createDaemonV2CommandPorts({
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
    ? (): readonly { nodeRef: string; title: string }[] => []
    : nodeSpecLoader(config.nodeSpecsDir);
  const mergedNodes = (): readonly { nodeRef: string; title: string }[] => {
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

  return Object.freeze({
    affordances,
    budgetCommitment,
    close: (): void => { subscriptionDatabase?.close(); store.close(); },
    commandAuthorityPlane,
    documentDossiers,
    documentIngest,
    graph,
    goalCatalog,
    goalSource,
    planningRuns,
    productContractGate1,
    productContractPending,
    productContractV2Current,
    productContractV2Pending,
    provide,
    provideV2,
    reconciliation,
    restore: () => createRestorePort(store, config.projectId),
    pairingOpenSessions,
    sessionChallengeOperands,
    sessionHandshake,
    sourceSnapshotPublisher: () => sourceSnapshotPublisher,
    subscriptions,
  });
}

import type { BootReconciliationPort } from "./recovery/boot-reconciliation.js";
import type { CommandAuthorityPlanePort } from "./http/http-contract.js";
import type { AffordancePort } from "./http/affordance-contract.js";
import type { DocumentCoverageReadPort } from "./http/document-coverage-contract.js";
import type { RunsReadPort } from "./http/runs-read-contract.js";
import type { PolicyReadPort } from "./http/policy-read.js";
import type { ActivationReadPort } from "./http/activation-read.js";
import type { HealthReadPort } from "./http/health-read.js";
import type { ActivityReadPort } from "./http/activity-read.js";
import type { SessionsReadPort } from "./http/sessions-read.js";
import type { RepositoryRemoteReadPort } from "./http/repository-remote-read.js";
import type { RepositoryWorkflowReadPort } from "./http/repository-workflow-read.js";
import type { DocumentDossierReadPort } from "./http/document-dossier-read.js";
import type { DocumentIngestPort } from "./http/document-ingest-route.js";
import type { SubscriptionPort } from "./http/event-stream-contract.js";
import type { GoalCatalogReadPort } from "./http/goal-catalog-read.js";
import type { PlanningRunReadPort } from "./http/planning-run-read.js";
import type { BudgetCommitmentReadPort } from "./http/budget-commitment-read.js";
import type { ProductContractGate1ReadPort } from "./http/product-contract-gate-1-read.js";
import type { ProductContractPendingReadPort } from "./http/product-contract-pending-read.js";
import type {
  ProductContractV2CurrentReadPort,
} from "./http/product-contract-v2-current-read.js";
import type { ProductContractV2PendingReadPort }
  from "./http/product-contract-v2-pending-read.js";
import type {
  SessionChallengeOperandsReadPort,
} from "./http/session-challenge-operands-read.js";
import type { PairingOpenSessionPort } from "./http/pairing-open-completion.js";
import type { SessionHandshakePort } from "./identity/session-handshake.js";
import type { GoalSourceReadPort } from "./documents/document-source-full-read.js";
import type { DesignReadPort } from "./http/design-read.js";
import type { EnvironmentsReadPort } from "./http/environments-read.js";
import type { PreviewReadPort } from "./http/preview-read.js";
import type { ReleaseReadPort } from "./http/release-evidence-read.js";
import type { PreviewCapturePort } from "./http/preview-capture-route.js";
import type { GraphQueryPort } from "./planning/graph-query.js";

export interface OptionalDaemonPortProvider {
  /** Every port is optional; absence is surfaced by its listener route. */
  affordances?(): AffordancePort;
  documentDossiers?(): DocumentDossierReadPort;
  /** The operator document-ingest write port, bound to this daemon's own project. */
  documentIngest?(): DocumentIngestPort;
  /** The goal-scoped full-PRD reader, bound to this daemon's own project. */
  goalSource?(): GoalSourceReadPort;
  /**
   * The versioned design-aggregate reader. Bound to this daemon's store but NOT to a project:
   * the read takes its projectId from the authenticated principal, so a port that pre-bound one
   * would answer its own binding rather than fence the caller's.
   */
  designReads?(): DesignReadPort;
  /**
   * The per-environment variable-table reader. Bound to this daemon's own store AND project:
   * unlike the design read, the environment aggregate id is keyed by projectId inside the store
   * config, so the binding is the composition root's fact and never request input.
   */
  environmentReads?(): EnvironmentsReadPort;
  /** Durable preview receipts and captures from the runner's bound product workspace. */
  previewReads?(): PreviewReadPort;
  /** The goal's release evidence and the receipt of a decision taken on it. */
  releaseReads?(): ReleaseReadPort;
  previewCaptures?(): PreviewCapturePort;
  /** The current-active-graph reader, bound to this daemon's own project. */
  graph?(): GraphQueryPort;
  /** The strict durable GoalCreated catalog, bound to this daemon's own project. */
  goalCatalog?(): GoalCatalogReadPort;
  /** The PRD coverage read port, bound to this daemon own project. */
  documentCoverage?(): DocumentCoverageReadPort;
  /** The runs-and-leases read port, bound to this daemon own project. */
  runs?(): RunsReadPort;
  /** Installed policy and evaluations, bound to this daemon own project. */
  policy?(): PolicyReadPort;
  /** The six activation receipts, MEASURED per request, bound to this daemon own project. */
  activation?(): ActivationReadPort;
  /** The daemon process and ledger facts, bound to this daemon own project. */
  health?(): HealthReadPort;
  /** What the daemon decided, bound to this daemon own project. */
  activity?(): ActivityReadPort;
  /** Who holds a seat, bound to this daemon own project. */
  sessions?(): SessionsReadPort;
  /** The git remote the first publish bound, for this daemon own project. */
  repositoryRemote?(): RepositoryRemoteReadPort;
  repositoryWorkflows?(): RepositoryWorkflowReadPort;
  /** The pending-plan read port, bound to this daemon's own project. */
  planningRuns?(): PlanningRunReadPort;
  /** The budget commitment read port, bound to this daemon's own project. */
  budgetCommitment?(): BudgetCommitmentReadPort;
  /** The Product Contract Gate 1 read port, bound to this daemon's own project. */
  productContractGate1?(): ProductContractGate1ReadPort;
  /** The pending-contract read port (the Gate 1 card's read), same binding. */
  productContractPending?(): ProductContractPendingReadPort;
  /** The activated `/2` current-contract reader, bound to this daemon's project. */
  productContractV2Current?(): ProductContractV2CurrentReadPort;
  /** The activated `/2` Gate 1 card projection, bound to this daemon's project. */
  productContractV2Pending?(): ProductContractV2PendingReadPort;
  /**
   * The plane `/bootstrap` tells a browser to write to, read from the durable cutover
   * marker on every call. ABSENT means the listener answers V1, which is exactly what
   * `/command` serves on a daemon that composes no plane reader.
   */
  commandAuthorityPlane?(): CommandAuthorityPlanePort;
  /** The OPEN_SESSION challenge-operands read port, bound to this daemon's own project. */
  sessionChallengeOperands?(): SessionChallengeOperandsReadPort;
  /**
   * The session authority the pairing open-completion route composes. ABSENT means that
   * route refuses rather than answering: a daemon holding no authority must never look
   * like one that verified a possession proof.
   */
  pairingOpenSessions?(): PairingOpenSessionPort;
  /**
   * The restart reconciliation sweep. Absent only for a provider with no durable
   * store — the fixture provider has none, and a sweep it cannot run is not a
   * sweep it may skip: `createStoreDependencies` always wires this one.
   */
  reconciliation?(): BootReconciliationPort;
  /**
   * The approved-claim credential mint and the source of `/bootstrap`'s project
   * id. Absent only for a provider with no durable store, since a successful
   * claim opens a real session; `createStoreDependencies` always wires it.
   */
  sessionHandshake?(): SessionHandshakePort;
  subscriptions?(): SubscriptionPort;
}

export interface ResolvedOptionalDaemonPorts {
  readonly affordances?: AffordancePort;
  readonly documentCoverage?: DocumentCoverageReadPort;
  readonly runs?: RunsReadPort;
  readonly policy?: PolicyReadPort;
  readonly activation?: ActivationReadPort;
  readonly health?: HealthReadPort;
  readonly activity?: ActivityReadPort;
  readonly sessions?: SessionsReadPort;
  readonly repositoryRemote?: RepositoryRemoteReadPort;
  readonly repositoryWorkflows?: RepositoryWorkflowReadPort;
  readonly goalSource?: GoalSourceReadPort;
  readonly designReads?: DesignReadPort;
  readonly environmentReads?: EnvironmentsReadPort;
  readonly previewReads?: PreviewReadPort;
  readonly releaseReads?: ReleaseReadPort;
  readonly previewCaptures?: PreviewCapturePort;
  readonly documentDossiers?: DocumentDossierReadPort;
  readonly documentIngest?: DocumentIngestPort;
  readonly graph?: GraphQueryPort;
  readonly goalCatalog?: GoalCatalogReadPort;
  readonly planningRuns?: PlanningRunReadPort;
  readonly budgetCommitment?: BudgetCommitmentReadPort;
  readonly productContractGate1?: ProductContractGate1ReadPort;
  readonly productContractPending?: ProductContractPendingReadPort;
  readonly productContractV2Current?: ProductContractV2CurrentReadPort;
  readonly productContractV2Pending?: ProductContractV2PendingReadPort;
  readonly commandAuthorityPlane?: CommandAuthorityPlanePort;
  readonly sessionChallengeOperands?: SessionChallengeOperandsReadPort;
  readonly pairingOpenSessions?: PairingOpenSessionPort;
  readonly reconciliation?: BootReconciliationPort;
  readonly sessionHandshake?: SessionHandshakePort;
  readonly subscriptions?: SubscriptionPort;
}

export type OptionalDaemonPortResolution =
  | { readonly failure: "INVALID" | "THREW"; readonly ok: false }
  | { readonly ok: true; readonly ports: ResolvedOptionalDaemonPorts };

const FACTORIES = Object.freeze([
  "subscriptions", "affordances", "budgetCommitment", "documentCoverage", "documentDossiers",
  "documentIngest",
  "graph", "goalCatalog",
  "planningRuns", "productContractGate1", "productContractPending",
  "productContractV2Current", "productContractV2Pending", "commandAuthorityPlane",
  "sessionChallengeOperands", "pairingOpenSessions",
  "reconciliation", "runs", "policy", "activation", "health", "activity", "sessions", "repositoryRemote", "repositoryWorkflows", "goalSource",
  "designReads",
  "environmentReads",
  "previewReads", "previewCaptures", "releaseReads",
  "sessionHandshake",
] as const);

function hasMethods(value: unknown, keys: readonly string[]): boolean {
  if (typeof value !== "object" || value === null) return false;
  try {
    return keys.every((key) => typeof Reflect.get(value, key) === "function");
  } catch {
    return false;
  }
}

/** Structural startup validation for module-loaded providers. */
export function optionalPortFactoriesAreValid(value: object): boolean {
  return FACTORIES.every((key) => {
    const candidate = Reflect.get(value, key) as unknown;
    return candidate === undefined || typeof candidate === "function";
  });
}

/** Calls each optional factory once and refuses a malformed or throwing port. */
export function resolveOptionalDaemonPorts(
  provider: OptionalDaemonPortProvider,
): OptionalDaemonPortResolution {
  try {
    const subscriptionFactory = provider.subscriptions;
    if (subscriptionFactory !== undefined && typeof subscriptionFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const subscriptions = subscriptionFactory?.call(provider);
    if (subscriptions !== undefined
      && !hasMethods(subscriptions, ["acknowledge", "readPage", "reseat"])) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const affordanceFactory = provider.affordances;
    if (affordanceFactory !== undefined && typeof affordanceFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const affordances = affordanceFactory?.call(provider);
    if (affordances !== undefined && !hasMethods(affordances, ["readSurface"])) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const dossierFactory = provider.documentDossiers;
    if (dossierFactory !== undefined && typeof dossierFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const documentDossiers = dossierFactory?.call(provider);
    if (documentDossiers !== undefined && !hasMethods(documentDossiers, ["readLatest"])) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const ingestFactory = provider.documentIngest;
    if (ingestFactory !== undefined && typeof ingestFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const documentIngest = ingestFactory?.call(provider);
    if (documentIngest !== undefined && !hasMethods(documentIngest, ["ingest"])) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const graphFactory = provider.graph;
    if (graphFactory !== undefined && typeof graphFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const graph = graphFactory?.call(provider);
    if (graph !== undefined && !hasMethods(graph, ["readCurrentActiveGraph"])) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const goalCatalogFactory = provider.goalCatalog;
    if (goalCatalogFactory !== undefined && typeof goalCatalogFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const goalCatalog = goalCatalogFactory?.call(provider);
    if (goalCatalog !== undefined && !hasMethods(goalCatalog, ["readGoals"])) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const planningRunFactory = provider.planningRuns;
    if (planningRunFactory !== undefined && typeof planningRunFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const planningRuns = planningRunFactory?.call(provider);
    if (planningRuns !== undefined && !hasMethods(planningRuns, ["readPlanningRun"])) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const budgetFactory = provider.budgetCommitment;
    if (budgetFactory !== undefined && typeof budgetFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const budgetCommitment = budgetFactory?.call(provider);
    if (budgetCommitment !== undefined
      && !hasMethods(budgetCommitment, ["readCommitment"])) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const gate1Factory = provider.productContractGate1;
    if (gate1Factory !== undefined && typeof gate1Factory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const productContractGate1 = gate1Factory?.call(provider);
    if (productContractGate1 !== undefined
      && !hasMethods(productContractGate1, ["readGate"])) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const coverageFactory = provider.documentCoverage;
    if (coverageFactory !== undefined && typeof coverageFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const documentCoverage = coverageFactory?.call(provider);
    if (documentCoverage !== undefined
      && (!hasMethods(documentCoverage, ["readCoverage"])
        || typeof Reflect.get(documentCoverage, "boundProjectId") !== "string")) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const runsFactory = provider.runs;
    if (runsFactory !== undefined && typeof runsFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const runs = runsFactory?.call(provider);
    if (runs !== undefined
      && (!hasMethods(runs, ["readRuns"]) || typeof Reflect.get(runs, "boundProjectId") !== "string")) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const policyFactory = provider.policy;
    if (policyFactory !== undefined && typeof policyFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const policy = policyFactory?.call(provider);
    if (policy !== undefined
      && (!hasMethods(policy, ["readPolicy"]) || typeof Reflect.get(policy, "boundProjectId") !== "string")) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const activationFactory = provider.activation;
    if (activationFactory !== undefined && typeof activationFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    // `boundProjectId` is load-bearing, not decoration: the handler refuses
    // ACTIVATION_READ_PROJECT_MISMATCH by comparing it to the authenticated principal.
    const activation = activationFactory?.call(provider);
    if (activation !== undefined
      && (!hasMethods(activation, ["readActivation"])
        || typeof Reflect.get(activation, "boundProjectId") !== "string")) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const healthFactory = provider.health;
    if (healthFactory !== undefined && typeof healthFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const health = healthFactory?.call(provider);
    if (health !== undefined
      && (!hasMethods(health, ["readHealth"]) || typeof Reflect.get(health, "boundProjectId") !== "string")) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const activityFactory = provider.activity;
    if (activityFactory !== undefined && typeof activityFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const activity = activityFactory?.call(provider);
    if (activity !== undefined
      && (!hasMethods(activity, ["readActivity"]) || typeof Reflect.get(activity, "boundProjectId") !== "string")) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const sessionsFactory = provider.sessions;
    if (sessionsFactory !== undefined && typeof sessionsFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const sessions = sessionsFactory?.call(provider);
    if (sessions !== undefined
      && (!hasMethods(sessions, ["readSessions"]) || typeof Reflect.get(sessions, "boundProjectId") !== "string")) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const remoteFactory = provider.repositoryRemote;
    const workflowFactory = provider.repositoryWorkflows;
    if (workflowFactory !== undefined && typeof workflowFactory !== "function") return Object.freeze({ failure: "INVALID", ok: false } as const);
    const repositoryWorkflows = workflowFactory?.call(provider);
    if (repositoryWorkflows !== undefined && (!hasMethods(repositoryWorkflows, ["readCriteria", "readRecovery"])
      || typeof Reflect.get(repositoryWorkflows, "boundProjectId") !== "string")) return Object.freeze({ failure: "INVALID", ok: false } as const);
    if (remoteFactory !== undefined && typeof remoteFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const repositoryRemote = remoteFactory?.call(provider);
    if (repositoryRemote !== undefined
      && (!hasMethods(repositoryRemote, ["readRemote"]) || typeof Reflect.get(repositoryRemote, "boundProjectId") !== "string")) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const goalSourceFactory = provider.goalSource;
    if (goalSourceFactory !== undefined && typeof goalSourceFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const goalSource = goalSourceFactory?.call(provider);
    if (goalSource !== undefined && !hasMethods(goalSource, ["read"])) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const designReadsFactory = provider.designReads;
    if (designReadsFactory !== undefined && typeof designReadsFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const designReads = designReadsFactory?.call(provider);
    if (designReads !== undefined && !hasMethods(designReads, ["read"])) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const environmentReadsFactory = provider.environmentReads;
    if (environmentReadsFactory !== undefined && typeof environmentReadsFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const environmentReads = environmentReadsFactory?.call(provider);
    if (environmentReads !== undefined && !hasMethods(environmentReads, ["read"])) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const previewReadsFactory = provider.previewReads;
    if (previewReadsFactory !== undefined && typeof previewReadsFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const previewReads = previewReadsFactory?.call(provider);
    if (previewReads !== undefined && !hasMethods(previewReads, ["read"])) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const releaseReadsFactory = provider.releaseReads;
    if (releaseReadsFactory !== undefined && typeof releaseReadsFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const releaseReads = releaseReadsFactory?.call(provider);
    if (releaseReads !== undefined && !hasMethods(releaseReads, ["read"])) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const previewCapturesFactory = provider.previewCaptures;
    if (previewCapturesFactory !== undefined && typeof previewCapturesFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const previewCaptures = previewCapturesFactory?.call(provider);
    if (previewCaptures !== undefined && !hasMethods(previewCaptures, ["projectDirectory"])) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const pendingFactory = provider.productContractPending;
    if (pendingFactory !== undefined && typeof pendingFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const productContractPending = pendingFactory?.call(provider);
    if (productContractPending !== undefined
      && !hasMethods(productContractPending, ["readPending"])) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const currentV2Factory = provider.productContractV2Current;
    if (currentV2Factory !== undefined && typeof currentV2Factory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const productContractV2Current = currentV2Factory?.call(provider);
    if (productContractV2Current !== undefined
      && (!hasMethods(productContractV2Current, ["readCurrent"])
        || typeof Reflect.get(productContractV2Current, "boundProjectId") !== "string"
        || (Reflect.get(productContractV2Current, "boundProjectId") as string).trim().length === 0)) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const pendingV2Factory = provider.productContractV2Pending;
    if (pendingV2Factory !== undefined && typeof pendingV2Factory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const productContractV2Pending = pendingV2Factory?.call(provider);
    if (productContractV2Pending !== undefined
      && (!hasMethods(productContractV2Pending, ["readPending"])
        || typeof Reflect.get(productContractV2Pending, "boundProjectId") !== "string"
        || (Reflect.get(productContractV2Pending, "boundProjectId") as string).trim().length === 0)) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const planeFactory = provider.commandAuthorityPlane;
    if (planeFactory !== undefined && typeof planeFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const commandAuthorityPlane = planeFactory?.call(provider);
    if (commandAuthorityPlane !== undefined
      && (!hasMethods(commandAuthorityPlane, ["readPlane"])
        || typeof Reflect.get(commandAuthorityPlane, "boundProjectId") !== "string"
        || (Reflect.get(commandAuthorityPlane, "boundProjectId") as string).trim().length === 0)) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const operandsFactory = provider.sessionChallengeOperands;
    if (operandsFactory !== undefined && typeof operandsFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const sessionChallengeOperands = operandsFactory?.call(provider);
    if (sessionChallengeOperands !== undefined
      && !hasMethods(sessionChallengeOperands, ["readOperands"])) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const openSessionsFactory = provider.pairingOpenSessions;
    if (openSessionsFactory !== undefined && typeof openSessionsFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const pairingOpenSessions = openSessionsFactory?.call(provider);
    if (pairingOpenSessions !== undefined
      && !hasMethods(pairingOpenSessions, ["openSession"])) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const reconciliationFactory = provider.reconciliation;
    if (reconciliationFactory !== undefined && typeof reconciliationFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const reconciliation = reconciliationFactory?.call(provider);
    if (reconciliation !== undefined && !hasMethods(reconciliation, ["sweep"])) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const handshakeFactory = provider.sessionHandshake;
    if (handshakeFactory !== undefined && typeof handshakeFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const sessionHandshake = handshakeFactory?.call(provider);
    if (sessionHandshake !== undefined && !hasMethods(sessionHandshake, ["mint"])) {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    if (sessionHandshake !== undefined) {
      const boundProjectId = Reflect.get(sessionHandshake, "boundProjectId") as unknown;
      if (typeof boundProjectId !== "string" || boundProjectId.trim().length === 0) {
        return Object.freeze({ failure: "INVALID", ok: false } as const);
      }
    }
    const ports = Object.freeze({
      ...(affordances === undefined ? {} : { affordances }),
      ...(documentCoverage === undefined ? {} : { documentCoverage }),
      ...(runs === undefined ? {} : { runs }),
      ...(policy === undefined ? {} : { policy }),
      ...(activation === undefined ? {} : { activation }),
      ...(health === undefined ? {} : { health }),
      ...(activity === undefined ? {} : { activity }),
      ...(sessions === undefined ? {} : { sessions }),
      ...(repositoryRemote === undefined ? {} : { repositoryRemote }),
      ...(repositoryWorkflows === undefined ? {} : { repositoryWorkflows }),
      ...(goalSource === undefined ? {} : { goalSource }),
      ...(designReads === undefined ? {} : { designReads }),
      ...(environmentReads === undefined ? {} : { environmentReads }),
      ...(previewReads === undefined ? {} : { previewReads }),
      ...(releaseReads === undefined ? {} : { releaseReads }),
      ...(previewCaptures === undefined ? {} : { previewCaptures }),
      ...(documentDossiers === undefined ? {} : { documentDossiers }),
      ...(documentIngest === undefined ? {} : { documentIngest }),
      ...(graph === undefined ? {} : { graph }),
      ...(goalCatalog === undefined ? {} : { goalCatalog }),
      ...(planningRuns === undefined ? {} : { planningRuns }),
      ...(budgetCommitment === undefined ? {} : { budgetCommitment }),
      ...(productContractGate1 === undefined ? {} : { productContractGate1 }),
      ...(productContractPending === undefined ? {} : { productContractPending }),
      ...(productContractV2Current === undefined ? {} : { productContractV2Current }),
      ...(productContractV2Pending === undefined ? {} : { productContractV2Pending }),
      ...(commandAuthorityPlane === undefined ? {} : { commandAuthorityPlane }),
      ...(sessionChallengeOperands === undefined ? {} : { sessionChallengeOperands }),
      ...(pairingOpenSessions === undefined ? {} : { pairingOpenSessions }),
      ...(reconciliation === undefined ? {} : { reconciliation }),
      ...(sessionHandshake === undefined ? {} : { sessionHandshake }),
      ...(subscriptions === undefined ? {} : { subscriptions }),
    });
    return Object.freeze({ ok: true, ports } as const);
  } catch {
    return Object.freeze({ failure: "THREW", ok: false } as const);
  }
}

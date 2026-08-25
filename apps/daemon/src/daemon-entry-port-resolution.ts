import type { BootReconciliationPort } from "./recovery/boot-reconciliation.js";
import type { AffordancePort } from "./http/affordance-contract.js";
import type { DocumentDossierReadPort } from "./http/document-dossier-read.js";
import type { DocumentIngestPort } from "./http/document-ingest-route.js";
import type { SubscriptionPort } from "./http/event-stream-contract.js";
import type { GoalCatalogReadPort } from "./http/goal-catalog-read.js";
import type { PlanningRunReadPort } from "./http/planning-run-read.js";
import type { SessionHandshakePort } from "./identity/session-handshake.js";
import type { GraphQueryPort } from "./planning/graph-query.js";

export interface OptionalDaemonPortProvider {
  /** Every port is optional; absence is surfaced by its listener route. */
  affordances?(): AffordancePort;
  documentDossiers?(): DocumentDossierReadPort;
  /** The operator document-ingest write port, bound to this daemon's own project. */
  documentIngest?(): DocumentIngestPort;
  /** The current-active-graph reader, bound to this daemon's own project. */
  graph?(): GraphQueryPort;
  /** The strict durable GoalCreated catalog, bound to this daemon's own project. */
  goalCatalog?(): GoalCatalogReadPort;
  /** The pending-plan read port, bound to this daemon's own project. */
  planningRuns?(): PlanningRunReadPort;
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
  readonly documentDossiers?: DocumentDossierReadPort;
  readonly documentIngest?: DocumentIngestPort;
  readonly graph?: GraphQueryPort;
  readonly goalCatalog?: GoalCatalogReadPort;
  readonly planningRuns?: PlanningRunReadPort;
  readonly reconciliation?: BootReconciliationPort;
  readonly sessionHandshake?: SessionHandshakePort;
  readonly subscriptions?: SubscriptionPort;
}

export type OptionalDaemonPortResolution =
  | { readonly failure: "INVALID" | "THREW"; readonly ok: false }
  | { readonly ok: true; readonly ports: ResolvedOptionalDaemonPorts };

const FACTORIES = Object.freeze([
  "subscriptions", "affordances", "documentDossiers", "documentIngest", "graph", "goalCatalog",
  "planningRuns", "reconciliation", "sessionHandshake",
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
      ...(documentDossiers === undefined ? {} : { documentDossiers }),
      ...(documentIngest === undefined ? {} : { documentIngest }),
      ...(graph === undefined ? {} : { graph }),
      ...(goalCatalog === undefined ? {} : { goalCatalog }),
      ...(planningRuns === undefined ? {} : { planningRuns }),
      ...(reconciliation === undefined ? {} : { reconciliation }),
      ...(sessionHandshake === undefined ? {} : { sessionHandshake }),
      ...(subscriptions === undefined ? {} : { subscriptions }),
    });
    return Object.freeze({ ok: true, ports } as const);
  } catch {
    return Object.freeze({ failure: "THREW", ok: false } as const);
  }
}

import type { BootReconciliationPort } from "./recovery/boot-reconciliation.js";
import type { AffordancePort } from "./http/affordance-contract.js";
import type { DocumentDossierReadPort } from "./http/document-dossier-read.js";
import type { SubscriptionPort } from "./http/event-stream-contract.js";
import type { GraphQueryPort } from "./planning/graph-query.js";

export interface OptionalDaemonPortProvider {
  /** Every port is optional; absence is surfaced by its listener route. */
  affordances?(): AffordancePort;
  documentDossiers?(): DocumentDossierReadPort;
  /** The current-active-graph reader, bound to this daemon's own project. */
  graph?(): GraphQueryPort;
  /**
   * The restart reconciliation sweep. Absent only for a provider with no durable
   * store — the fixture provider has none, and a sweep it cannot run is not a
   * sweep it may skip: `createStoreDependencies` always wires this one.
   */
  reconciliation?(): BootReconciliationPort;
  subscriptions?(): SubscriptionPort;
}

export interface ResolvedOptionalDaemonPorts {
  readonly affordances?: AffordancePort;
  readonly documentDossiers?: DocumentDossierReadPort;
  readonly graph?: GraphQueryPort;
  readonly reconciliation?: BootReconciliationPort;
  readonly subscriptions?: SubscriptionPort;
}

export type OptionalDaemonPortResolution =
  | { readonly failure: "INVALID" | "THREW"; readonly ok: false }
  | { readonly ok: true; readonly ports: ResolvedOptionalDaemonPorts };

const FACTORIES = Object.freeze([
  "subscriptions", "affordances", "documentDossiers", "graph", "reconciliation",
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
    const graphFactory = provider.graph;
    if (graphFactory !== undefined && typeof graphFactory !== "function") {
      return Object.freeze({ failure: "INVALID", ok: false } as const);
    }
    const graph = graphFactory?.call(provider);
    if (graph !== undefined && !hasMethods(graph, ["readCurrentActiveGraph"])) {
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
    const ports = Object.freeze({
      ...(affordances === undefined ? {} : { affordances }),
      ...(documentDossiers === undefined ? {} : { documentDossiers }),
      ...(graph === undefined ? {} : { graph }),
      ...(reconciliation === undefined ? {} : { reconciliation }),
      ...(subscriptions === undefined ? {} : { subscriptions }),
    });
    return Object.freeze({ ok: true, ports } as const);
  } catch {
    return Object.freeze({ failure: "THREW", ok: false } as const);
  }
}

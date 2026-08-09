import type { AffordancePort } from "./http/affordance-contract.js";
import type { DocumentDossierReadPort } from "./http/document-dossier-read.js";
import type { SubscriptionPort } from "./http/event-stream-contract.js";

export interface OptionalDaemonPortProvider {
  /** Every port is optional; absence is surfaced by its listener route. */
  affordances?(): AffordancePort;
  documentDossiers?(): DocumentDossierReadPort;
  subscriptions?(): SubscriptionPort;
}

export interface ResolvedOptionalDaemonPorts {
  readonly affordances?: AffordancePort;
  readonly documentDossiers?: DocumentDossierReadPort;
  readonly subscriptions?: SubscriptionPort;
}

const FACTORIES = Object.freeze([
  "affordances", "documentDossiers", "subscriptions",
] as const);

function hasMethods(value: unknown, keys: readonly string[]): boolean {
  if (typeof value !== "object" || value === null) return false;
  return keys.every((key) => typeof Reflect.get(value, key) === "function");
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
): ResolvedOptionalDaemonPorts | null {
  try {
    const affordances = provider.affordances?.call(provider);
    const documentDossiers = provider.documentDossiers?.call(provider);
    const subscriptions = provider.subscriptions?.call(provider);
    if (affordances !== undefined && !hasMethods(affordances, ["readSurface"])) return null;
    if (documentDossiers !== undefined && !hasMethods(documentDossiers, ["readLatest"])) return null;
    if (subscriptions !== undefined && !hasMethods(subscriptions, ["readPage", "reseat"])) return null;
    return Object.freeze({
      ...(affordances === undefined ? {} : { affordances }),
      ...(documentDossiers === undefined ? {} : { documentDossiers }),
      ...(subscriptions === undefined ? {} : { subscriptions }),
    });
  } catch {
    return null;
  }
}

import type { StoredEvent } from "../store-contracts.js";

/**
 * Pure stored-event schema dispatch: routes an event from its recorded opaque
 * domainSchemaVersion to the declared current version through exact registered
 * hops, replacing only payload and metadata bytes. Wire-up defects throw once at
 * compile time; per-event outcomes are returned as frozen evidence so a caller
 * can quarantine one event without a try/catch per event. A failure's
 * `fromVersion` is the version the upcast stalled at. Versions are opaque: no
 * numeric or lexical ordering is ever inferred.
 */

export interface UpcastPatch { readonly metadata: Uint8Array; readonly payload: Uint8Array; }
export type UpcastHandler = (input: UpcastPatch) => UpcastPatch;
export interface UpcastRoute {
  readonly fromVersion: string; readonly handler: UpcastHandler; readonly toVersion: string;
}
export interface UpcastDefinition {
  readonly currentVersion: string; readonly eventType: string;
  readonly routes: readonly UpcastRoute[];
}
export type UpcastDefinitionCode =
  | "UPCAST_DUPLICATE_DISPATCH_KEY" | "UPCAST_DUPLICATE_EVENT_TYPE" | "UPCAST_ROUTE_CYCLE"
  | "UPCAST_ROUTE_DEAD_END" | "UPCAST_SELF_LOOP";
export type UpcastFailureCode =
  | "SCHEMA_VERSION_UNSUPPORTED" | "UPCAST_HANDLER_FAILED" | "UPCAST_OUTPUT_INVALID";
export interface UpcastFailure {
  readonly code: UpcastFailureCode; readonly currentVersion: string | null;
  readonly eventId: string; readonly eventType: string; readonly fromVersion: string;
}
export type UpcastOutcome =
  | { readonly event: StoredEvent; readonly ok: true }
  | { readonly failure: UpcastFailure; readonly ok: false };
export interface StoredEventUpcaster { upcast(event: StoredEvent): UpcastOutcome; }

export class UpcastDefinitionError extends Error {
  public readonly code: UpcastDefinitionCode;

  public constructor(code: UpcastDefinitionCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "UpcastDefinitionError";
    this.code = code;
  }
}

interface CompiledHop { readonly handler: UpcastHandler; readonly toVersion: string; }
type Routes = ReadonlyMap<string, CompiledHop>;
interface CompiledDefinition { readonly currentVersion: string; readonly routes: Routes; }
type Compiled = ReadonlyMap<string, CompiledDefinition>;
type OutputCheck = UpcastPatch | "UPCAST_HANDLER_FAILED" | "UPCAST_OUTPUT_INVALID";

function defect(code: UpcastDefinitionCode, detail: string): UpcastDefinitionError {
  return new UpcastDefinitionError(code, detail);
}

/** One outgoing hop per fromVersion makes reachability decidable here: walk each
 *  registered version to the current version, or prove a cycle or a dead end. */
function assertReachesCurrent(eventType: string, currentVersion: string, routes: Routes): void {
  for (const start of routes.keys()) {
    const visited = new Set<string>([start]);
    let version = start;
    while (version !== currentVersion) {
      const hop = routes.get(version);
      if (hop === undefined) {
        throw defect("UPCAST_ROUTE_DEAD_END", `${eventType} from ${start} stops at ${version}`);
      }
      if (visited.has(hop.toVersion)) {
        throw defect("UPCAST_ROUTE_CYCLE", `${eventType} from ${start} revisits ${hop.toVersion}`);
      }
      visited.add(hop.toVersion);
      version = hop.toVersion;
    }
  }
}

function compileDefinition(definition: UpcastDefinition): CompiledDefinition {
  const { currentVersion, eventType } = definition;
  const routes = new Map<string, CompiledHop>();
  for (const { fromVersion, handler, toVersion } of definition.routes) {
    if (fromVersion === toVersion) {
      throw defect("UPCAST_SELF_LOOP", `${eventType} routes ${fromVersion} to itself`);
    }
    if (routes.has(fromVersion)) {
      throw defect("UPCAST_DUPLICATE_DISPATCH_KEY", `${eventType} repeats ${fromVersion}`);
    }
    routes.set(fromVersion, { handler, toVersion });
  }
  assertReachesCurrent(eventType, currentVersion, routes);
  return { currentVersion, routes };
}

function refuse(
  code: UpcastFailureCode, event: StoredEvent, fromVersion: string, currentVersion: string | null,
): UpcastOutcome {
  const { eventId, eventType } = event;
  const failure = Object.freeze({ code, currentVersion, eventId, eventType, fromVersion });
  return Object.freeze({ failure, ok: false as const });
}

/** Thenable is tested before shape, so a returned promise is a failed handler, not
 *  malformed output; the `then` probe reads through the prototype chain because a
 *  real promise has no OWN `then`. Call inside a try: a hostile getter can throw. */
function checkOutput(value: unknown): OutputCheck {
  const isObject = typeof value === "object" && value !== null;
  const couldThen = isObject || typeof value === "function";
  if (couldThen && typeof (value as { then?: unknown }).then === "function") {
    return "UPCAST_HANDLER_FAILED";
  }
  if (!isObject) {
    return "UPCAST_OUTPUT_INVALID";
  }
  const keys = Reflect.ownKeys(value);
  const { metadata, payload } = value as Partial<UpcastPatch>;
  if (keys.length !== 2 || !keys.includes("metadata") || !keys.includes("payload") ||
      !(metadata instanceof Uint8Array) || !(payload instanceof Uint8Array)) {
    return "UPCAST_OUTPUT_INVALID";
  }
  return { metadata, payload };
}

function dispatch(compiled: Compiled, event: StoredEvent): UpcastOutcome {
  const definition = compiled.get(event.eventType);
  if (definition === undefined) {
    return refuse("SCHEMA_VERSION_UNSUPPORTED", event, event.domainSchemaVersion, null);
  }
  const { currentVersion, routes } = definition;
  let version = event.domainSchemaVersion;
  let metadata = new Uint8Array(event.metadata);
  let payload = new Uint8Array(event.payload);
  while (version !== currentVersion) {
    const hop = routes.get(version);
    if (hop === undefined) {
      return refuse("SCHEMA_VERSION_UNSUPPORTED", event, version, currentVersion);
    }
    let checked: OutputCheck;
    try {
      checked = checkOutput(hop.handler({ metadata, payload }));
    } catch {
      return refuse("UPCAST_HANDLER_FAILED", event, version, currentVersion);
    }
    if (typeof checked === "string") {
      return refuse(checked, event, version, currentVersion);
    }
    metadata = new Uint8Array(checked.metadata);
    payload = new Uint8Array(checked.payload);
    version = hop.toVersion;
  }
  const upcast = { ...event, domainSchemaVersion: currentVersion, metadata, payload };
  return Object.freeze({ event: Object.freeze(upcast), ok: true as const });
}

/** Compiles once; the caller's arrays are copied into internal maps, so mutating
 *  them afterwards cannot change dispatch or reintroduce a cycle. */
export function compileStoredEventUpcaster(
  definitions: readonly UpcastDefinition[],
): StoredEventUpcaster {
  const compiled = new Map<string, CompiledDefinition>();
  for (const definition of definitions) {
    if (compiled.has(definition.eventType)) {
      throw defect("UPCAST_DUPLICATE_EVENT_TYPE", `${definition.eventType} is defined twice`);
    }
    compiled.set(definition.eventType, compileDefinition(definition));
  }
  return { upcast: (event) => dispatch(compiled, event) };
}

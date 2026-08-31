import { exact } from "../planning/planning-snapshot.js";
import {
  CAPABILITY_CATALOG_LIMITS,
  CAPABILITY_CATALOG_RESOURCE_KINDS,
  capabilityCatalogRefusal,
  type CapabilityCatalogRefusal,
  type CapabilityCatalogResourceKind,
  type CapabilityCatalogResourceScope,
} from "./capability-catalog-contract.js";
import {
  readCapabilityCatalogText,
  type CapabilityCatalogReadResult,
} from "./capability-catalog-value-readers.js";

const RESOURCE_KEYS = Object.freeze(["kind", "ref"]);
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.@+~-]*$/u;
const SAFE_RESOURCE_REF = /^[A-Za-z0-9_][A-Za-z0-9_.:@+~-]*$/u;

const scopeInvalid = (): CapabilityCatalogRefusal => capabilityCatalogRefusal(
  "CAPABILITY_CATALOG_SCOPE_INVALID", "CAPABILITY_CATALOG_SCOPES",
);
const resourceInvalid = (): CapabilityCatalogRefusal => capabilityCatalogRefusal(
  "CAPABILITY_CATALOG_RESOURCE_SCOPE_INVALID", "CAPABILITY_CATALOG_RESOURCES",
);
const limitExceeded = (): CapabilityCatalogRefusal => capabilityCatalogRefusal(
  "CAPABILITY_CATALOG_LIMIT_EXCEEDED", "CAPABILITY_CATALOG_LIMITS",
);

function canonicalRepositoryPath(path: string): boolean {
  if (path.startsWith("/") || path.startsWith("\\") || path.includes("\\")
    || /^[A-Za-z]:/u.test(path)) return false;
  const segments = path.split("/");
  return segments.length > 0 && segments.every(
    (segment) => segment !== "." && segment !== ".." && SAFE_PATH_SEGMENT.test(segment),
  );
}

export function readCapabilityCatalogPathScopes(
  value: unknown,
): CapabilityCatalogReadResult<readonly string[]> {
  if (!Array.isArray(value)) return scopeInvalid();
  if (value.length > CAPABILITY_CATALOG_LIMITS.maxScopesPerKind) return limitExceeded();
  const scopes: string[] = [];
  for (const candidate of value) {
    const scope = readCapabilityCatalogText(
      candidate, "CAPABILITY_CATALOG_SCOPES", CAPABILITY_CATALOG_LIMITS.maxScopeBytes,
    );
    if (!scope.ok) return scope;
    if (!canonicalRepositoryPath(scope.value)
      || (scopes.at(-1) !== undefined && scopes.at(-1)! >= scope.value)) {
      return scopeInvalid();
    }
    scopes.push(scope.value);
  }
  return Object.freeze({ ok: true as const, value: Object.freeze(scopes) });
}

function readResourceScope(
  value: unknown,
): CapabilityCatalogReadResult<CapabilityCatalogResourceScope> {
  if (!exact(value, RESOURCE_KEYS)
    || !CAPABILITY_CATALOG_RESOURCE_KINDS.some((kind) => kind === value["kind"])) {
    return resourceInvalid();
  }
  const ref = readCapabilityCatalogText(
    value["ref"], "CAPABILITY_CATALOG_REFERENCES",
    CAPABILITY_CATALOG_LIMITS.maxResourceRefBytes,
  );
  if (!ref.ok) {
    return ref.code === "CAPABILITY_CATALOG_LIMIT_EXCEEDED" ? ref : resourceInvalid();
  }
  if (!SAFE_RESOURCE_REF.test(ref.value) || ref.value === "." || ref.value === ".."
    || /^[A-Za-z]:/u.test(ref.value)) return resourceInvalid();
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      kind: value["kind"] as CapabilityCatalogResourceKind,
      ref: ref.value,
    }),
  });
}

export function readCapabilityCatalogResourceScopes(
  value: unknown,
): CapabilityCatalogReadResult<readonly CapabilityCatalogResourceScope[]> {
  if (!Array.isArray(value)) return resourceInvalid();
  if (value.length > CAPABILITY_CATALOG_LIMITS.maxScopesPerKind) return limitExceeded();
  const scopes: CapabilityCatalogResourceScope[] = [];
  for (const candidate of value) {
    const scope = readResourceScope(candidate);
    if (!scope.ok) return scope;
    const key = `${scope.value.kind}\0${scope.value.ref}`;
    const previous = scopes.at(-1);
    if (previous !== undefined && `${previous.kind}\0${previous.ref}` >= key) {
      return resourceInvalid();
    }
    scopes.push(scope.value);
  }
  return Object.freeze({ ok: true as const, value: Object.freeze(scopes) });
}

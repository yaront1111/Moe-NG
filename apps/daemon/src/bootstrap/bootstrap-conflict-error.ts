import {
  EMPTY_NEXT_ALLOWED_COMMANDS,
  RUNTIME_ERROR_REGISTRY_VERSION,
  decodeBoundedJsonBytes,
  lookupRuntimeError,
} from "@moe/contracts";
import type { JsonValue, RuntimeError } from "@moe/contracts";
import type { CommandDecisionRecord } from "@moe/store";

/**
 * The ONE decode of a store expected-version conflict, shared by every commit seam that can
 * receive one (bootstrap and work-claim today). A caller that is told only "conflict" has
 * nothing to retry at, so the refusal must NAME the version the store observed.
 *
 * The numbers are DECODED from the store's own `resultBytes`
 * (packages/store/src/store-digests.ts `expectedVersionConflictResultBytes`), never recomputed
 * here: a daemon-computed version would authenticate nothing — it would just echo what the
 * caller already believed, which is precisely the value that was wrong.
 */

const CONFLICT_CODE = "EXPECTED_VERSION_CONFLICT";

/**
 * `createRuntimeError` cannot build this one. Its `sourceAccepted` gate fails CLOSED to
 * `UNKNOWN_ERROR` with empty details unless the caller supplies a lifecycle `source`, and the
 * registry row declares five valid sources. A commit seam has read no aggregate STATE at the
 * point the store reports the conflict — and a work-claim aggregate (`work/<id>`) is not a
 * runtime aggregate at all — so naming a source would invent daemon truth. The row is therefore
 * projected VERBATIM, exactly as `http-command-ingress.ts` does for `DISTRIBUTION_MISMATCH`:
 * every field except the decoded details comes from the registry, so nothing here can drift.
 */
const CONFLICT_ROW = lookupRuntimeError(CONFLICT_CODE);

/**
 * Mirrors the factory's own `safeScalar` bound: only a safe integer becomes a detail value.
 * Anything else — a float, a string, a nested object, `NaN` — is not a version, and inventing
 * one from it would be worse than saying nothing.
 */
function versionOf(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function objectOf(value: JsonValue): Readonly<Record<string, JsonValue>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Readonly<Record<string, JsonValue>>;
}

/**
 * Returns the conflict error a refusal should carry, or `null` when the decision is not a
 * conflict or its bytes do not carry two usable versions. `null` keeps the refusal at the bare
 * code — the caller learns less, but is never told a version the store did not report.
 */
export function conflictError(decision: CommandDecisionRecord): RuntimeError | null {
  if (decision.resultCode !== CONFLICT_CODE) return null;
  const decoded = decodeBoundedJsonBytes(decision.resultBytes);
  if (!decoded.ok) return null;
  const result = objectOf(decoded.value);
  if (result === null) return null;
  // The store's own field names: it calls the head it saw `observedVersion`; the runtime error
  // registry calls the same number `actualVersion`. This is the one place they are married.
  const actualVersion = versionOf(result["observedVersion"]);
  const expectedVersion = versionOf(result["expectedVersion"]);
  if (actualVersion === null || expectedVersion === null) return null;
  return Object.freeze({
    code: CONFLICT_ROW.code,
    correlationId: null,
    details: Object.freeze({ actualVersion, expectedVersion }),
    nextAllowedCommands: EMPTY_NEXT_ALLOWED_COMMANDS,
    recoveryCategory: CONFLICT_ROW.recoveryCategory,
    recoveryCommands: CONFLICT_ROW.recoveryCommands,
    registryVersion: RUNTIME_ERROR_REGISTRY_VERSION,
    retryability: CONFLICT_ROW.retryability,
    transport: CONFLICT_ROW.transport,
    truthClass: CONFLICT_ROW.truthClass,
  });
}

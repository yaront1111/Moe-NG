import { RUNTIME_COMMAND_KINDS } from "@moe/contracts";
import type { RuntimeCommandKind } from "@moe/contracts";

import { createRecoveryAuthenticationBinding } from "./recovery-authentication-binding.js";
import type { RecoveryAuthenticationBinding } from "./recovery-authentication-binding.js";
import { snapshotExactArray, snapshotExactRecord } from "./identity-snapshot.js";

/**
 * `@moe/contracts` exports the frozen kind tuple but not its `isCommandKind`
 * guard, so the membership set is built locally.
 */
const COMMAND_KINDS: ReadonlySet<string> = new Set<string>(RUNTIME_COMMAND_KINDS);

function isCommandKind(value: unknown): value is RuntimeCommandKind {
  return typeof value === "string" && COMMAND_KINDS.has(value);
}

/**
 * Least-authority capability grants.
 *
 * A grant authorises exactly one (principal, project, command, target,
 * transport) tuple. There is deliberately no wildcard, prefix, or hierarchy
 * syntax: matching is full tuple equality and nothing else.
 */
export interface CapabilityGrant extends RecoveryAuthenticationBinding {
  readonly capabilityId: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly commandKind: RuntimeCommandKind;
  readonly targetAggregateId: string;
  readonly transportId: string;
  readonly requiresRecentStepUp: boolean;
}

export interface CapabilityQuery extends RecoveryAuthenticationBinding {
  readonly principalId: string;
  readonly projectId: string;
  readonly commandKind: string;
  readonly targetAggregateId: string;
  readonly transportId: string;
}

const GRANT_KEYS = [
  "capabilityId", "principalId", "projectId", "commandKind",
  "targetAggregateId", "transportId", "requiresRecentStepUp",
  "recoveryIncarnationRef", "keyEpochRef",
] as const;

const SCOPE_KEYS = [
  "principalId", "projectId", "commandKind", "targetAggregateId", "transportId",
] as const;
const TUPLE_KEYS = [...SCOPE_KEYS, "recoveryIncarnationRef", "keyEpochRef"] as const;

/**
 * Identifier charset for scope fields.
 *
 * `*` and `?` are excluded so a grant can never carry glob syntax that a
 * future matcher might be tempted to interpret.
 */
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function isScopeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && SCOPE_ID.test(value);
}

/**
 * Copies an untrusted record's own properties.
 *
 * Only the reads are guarded — a hostile getter or revoked proxy must fail
 * closed, but a bug in the validation below must NOT be swallowed into a
 * silent rejection.
 */
function readGrantFields(value: unknown): Record<string, unknown> | null {
  return snapshotExactRecord(value, GRANT_KEYS);
}

function snapshotGrantEntries(value: unknown): readonly unknown[] | null {
  return snapshotExactArray(value);
}

function readGrant(value: unknown): CapabilityGrant | null {
  const raw = readGrantFields(value);
  if (raw === null) return null;
  if (!isScopeId(raw.capabilityId) || !isScopeId(raw.principalId)) return null;
  if (!isScopeId(raw.projectId) || !isScopeId(raw.targetAggregateId)) return null;
  if (!isScopeId(raw.transportId)) return null;
  if (!isCommandKind(raw.commandKind)) return null;
  if (typeof raw.requiresRecentStepUp !== "boolean") return null;
  const recovery = createRecoveryAuthenticationBinding({
    recoveryIncarnationRef: raw.recoveryIncarnationRef,
    keyEpochRef: raw.keyEpochRef,
  });
  if (recovery === null) return null;
  return Object.freeze({
    ...recovery,
    capabilityId: raw.capabilityId,
    principalId: raw.principalId,
    projectId: raw.projectId,
    commandKind: raw.commandKind,
    targetAggregateId: raw.targetAggregateId,
    transportId: raw.transportId,
    requiresRecentStepUp: raw.requiresRecentStepUp,
  });
}

function grantKey(grant: CapabilityGrant): string {
  return [
    grant.capabilityId, grant.principalId, grant.projectId, grant.commandKind,
    grant.targetAggregateId, grant.transportId, String(grant.requiresRecentStepUp),
    grant.recoveryIncarnationRef, grant.keyEpochRef,
  ].join("|");
}

/**
 * Validates and canonically orders a grant list.
 *
 * Exact duplicates collapse; a capabilityId reused with a different tuple is a
 * conflicting definition and rejects the whole list. Returns null on any
 * invalid grant so a partially trusted set can never be produced.
 */
export function canonicalizeCapabilities(value: unknown): readonly CapabilityGrant[] | null {
  const entries = snapshotGrantEntries(value);
  if (entries === null) return null;
  const byKey = new Map<string, CapabilityGrant>();
  const byId = new Map<string, string>();
  for (const entry of entries) {
    const grant = readGrant(entry);
    if (grant === null) return null;
    const key = grantKey(grant);
    const seenKey = byId.get(grant.capabilityId);
    if (seenKey !== undefined && seenKey !== key) return null;
    byId.set(grant.capabilityId, key);
    byKey.set(key, grant);
  }
  const sorted = [...byKey.values()].sort((left, right) =>
    grantKey(left) < grantKey(right) ? -1 : grantKey(left) > grantKey(right) ? 1 : 0,
  );
  return Object.freeze(sorted);
}

/** Returns the single grant matching the full tuple, or null. */
export function matchCapability(
  grants: readonly CapabilityGrant[],
  query: CapabilityQuery,
): CapabilityGrant | null {
  for (const grant of grants) {
    if (TUPLE_KEYS.every((key) => grant[key] === query[key])) {
      return grant;
    }
  }
  return null;
}

/** Recovery refs from grants matching every non-recovery scope field. */
export function matchingCapabilityRecoveryBindings(
  grants: readonly CapabilityGrant[],
  query: Omit<CapabilityQuery, keyof RecoveryAuthenticationBinding>,
): readonly RecoveryAuthenticationBinding[] {
  const bindings = new Map<string, RecoveryAuthenticationBinding>();
  for (const grant of grants) {
    if (!SCOPE_KEYS.every((key) => grant[key] === query[key])) continue;
    const key = `${grant.recoveryIncarnationRef}:${grant.keyEpochRef}`;
    bindings.set(key, Object.freeze({
      recoveryIncarnationRef: grant.recoveryIncarnationRef,
      keyEpochRef: grant.keyEpochRef,
    }));
  }
  return Object.freeze([...bindings.values()]);
}

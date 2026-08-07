import {
  hasExactKeys,
  isHex64,
  isNonEmptyString,
  isPlainRecord,
  isSafeArray,
  isSafeCount,
  parseLeaseAuthority,
} from "./runtime-guards.js";
import type { RuntimeLeaseAuthority } from "./runtime-guards.js";
import {
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  isCommandKind,
  isKnownLifecycleSource,
} from "./runtime-vocabulary.js";
import type { RuntimeCommandKind } from "./runtime-vocabulary.js";

export interface NextAllowedCommand {
  readonly commandEnvelopeVersion: typeof RUNTIME_COMMAND_ENVELOPE_VERSION;
  readonly commandId: string;
  readonly commandKind: RuntimeCommandKind;
  readonly expectedVersion: number;
  readonly graphRevisionHash?: string;
  readonly inputSchemaVersion: string;
  readonly leaseAuthority?: RuntimeLeaseAuthority;
  readonly policyRevisionHash?: string;
  readonly targetAggregateId: string;
}

/** The single shared frozen no-authority set. Identity is part of the contract. */
export const EMPTY_NEXT_ALLOWED_COMMANDS: readonly NextAllowedCommand[] = Object.freeze([]);

const AFFORDANCE_REQUIRED = Object.freeze([
  "commandEnvelopeVersion", "commandId", "commandKind", "expectedVersion", "inputSchemaVersion",
  "targetAggregateId",
] as const);
const AFFORDANCE_OPTIONAL = Object.freeze([
  "graphRevisionHash", "leaseAuthority", "policyRevisionHash",
] as const);
const REVISION_HASH_KEYS = Object.freeze(["graphRevisionHash", "policyRevisionHash"] as const);

function parseAffordance(value: unknown): NextAllowedCommand | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, AFFORDANCE_REQUIRED, AFFORDANCE_OPTIONAL)) {
    return undefined;
  }
  if (value["commandEnvelopeVersion"] !== RUNTIME_COMMAND_ENVELOPE_VERSION) return undefined;
  if (!isCommandKind(value["commandKind"])) return undefined;
  if (!isNonEmptyString(value["commandId"])) return undefined;
  if (!isNonEmptyString(value["inputSchemaVersion"])) return undefined;
  if (!isNonEmptyString(value["targetAggregateId"])) return undefined;
  if (!isSafeCount(value["expectedVersion"])) return undefined;

  const draft: Record<string, unknown> = {
    commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    commandId: value["commandId"],
    commandKind: value["commandKind"],
    expectedVersion: value["expectedVersion"],
    inputSchemaVersion: value["inputSchemaVersion"],
    targetAggregateId: value["targetAggregateId"],
  };
  for (const key of REVISION_HASH_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    if (!isHex64(value[key])) return undefined;
    draft[key] = value[key];
  }
  if (Object.hasOwn(value, "leaseAuthority")) {
    const lease = parseLeaseAuthority(value["leaseAuthority"]);
    if (lease === undefined) return undefined;
    draft["leaseAuthority"] = lease;
  }
  return Object.freeze(draft) as unknown as NextAllowedCommand;
}

function affordanceKey(item: NextAllowedCommand): string {
  return `${item.commandKind} ${item.commandId}`;
}

/**
 * Deterministic mutation affordances for one known lifecycle source. Any unknown
 * source, malformed entry, duplicate command ID, or non-command kind yields the
 * shared frozen empty set rather than partial authority.
 */
export function buildNextAllowedCommands(
  source: unknown,
  entries: unknown,
): readonly NextAllowedCommand[] {
  if (!isKnownLifecycleSource(source) || !isSafeArray(entries)) {
    return EMPTY_NEXT_ALLOWED_COMMANDS;
  }
  const built: NextAllowedCommand[] = [];
  const seen = new Set<string>();
  for (const candidate of entries) {
    const parsed = parseAffordance(candidate);
    if (parsed === undefined || seen.has(parsed.commandId)) return EMPTY_NEXT_ALLOWED_COMMANDS;
    seen.add(parsed.commandId);
    built.push(parsed);
  }
  if (built.length === 0) return EMPTY_NEXT_ALLOWED_COMMANDS;
  built.sort((left, right) => {
    const a = affordanceKey(left);
    const b = affordanceKey(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return Object.freeze(built);
}

export interface FreshRuntimeResult {
  readonly historical: false;
  readonly nextAllowedCommands: readonly NextAllowedCommand[];
  readonly requiresAffordanceRefresh: false;
}

export interface HistoricalRuntimeResult {
  readonly historical: true;
  readonly nextAllowedCommands: readonly NextAllowedCommand[];
  readonly requiresAffordanceRefresh: true;
}

export type RuntimeAffordanceResult = FreshRuntimeResult | HistoricalRuntimeResult;

export function freshRuntimeResult(source: unknown, entries: unknown): FreshRuntimeResult {
  return Object.freeze({
    historical: false,
    nextAllowedCommands: buildNextAllowedCommands(source, entries),
    requiresAffordanceRefresh: false,
  });
}

const HISTORICAL_RESULT: HistoricalRuntimeResult = Object.freeze({
  historical: true,
  nextAllowedCommands: EMPTY_NEXT_ALLOWED_COMMANDS,
  requiresAffordanceRefresh: true,
});

/** An idempotent replay never carries current affordances (design section 12.1). */
export function historicalRuntimeResult(): HistoricalRuntimeResult {
  return HISTORICAL_RESULT;
}

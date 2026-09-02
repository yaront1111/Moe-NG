import {
  ADMISSION_PURPOSES, NODE_ADMISSION_GATE_POLICIES, NODE_ADMISSION_METERS,
  NODE_AUTHORITY_LIMITS, type NodeAdmissionAmount,
} from "@moe/scheduler";

import type {
  V2CompilerNodeAdmissionAuthority, V2CompilerNodeAdmissionAuthorityReader,
  V2CompilerNodeAdmissionRequest,
} from "./authority-contracts.js";
import {
  PLANNER_ADMISSION_PROFILE_VERSION,
  type PlannerAdmissionProfileBinding,
} from "./planner-admission-profile-contract.js";
import {
  plannerAdmissionProfileHex64, plannerAdmissionProfilePositive,
  plannerAdmissionProfileText,
} from "./planner-admission-profile-fields.js";
import { exact, snapshotCompilerInput } from "./snapshot.js";

const OUTER_KEYS = Object.freeze(["authority", "ok", "profileBinding"]);
const AUTHORITY_KEYS = Object.freeze(["admissionAmounts", "admissionGatePolicy"]);
const AMOUNT_KEYS = Object.freeze(["meter", "purpose", "quantity"]);
const BINDING_KEYS = Object.freeze([
  "nodeKey", "profileId", "revisionDigest", "revisionId", "version",
]);
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function expectedMeterCounts(
  request: V2CompilerNodeAdmissionRequest,
): ReadonlyMap<string, number> | undefined {
  const meters = new Map<string, number>();
  for (const budget of request.budgetBindings) {
    const meter = budget.kind === "COMPUTE" ? "attempt.count"
      : budget.kind === "TIME" ? request.authorityKind === "BUILDER"
        ? "runner.authorized_ms" : "verification.authorized_ms"
      : undefined;
    if (meter === undefined) return undefined;
    meters.set(meter, (meters.get(meter) ?? 0) + 1);
  }
  return meters;
}

function readAmounts(
  value: unknown,
  request: V2CompilerNodeAdmissionRequest,
): readonly NodeAdmissionAmount[] | undefined {
  if (!Array.isArray(value) || value.length === 0
    || value.length > NODE_AUTHORITY_LIMITS.maxAdmissionAmounts) return undefined;
  const meterCounts = expectedMeterCounts(request);
  if (meterCounts === undefined || meterCounts.size === 0
    || value.length !== meterCounts.size * ADMISSION_PURPOSES.length) return undefined;
  const expected = new Set([...meterCounts.keys()].flatMap((meter) =>
    ADMISSION_PURPOSES.map((purpose) => `${purpose}\0${meter}`)));
  const amounts: NodeAdmissionAmount[] = [];
  const meterTotals = new Map<string, bigint>();
  let previous: string | undefined;
  for (const candidate of value) {
    if (!exact(candidate, AMOUNT_KEYS)
      || !(ADMISSION_PURPOSES as readonly unknown[]).includes(candidate["purpose"])
      || !(NODE_ADMISSION_METERS as readonly unknown[]).includes(candidate["meter"])
      || !plannerAdmissionProfilePositive(candidate["quantity"])
      || candidate["quantity"] < (meterCounts.get(candidate["meter"] as string) ?? Infinity)) {
      return undefined;
    }
    const key = `${candidate["purpose"]}\0${candidate["meter"]}`;
    if (!expected.has(key) || previous !== undefined && compare(previous, key) >= 0) {
      return undefined;
    }
    previous = key;
    const meter = candidate["meter"] as string;
    const total = (meterTotals.get(meter) ?? 0n) + BigInt(candidate["quantity"]);
    if (total > BigInt(Number.MAX_SAFE_INTEGER) * BigInt(meterCounts.get(meter) ?? 0)) {
      return undefined;
    }
    meterTotals.set(meter, total);
    amounts.push(Object.freeze({ meter: candidate["meter"] as never,
      purpose: candidate["purpose"] as never, quantity: candidate["quantity"] }));
  }
  if (new Set(amounts.map(({ meter, purpose }) => `${purpose}\0${meter}`)).size
    !== expected.size) return undefined;
  return Object.freeze(amounts);
}

function readBinding(
  value: unknown,
  request: V2CompilerNodeAdmissionRequest,
): PlannerAdmissionProfileBinding | undefined {
  if (!exact(value, BINDING_KEYS)
    || value["nodeKey"] !== request.nodeKey
    || value["version"] !== PLANNER_ADMISSION_PROFILE_VERSION
    || !plannerAdmissionProfileText(value["nodeKey"])
    || !plannerAdmissionProfileText(value["profileId"])
    || !plannerAdmissionProfileHex64(value["revisionDigest"])
    || !plannerAdmissionProfileText(value["revisionId"])) return undefined;
  return Object.freeze({ nodeKey: value["nodeKey"], profileId: value["profileId"],
    revisionDigest: value["revisionDigest"], revisionId: value["revisionId"],
    version: PLANNER_ADMISSION_PROFILE_VERSION });
}

/** Descriptor-snapshots and validates the exact image of the Planner profile mapper. */
export function readCompilerAdmissionProfile(
  reader: V2CompilerNodeAdmissionAuthorityReader,
  request: V2CompilerNodeAdmissionRequest,
): V2CompilerNodeAdmissionAuthority | undefined {
  let value: unknown;
  try { value = reader(request); } catch { return undefined; }
  const captured = snapshotCompilerInput(value);
  if (!captured.ok || !exact(captured.value, OUTER_KEYS)
    || captured.value["ok"] !== true) return undefined;
  const authority = captured.value["authority"];
  if (!exact(authority, AUTHORITY_KEYS)
    || !(NODE_ADMISSION_GATE_POLICIES as readonly unknown[])
      .includes(authority["admissionGatePolicy"])) return undefined;
  const admissionAmounts = readAmounts(authority["admissionAmounts"], request);
  const profileBinding = readBinding(captured.value["profileBinding"], request);
  if (admissionAmounts === undefined || profileBinding === undefined) return undefined;
  return Object.freeze({ authority: Object.freeze({ admissionAmounts,
    admissionGatePolicy: authority["admissionGatePolicy"] as never }),
  ok: true as const, profileBinding });
}

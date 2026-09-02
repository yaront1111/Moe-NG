import {
  exactGate1Row, gate1Digest, gate1Text, snapshotGate1Data,
} from "./gate1-data-snapshot.js";

export const GATE1_COMMAND_KIND = "product_contract.approve_gate_1" as const;
export const GATE1_ANSWER_COMMAND_KIND = "product_contract.answer_clarification" as const;
export type Gate1CommandKind = typeof GATE1_COMMAND_KIND | typeof GATE1_ANSWER_COMMAND_KIND;

export interface Gate1DaemonSubmission {
  readonly affordance: Readonly<Record<string, unknown>>;
  readonly commandId: string;
  readonly correlationId: string;
  readonly payload: Readonly<Record<string, string>>;
  readonly requestDigest: string;
}

type Row = Readonly<Record<string, unknown>>;

const SUBMISSION_KEYS = Object.freeze([
  "affordance", "commandId", "correlationId", "payload", "requestDigest",
]);
const AFFORDANCE_KEYS = Object.freeze([
  "commandEnvelopeVersion", "commandId", "commandKind", "expectedVersion",
  "inputSchemaVersion", "targetAggregateId",
]);

function schemaVersion(kind: Gate1CommandKind): string {
  return kind === GATE1_COMMAND_KIND
    ? "moe-product-contract-gate-1/1"
    : "moe-product-contract-clarification/2";
}

function payloadMatches(value: unknown, expected: Readonly<Record<string, string>>): value is Row {
  const row = exactGate1Row(value, Object.keys(expected));
  return row !== null && Object.entries(expected).every(
    ([key, expectedValue]) => row[key] === expectedValue,
  );
}

/** Admits only the daemon submission for this exact durable subject. */
export function admitGate1DaemonSubmission(
  value: unknown,
  kind: Gate1CommandKind,
  expectedPayload: Readonly<Record<string, string>>,
): Gate1DaemonSubmission | null {
  const captured = snapshotGate1Data(value);
  if (!captured.ok) return null;
  const row = exactGate1Row(captured.value, SUBMISSION_KEYS);
  if (row === null || !gate1Text(row["commandId"]) || !gate1Text(row["correlationId"])
    || !gate1Digest(row["requestDigest"]) || !payloadMatches(row["payload"], expectedPayload)) {
    return null;
  }
  const affordance = exactGate1Row(row["affordance"], AFFORDANCE_KEYS);
  const expectedVersion = kind === GATE1_COMMAND_KIND ? 0 : 1;
  if (affordance === null || affordance["commandEnvelopeVersion"] !== "moe-runtime-command/1"
    || affordance["commandId"] !== row["commandId"] || affordance["commandKind"] !== kind
    || affordance["inputSchemaVersion"] !== schemaVersion(kind)
    || affordance["expectedVersion"] !== expectedVersion
    || !gate1Text(affordance["targetAggregateId"])) return null;
  return Object.freeze({
    affordance: Object.freeze({ ...affordance }),
    commandId: row["commandId"],
    correlationId: row["correlationId"],
    payload: Object.freeze({ ...row["payload"] as Record<string, string> }),
    requestDigest: row["requestDigest"],
  });
}

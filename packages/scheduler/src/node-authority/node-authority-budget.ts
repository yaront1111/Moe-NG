/** Descriptor-safe admission for the typed budget authority embedded in a NodeDefinition. */
import {
  ADMISSION_PURPOSES, type AdmissionAmount,
} from "../budget/budget-reservation.js";
import {
  hasExactDenseArrayShape, hasOnlyOwnStringKeys, isPlainArray, isPlainRecord,
  readOwnArrayElement, readOwnDataProperty, readPlainArrayLength,
} from "../runtime-shape.js";
import {
  NODE_ADMISSION_GATE_POLICIES, NODE_ADMISSION_METERS, NODE_AUTHORITY_LIMITS,
  compareStrings, ok, refuse,
} from "./node-authority-contract.js";
import type {
  NodeAdmissionAmount, NodeAdmissionGatePolicy, NodeAdmissionMeter, NodeAuthorityRefusal, Read,
} from "./node-authority-contract.js";

const AMOUNT_KEYS = ["meter", "purpose", "quantity"] as const;
const FORBIDDEN_BUDGET_KEYS = ["admissionGate", "budgetRequest"] as const;

export interface NodeAuthorityBudget {
  readonly admissionAmounts: readonly NodeAdmissionAmount[];
  readonly admissionGatePolicy: NodeAdmissionGatePolicy;
}

const isQuantity = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value)
  && value > 0 && !Object.is(value, -0);

const isPurpose = (value: unknown): value is AdmissionAmount["purpose"] =>
  typeof value === "string" && (ADMISSION_PURPOSES as readonly string[]).includes(value);

const isMeter = (value: unknown): value is NodeAdmissionMeter =>
  typeof value === "string" && (NODE_ADMISSION_METERS as readonly string[]).includes(value);

const pairKey = (amount: AdmissionAmount): string => `${amount.purpose}\0${amount.meter}`;

function readAmount(value: unknown): Read<NodeAdmissionAmount> {
  if (!isPlainRecord(value) || !hasOnlyOwnStringKeys(value, AMOUNT_KEYS)) {
    return refuse("NODE_AUTHORITY_BUDGET_AMOUNT_INVALID", "NODE_AUTHORITY_BUDGET",
      "an admission amount is not an exact purpose/meter/quantity record");
  }
  const purpose = readOwnDataProperty(value, "purpose");
  const meter = readOwnDataProperty(value, "meter");
  const quantity = readOwnDataProperty(value, "quantity");
  if (!purpose.ok || !purpose.present || !isPurpose(purpose.value)
    || !quantity.ok || !quantity.present || !isQuantity(quantity.value)) {
    return refuse("NODE_AUTHORITY_BUDGET_AMOUNT_INVALID", "NODE_AUTHORITY_BUDGET",
      "an admission amount carries an invalid purpose or quantity");
  }
  if (!meter.ok || !meter.present || !isMeter(meter.value)) {
    return refuse("NODE_AUTHORITY_BUDGET_METER_UNKNOWN", "NODE_AUTHORITY_BUDGET",
      "an admission amount names a meter outside the closed authority vocabulary");
  }
  return ok({ purpose: purpose.value, meter: meter.value, quantity: quantity.value });
}

function readAmounts(value: unknown): Read<readonly NodeAdmissionAmount[]> {
  if (!isPlainArray(value)) {
    return refuse("NODE_AUTHORITY_BUDGET_AMOUNT_INVALID", "NODE_AUTHORITY_BUDGET",
      "admissionAmounts is not a plain array");
  }
  const length = readPlainArrayLength(value);
  if (length === null || length === 0 || length > NODE_AUTHORITY_LIMITS.maxAdmissionAmounts) {
    return refuse("NODE_AUTHORITY_LIMIT_EXCEEDED", "NODE_AUTHORITY_LIMITS",
      "admissionAmounts is empty or exceeds its bound");
  }
  if (!hasExactDenseArrayShape(value, length)) {
    return refuse("NODE_AUTHORITY_BUDGET_AMOUNT_INVALID", "NODE_AUTHORITY_BUDGET",
      "admissionAmounts is not a dense data-property array");
  }
  const amounts: NodeAdmissionAmount[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = readOwnArrayElement(value, index);
    if (!item.ok || !item.present) {
      return refuse("NODE_AUTHORITY_BUDGET_AMOUNT_INVALID", "NODE_AUTHORITY_BUDGET",
        "an admission amount is absent or accessor-backed");
    }
    const amount = readAmount(item.value);
    if (!amount.ok) return amount;
    amounts.push(amount.value);
  }
  const keys = amounts.map(pairKey);
  if (new Set(keys).size !== keys.length) {
    return refuse("NODE_AUTHORITY_BUDGET_DUPLICATE_PAIR", "NODE_AUTHORITY_BUDGET",
      "admissionAmounts repeats a purpose/meter pair");
  }
  return ok(Object.freeze(amounts.sort((left, right) => compareStrings(pairKey(left), pairKey(right)))));
}

export function forbiddenBudgetKeyRefusal(value: object): NodeAuthorityRefusal | null {
  for (const key of FORBIDDEN_BUDGET_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const code = key === "budgetRequest"
      ? "NODE_AUTHORITY_BUDGET_LEGACY_SCALAR" : "NODE_AUTHORITY_BUDGET_GATE_WITNESS_FORBIDDEN";
    return refuse(code, "NODE_AUTHORITY_BUDGET",
      `${key} is retired caller authority and may not enter a NodeDefinition`);
  }
  return null;
}

export function readNodeAuthorityBudget(
  amountsValue: unknown, policyValue: unknown,
): Read<NodeAuthorityBudget> {
  const amounts = readAmounts(amountsValue);
  if (!amounts.ok) return amounts;
  if (typeof policyValue !== "string"
    || !(NODE_ADMISSION_GATE_POLICIES as readonly string[]).includes(policyValue)) {
    return refuse("NODE_AUTHORITY_BUDGET_GATE_POLICY_INVALID", "NODE_AUTHORITY_BUDGET",
      "admissionGatePolicy is outside the closed policy vocabulary");
  }
  return ok(Object.freeze({
    admissionAmounts: amounts.value,
    admissionGatePolicy: policyValue as NodeAdmissionGatePolicy,
  }));
}

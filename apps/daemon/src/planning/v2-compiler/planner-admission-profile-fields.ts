import { PLANNER_ADMISSION_PROFILE_LIMITS } from "./planner-admission-profile-contract.js";

const encoder = new TextEncoder();
const HEX64 = /^[0-9a-f]{64}$/u;
const BUDGET_BINDING = /^moe\.v2\.budget-bindings\.sha256:[0-9a-f]{64}$/u;

export function plannerAdmissionProfileText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && value.length <= PLANNER_ADMISSION_PROFILE_LIMITS.maxIdBytes
    && encoder.encode(value).byteLength <= PLANNER_ADMISSION_PROFILE_LIMITS.maxIdBytes
    && value.trim() === value && !value.includes("\0") && value.isWellFormed()
    && value.normalize("NFC") === value;
}

export function plannerAdmissionProfileHex64(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

export function plannerAdmissionProfilePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function plannerAdmissionProfileBudgetBinding(value: unknown): value is string {
  return typeof value === "string" && BUDGET_BINDING.test(value);
}

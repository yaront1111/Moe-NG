/** Structural admission for values the provider-run codec may adopt as records. */
import { types } from "node:util";
import {
  CLAUDE_LAUNCH_ERROR_CODES,
  CLAUDE_LAUNCH_LAYERS,
  CLAUDE_LAUNCH_TRUTH_CLASSES,
  CLAUDE_MODEL_EVIDENCE_KINDS,
  CLAUDE_REASONING_EFFORTS,
  PROVIDER_CONCURRENCY_FACTS,
  PROVIDER_COUNT_COVERAGE_CLASSES,
  PROVIDER_INFRASTRUCTURE_OUTCOMES,
  PROVIDER_TELEMETRY_CODES,
  PROVIDER_TELEMETRY_LAYERS,
  PROVIDER_TERMINAL_OUTCOMES,
} from "@moe/runner";
import {
  BUDGET_ISSUE_CODES,
  BUDGET_MEASUREMENT_COVERAGES,
  BUDGET_MEASUREMENT_SOURCES,
  MEASUREMENT_ISSUE_CODES,
} from "@moe/scheduler";
import { PROVIDER_RUN_RECORD_VERSION } from "./provider-run-contracts.js";
import type { ProviderRunRecord } from "./provider-run-contracts.js";

export type ProviderRunShapeStatus = "OK" | "RECORD" | "FIELD" | "VERSION";
type DataRecord = Record<string, unknown>;
type Predicate = (value: unknown) => boolean;
const LAUNCH_KINDS = ["REFUSED", "ADOPTED", "EXIT_BEFORE_LAUNCH", "OBSERVED"] as const;

const REQUIRED_KEYS = [
  "recordVersion", "providerRunRef", "launch", "declared", "observedModel",
  "terminal", "infrastructure", "tokens", "steps", "sequence", "concurrency",
  "usage", "usageRefusals", "stdoutReceiptDigest", "stderrReceiptDigest",
] as const satisfies readonly (keyof ProviderRunRecord)[];

function dataRecord(value: unknown): DataRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return null;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Object.getOwnPropertySymbols(value).length !== 0) return null;
  const output = Object.create(null) as DataRecord;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor) || !descriptor.enumerable) return null;
    output[key] = descriptor.value;
  }
  return output;
}

function exact(value: unknown, keys: readonly string[]): DataRecord | null {
  const raw = dataRecord(value);
  if (raw === null) return null;
  const actual = Object.keys(raw);
  return actual.length === keys.length && keys.every((key) => key in raw) ? raw : null;
}

function member(values: readonly string[], value: unknown): boolean {
  return typeof value === "string" && values.includes(value);
}

function count(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nonempty(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function optionalText(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function factUnknown(value: unknown): boolean {
  const raw = exact(value, ["known", "code", "layer"]);
  return raw !== null && raw["known"] === false
    && member(PROVIDER_TELEMETRY_CODES, raw["code"])
    && member(PROVIDER_TELEMETRY_LAYERS, raw["layer"]);
}

function quantity(value: unknown): boolean {
  const known = exact(value, ["known", "value"]);
  return known !== null && known["known"] === true && count(known["value"])
    || factUnknown(value);
}

function textFact(value: unknown): boolean {
  const known = exact(value, ["known", "value"]);
  return known !== null && known["known"] === true && nonempty(known["value"])
    || factUnknown(value);
}

function denseArray(value: unknown, item: Predicate): boolean {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0
    || Object.getOwnPropertyNames(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable
      || !item(descriptor.value)) return false;
  }
  return true;
}

function runRef(value: unknown): boolean {
  const raw = exact(value, ["provider", "runRef", "effectIntentId", "attemptRef", "epoch"]);
  return raw !== null && raw["provider"] === "claude" && nonempty(raw["runRef"])
    && nonempty(raw["effectIntentId"]) && nonempty(raw["attemptRef"]) && count(raw["epoch"]);
}

function launchExit(value: unknown): boolean {
  if (value === null) return true;
  const raw = dataRecord(value);
  if (raw?.["kind"] === "EXITED") return exact(value, ["kind", "code"]) !== null && Number.isInteger(raw["code"]);
  if (raw?.["kind"] === "SIGNALLED") return exact(value, ["kind", "signal"]) !== null && nonempty(raw["signal"]);
  return raw?.["kind"] === "UNOBSERVED" && exact(value, ["kind"]) !== null;
}

function launch(value: unknown): boolean {
  const keys = ["kind", "truthClass", "reasonCode", "reasonLayer", "exit", "effectDigest",
    "activationDigest", "runtimeBindingDigest", "quotedRuntimeDigest", "freshRuntimeDigest",
    "pinnedClosureDigest", "observationDigest", "startedAt", "completedAt"];
  const raw = exact(value, keys);
  if (raw === null || !member(LAUNCH_KINDS, raw["kind"])
    || !member(CLAUDE_LAUNCH_TRUTH_CLASSES, raw["truthClass"])) return false;
  const reason = raw["reasonCode"] === null && raw["reasonLayer"] === null
    || member(CLAUDE_LAUNCH_ERROR_CODES, raw["reasonCode"])
      && member(CLAUDE_LAUNCH_LAYERS, raw["reasonLayer"]);
  const textKeys = keys.slice(5);
  return reason && launchExit(raw["exit"]) && textKeys.every((key) => optionalText(raw[key]));
}

function selection(value: unknown): boolean {
  if (factUnknown(value)) return true;
  const declared = exact(value, ["known", "selection"]);
  if (declared === null || declared["known"] !== true) return false;
  const raw = exact(declared["selection"], ["provider", "selectedModelId", "modelSnapshotKind",
    "modelSnapshotEvidence", "reasoningEffort", "profileRevisionId", "configurationDigest",
    "policyDigest", "orchestrationDigest", "concurrencyCeiling"]);
  return raw !== null && raw["provider"] === "claude" && nonempty(raw["selectedModelId"])
    && member(CLAUDE_MODEL_EVIDENCE_KINDS, raw["modelSnapshotKind"])
    && nonempty(raw["modelSnapshotEvidence"]) && member(CLAUDE_REASONING_EFFORTS, raw["reasoningEffort"])
    && ["profileRevisionId", "configurationDigest", "policyDigest", "orchestrationDigest"]
      .every((key) => nonempty(raw[key])) && count(raw["concurrencyCeiling"]);
}

function observedModel(value: unknown): boolean {
  const raw = exact(value, ["modelId", "snapshotKind", "snapshotEvidence"]);
  return raw !== null && textFact(raw["modelId"])
    && member(CLAUDE_MODEL_EVIDENCE_KINDS, raw["snapshotKind"]) && textFact(raw["snapshotEvidence"]);
}

function tokens(value: unknown): boolean {
  const raw = exact(value, ["inputTokens", "outputTokens", "cacheCreationInputTokens",
    "cacheReadInputTokens", "coverage"]);
  return raw !== null && ["inputTokens", "outputTokens", "cacheCreationInputTokens", "cacheReadInputTokens"]
    .every((key) => quantity(raw[key])) && member(PROVIDER_COUNT_COVERAGE_CLASSES, raw["coverage"]);
}

function steps(value: unknown): boolean {
  const raw = exact(value, ["turns", "coverage"]);
  return raw !== null && quantity(raw["turns"])
    && member(PROVIDER_COUNT_COVERAGE_CLASSES, raw["coverage"]);
}

function concurrency(value: unknown): boolean {
  const raw = exact(value, ["fact", "declaredCeiling", "achieved"]);
  return raw !== null && member(PROVIDER_CONCURRENCY_FACTS, raw["fact"])
    && quantity(raw["declaredCeiling"]) && quantity(raw["achieved"]);
}

function clock(value: unknown): boolean {
  if (value === null) return true;
  const raw = exact(value, ["serverWallSeconds", "bootId", "monotonicObservation"]);
  return raw !== null && count(raw["serverWallSeconds"])
    && nonempty(raw["bootId"]) && count(raw["monotonicObservation"]);
}

function pricebook(value: unknown): boolean {
  if (value === null) return true;
  const raw = exact(value, ["pricebookRevisionRef", "unitPriceMicros", "pricedAtRef"]);
  return raw !== null && nonempty(raw["pricebookRevisionRef"])
    && count(raw["unitPriceMicros"]) && nonempty(raw["pricedAtRef"]);
}

function measurement(value: unknown): boolean {
  const row = exact(value, ["measurement", "pricebookBinding", "truncated", "identity"]);
  if (row === null || typeof row["truncated"] !== "boolean" || !nonempty(row["identity"]) || !pricebook(row["pricebookBinding"])) return false;
  const raw = exact(row["measurement"], ["meter", "quantity", "coverage", "source", "providerRunRef",
    "sourceParserVersion", "sequence", "rawReceiptDigest", "observedInterval"]);
  const interval = raw === null ? null : exact(raw["observedInterval"], ["startRef", "endRef"]);
  return raw !== null && nonempty(raw["meter"])
    && (raw["quantity"] === null || count(raw["quantity"]))
    && member(BUDGET_MEASUREMENT_COVERAGES, raw["coverage"])
    && member(BUDGET_MEASUREMENT_SOURCES, raw["source"]) && nonempty(raw["providerRunRef"])
    && count(raw["sourceParserVersion"]) && count(raw["sequence"]) && nonempty(raw["rawReceiptDigest"])
    && interval !== null && nonempty(interval["startRef"]) && nonempty(interval["endRef"]);
}

function usageRefusal(value: unknown): boolean {
  const raw = exact(value, ["providerSequence", "issues"]);
  return raw !== null && count(raw["providerSequence"]) && denseArray(raw["issues"], (issue) => {
    const item = exact(issue, ["layer", "code", "message"]);
    if (item === null || !nonempty(item["message"])) return false;
    return item["layer"] === "CONTRACT" && member(BUDGET_ISSUE_CODES, item["code"])
      || item["layer"] === "MEASUREMENT" && member(MEASUREMENT_ISSUE_CODES, item["code"]);
  });
}

function upstream(value: unknown): boolean {
  if (value === null) return true;
  const raw = exact(value, ["ok", "code", "layer", "message"]);
  return raw !== null && raw["ok"] === false && member(PROVIDER_TELEMETRY_CODES, raw["code"])
    && member(PROVIDER_TELEMETRY_LAYERS, raw["layer"]) && nonempty(raw["message"]);
}

export function validateProviderRunRecordShape(value: DataRecord): ProviderRunShapeStatus {
  const raw = dataRecord(value);
  if (raw === null) return "FIELD";
  if (!REQUIRED_KEYS.every((key) => key in raw)) return "RECORD";
  if (raw["recordVersion"] !== PROVIDER_RUN_RECORD_VERSION) return "VERSION";
  const valid = runRef(raw["providerRunRef"]) && launch(raw["launch"]) && selection(raw["declared"])
    && observedModel(raw["observedModel"]) && member(PROVIDER_TERMINAL_OUTCOMES, raw["terminal"])
    && member(PROVIDER_INFRASTRUCTURE_OUTCOMES, raw["infrastructure"]) && tokens(raw["tokens"])
    && steps(raw["steps"]) && quantity(raw["sequence"]) && concurrency(raw["concurrency"])
    && (!("observedStart" in raw) || clock(raw["observedStart"]))
    && (!("observedEnd" in raw) || clock(raw["observedEnd"]))
    && denseArray(raw["usage"], measurement) && denseArray(raw["usageRefusals"], usageRefusal)
    && (!("upstreamRefusal" in raw) || upstream(raw["upstreamRefusal"]))
    && textFact(raw["stdoutReceiptDigest"])
    && textFact(raw["stderrReceiptDigest"]);
  return valid ? "OK" : "FIELD";
}

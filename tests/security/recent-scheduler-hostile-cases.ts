import {
  BUDGET_COMMITMENT_LAYER,
  verifyBudgetCommitment,
} from "../../apps/daemon/src/budget/budget-commitment.js";
import {
  CUTOVER_ACTIVATE_LAYER,
  storeRefusal as cutoverActivateStoreRefusal,
} from "../../apps/daemon/src/cutover/cutover-activate-contracts.js";
import {
  CUTOVER_ATTEMPT_LAYER,
  decodeCutoverAttemptEvent,
} from "../../apps/daemon/src/cutover/cutover-attempt-contracts.js";
import {
  GA_ACTIVATION_BINDING_LAYER,
  admitActivationBinding,
} from "../../packages/benchmark/src/activation-binding.js";
import {
  GA_ACTIVATION_RECORD_LAYER,
  composeActivationRecord,
} from "../../packages/benchmark/src/activation-record.js";
import type {
  HostileCase,
  HostileRaceCase,
} from "./scheduler-activation-hostile-cases.js";

interface Spec {
  readonly constant: string;
  readonly expected: Readonly<{ code: string; layer: string }>;
  readonly refused: () => unknown;
}

const specs: readonly Spec[] = Object.freeze([
  {
    constant: "BUDGET_COMMITMENT_LAYER",
    expected: { code: "BUDGET_COMMITMENT_REF_MALFORMED", layer: BUDGET_COMMITMENT_LAYER },
    refused: () => verifyBudgetCommitment({} as never, {} as never, "not-a-digest"),
  },
  {
    constant: "CUTOVER_ACTIVATE_LAYER",
    expected: { code: "CUTOVER_ACTIVATE_STORE_UNAVAILABLE", layer: CUTOVER_ACTIVATE_LAYER },
    refused: () => cutoverActivateStoreRefusal(new Error("hostile store failure")),
  },
  {
    constant: "CUTOVER_ATTEMPT_LAYER",
    expected: { code: "CUTOVER_ATTEMPT_EVIDENCE_UNREADABLE", layer: CUTOVER_ATTEMPT_LAYER },
    refused: () => decodeCutoverAttemptEvent(new Uint8Array()),
  },
  {
    constant: "GA_ACTIVATION_BINDING_LAYER",
    expected: { code: "ACTIVATION_BINDING_ABSENT", layer: GA_ACTIVATION_BINDING_LAYER },
    refused: () => admitActivationBinding(null),
  },
  {
    constant: "GA_ACTIVATION_RECORD_LAYER",
    expected: { code: "ACTIVATION_RECORD_SOURCE_COMMIT_INVALID", layer: GA_ACTIVATION_RECORD_LAYER },
    refused: () => composeActivationRecord({ sourceCommit: "not-a-commit" } as never),
  },
]);

export const RECENT_SCHEDULER_CASES: readonly HostileCase[] = Object.freeze(specs.flatMap((spec) => [
  {
    constant: spec.constant, arm: "BEFORE" as const,
    name: "malformed input is refused before authority can be admitted",
    arranged: spec.expected.layer, expected: spec.expected,
    run: async () => spec.refused(),
  },
  {
    constant: spec.constant, arm: "AFTER" as const,
    name: "malformed input remains refused after a prior observation",
    arranged: spec.expected.layer, expected: spec.expected,
    run: async () => { spec.refused(); return spec.refused(); },
  },
]));

export const RECENT_SCHEDULER_RACES: readonly HostileRaceCase[] = Object.freeze(specs.map((spec) => ({
  constant: spec.constant,
  name: "two malformed inputs racing admit neither",
  arranged: spec.expected.layer,
  expected: spec.expected,
  maxAdmitted: 0 as const,
  run: async () => Promise.all([
    Promise.resolve().then(spec.refused),
    Promise.resolve().then(spec.refused),
  ]),
})));

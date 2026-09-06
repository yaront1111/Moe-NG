import {
  decodeDesignRevision, decodeDesignRevisionBytes,
} from "../../apps/daemon/src/design/design-contracts.js";
import {
  readEnvironmentVariables, unsetEnvironmentVariable,
} from "../../apps/daemon/src/environment/environment-store.js";
import type { EnvironmentStoreConfig } from "../../apps/daemon/src/environment/environment-store.js";
import {
  decodePreviewDecidePayload, decodePreviewStartPayload,
} from "../../apps/daemon/src/preview/preview-contracts.js";
import { probeAfter, probeBefore, probeRacing } from "./hostile-harness.js";
import type { RefusalExpectation } from "./hostile-harness.js";
import type { HostileCase } from "./integrity-hostile-cases.js";

const bound = { label: "workflow-integrity", timeoutMs: 2_000 };
const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const skip = { skipped: true, reason: "No visual surface in this design" };
// Missing sealing authority is explicit. Neither malformed input nor a read may reach storage.
const environment: EnvironmentStoreConfig = {
  credential: () => null, projectId: "security-project", now: () => "2026-09-06T00:00:00Z",
  store: new Proxy({} as EnvironmentStoreConfig["store"], {
    get: () => { throw new Error("refused environment input reached persistence"); },
  }),
};

interface Spec {
  readonly constant: string;
  readonly expected: RefusalExpectation;
  readonly hostile: () => unknown;
  readonly observe: () => unknown;
}

const specs: readonly Spec[] = [
  { constant: "DESIGN_LAYERS", expected: { code: "DESIGN_SHAPE_INVALID", layer: "REQUEST" },
    hostile: () => decodeDesignRevision({ ...skip, unexpected: true }),
    observe: () => decodeDesignRevision(skip) },
  { constant: "DESIGN_CODE_LAYERS", expected: { code: "DESIGN_RECORD_MALFORMED", layer: "LEDGER" },
    hostile: () => decodeDesignRevisionBytes(bytes({ ...skip, unexpected: true })),
    observe: () => decodeDesignRevisionBytes(bytes(skip)) },
  { constant: "ENVIRONMENT_LAYERS", expected: { code: "ENV_ENVIRONMENT_UNKNOWN", layer: "SCOPE" },
    hostile: () => unsetEnvironmentVariable(environment, { environment: "unrecognised", name: "PUBLIC_FLAG" }),
    observe: () => readEnvironmentVariables(environment, "preview") },
  { constant: "ENVIRONMENT_CODE_LAYERS", expected: { code: "ENV_NAME_INVALID", layer: "NAME" },
    hostile: () => unsetEnvironmentVariable(environment, { environment: "preview", name: "../invalid" }),
    observe: () => readEnvironmentVariables(environment, "preview") },
  { constant: "PREVIEW_LAYERS", expected: { code: "PREVIEW_DECISION_INVALID", layer: "REQUEST" },
    hostile: () => decodePreviewDecidePayload({ decision: "APPROVE", previewRef: "preview-1", extra: true }),
    observe: () => decodePreviewDecidePayload({ decision: "APPROVE", previewRef: "preview-1" }) },
  { constant: "PREVIEW_CODE_LAYERS", expected: { code: "PREVIEW_START_PAYLOAD_INVALID", layer: "REQUEST" },
    hostile: () => decodePreviewStartPayload({ goalId: "../another-goal", sha: "a".repeat(40) }),
    observe: () => decodePreviewStartPayload({ goalId: "goal-1", sha: "a".repeat(40) }) },
];

/** Every probe calls the input guard that emits the code/map's own layer. */
export const RECENT_WORKFLOW_INTEGRITY_CASES: readonly HostileCase[] = Object.freeze(specs.flatMap(
  ({ constant, expected, hostile, observe }): readonly HostileCase[] => [
    { arm: "BEFORE", constant, expect: expected, name: "malformed request refuses before observation",
      run: async () => (await probeBefore(bound, async () => hostile(), async () => observe())).probe },
    { arm: "AFTER", constant, expect: expected, name: "prior valid observation cannot admit malformed input",
      run: async () => (await probeAfter(bound, async () => observe(), async () => hostile())).probe },
    { arm: "RACE", constant, expectLeft: expected, expectRight: expected,
      name: "racing malformed requests admit neither",
      run: async () => probeRacing(bound, async () => hostile(), async () => hostile()) },
  ],
));

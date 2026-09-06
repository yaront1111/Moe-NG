import { mapBootstrapReadAnswer } from "../../apps/control-room/src/live/live-bootstrap-receipt.js";
import { driveActivationChain } from "../../apps/control-room/src/v2/ops/activation-port.js";
import { resourceSections } from "../../apps/control-room/src/v2/resources/resources-model.js";
import type { ResourceReads } from "../../apps/control-room/src/v2/resources/resources-model.js";
import { probeAfter, probeBefore, probeRacing } from "./hostile-harness.js";
import type { RefusalExpectation } from "./hostile-harness.js";
import type { HostileCase } from "./transport-hostile-cases.js";
import { BOUND } from "./transport-hostile-fixtures.js";

/** Real response/offer consumers. Projections copy production's refusal, never mint one. */
const activationRefusal = async (): Promise<unknown> => {
  const steps = await driveActivationChain({ submit: async () => {
    throw new Error("unreadable surface reached command submission");
  } }, async () => { throw new Error("surface unavailable"); });
  const step = steps[0];
  return step?.state === "ANSWERED" ? step.outcome : step;
};

function providerSource(ref: string | null): unknown {
  const reads: ResourceReads = {
    activation: {
      status: "ACTIVATION", blocking: [], distribution: null, measuredAt: "2026-09-06T00:00:00Z",
      members: [{ member: "provider", measured: true, ref, hash: null, code: null, layer: null,
        reason: "" }],
      provider: null, repository: null, schemaVersion: "moe-activation-receipts/1",
      signing: { measured: false, member: "signing", reason: "", ref: "unmeasured", trustBoundary: false },
      store: null,
    },
    health: null, policy: null, remote: null, sessions: null,
  };
  const state = resourceSections(reads).find((section) => section.id === "provider")
    ?.facts.find((fact) => fact.id === "credential")?.state;
  return state?.kind === "REFUSED" ? state.refusal : state;
}

interface Spec {
  readonly boundary: string;
  readonly expected: RefusalExpectation;
  readonly hostile: () => unknown | Promise<unknown>;
  readonly observe: () => unknown | Promise<unknown>;
}

const specs: readonly Spec[] = [
  {
    boundary: "BOOTSTRAP_RECEIPT_LAYER",
    expected: { code: "BOOTSTRAP_READ_UNREADABLE", layer: "CONTROL_ROOM_BOOTSTRAP_RECEIPT" },
    hostile: () => mapBootstrapReadAnswer(200, { outcome: "BOOTSTRAP_READ", receipt: {} }),
    observe: () => mapBootstrapReadAnswer(200, { outcome: "BOOTSTRAP_READ", receipt: null }),
  },
  {
    boundary: "ACTIVATION_LAYER",
    expected: { code: "ACTIVATION_SURFACE_UNREADABLE", layer: "CONTROL_ROOM_ACTIVATION" },
    hostile: activationRefusal,
    observe: () => driveActivationChain({ submit: async () => {
      throw new Error("absent offer reached command submission");
    } }, async () => ({ offers: [], steps: [] }) as never),
  },
  {
    boundary: "RESOURCES_LAYER",
    expected: { code: "RESOURCES_CREDENTIAL_SOURCE_UNRECOGNISED", layer: "CONTROL_ROOM_RESOURCES" },
    // Null and malformed source references cannot become a displayed credential source.
    // No credential values or canaries are created, retained, or printed by this table.
    hostile: () => providerSource(null),
    observe: () => providerSource("not-a-source-reference"),
  },
];

export const RECENT_WORKFLOW_TRANSPORT_CASES: readonly HostileCase[] = Object.freeze(specs.flatMap(
  ({ boundary, expected, hostile, observe }): readonly HostileCase[] => [
    { arm: "BEFORE", boundary, expected, name: "untrusted response cannot create authority",
      run: async () => (await probeBefore(BOUND, async () => hostile(), async () => observe())).probe },
    { arm: "AFTER", boundary, expected, name: "prior observation cannot authorize an unreadable response",
      run: async () => (await probeAfter(BOUND, async () => observe(), async () => hostile())).probe },
    { arm: "RACE", boundary, expected: { left: expected, right: expected },
      name: "racing unreadable responses both refuse",
      run: async () => probeRacing(BOUND, async () => hostile(), async () => hostile()) },
  ],
));

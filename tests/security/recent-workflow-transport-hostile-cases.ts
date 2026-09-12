import type { OfferWire } from "../../apps/control-room/src/v2/approvals/offer-wire.js";
import { mapBootstrapReadAnswer } from "../../apps/control-room/src/live/live-bootstrap-receipt.js";
import { driveActivationChain } from "../../apps/control-room/src/v2/ops/activation-port.js";
import {
  ENVIRONMENT_SET_KIND, ENVIRONMENT_UNSET_KIND, createEnvironmentVariablesPort,
} from "../../apps/control-room/src/v2/ops/environment-variables-port.js";
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

/**
 * The credential ref rides in the provider row's `reason` (activation-read.ts `receiptRow`
 * publishes the receipt's `detail` there); `ref` is the committed probe envelope ref.
 */
function providerSource(credentialRef: string): unknown {
  const reads: ResourceReads = {
    activation: {
      status: "ACTIVATION", blocking: [], distribution: null, measuredAt: "2026-09-06T00:00:00Z",
      members: [{ member: "provider", measured: true, ref: "provider-profile-1", hash: null,
        code: null, layer: null, reason: credentialRef }],
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

/**
 * THE ENVIRONMENTS WRITE PORT. `spendOffer` reaches `answerOf` only once the transport reports
 * `delivered`, and an answer that is not a record is stamped OFFER_ANSWER_UNREADABLE at the
 * CALLER's layer - here CONTROL_ROOM_ENVIRONMENT_WRITE. That is the property worth pinning: an
 * unreadable daemon answer must not fall through as an ACCEPTED write, because the operator's
 * only confirmation a write took is the fingerprint changing on the next read, and a silently
 * accepted non-write leaves them staring at the old one believing it is the new one.
 *
 * BOTH KINDS ARE DRIVEN. A surface that refuses `set` and admits `unset` is exactly the
 * half-covered seam a single-kind probe would miss.
 *
 * NO SECRET IS COMMITTED HERE (epic rail 3): the probe value is a literal marked as a placeholder,
 * the refusal this asserts on carries `{code, layer}` only, and no value is read back from it.
 */
const PROBE_VALUE = "placeholder-not-a-secret";

/**
 * A wire whose builder succeeds and whose transport DELIVERS - the only route that reaches
 * `answerOf`. Cast at the seam because `ControlRoomClientSurface["commands"]` is the full
 * generated command roster and a probe needs exactly two of its members; the shape below is the
 * `Builder`/`sendCommand` contract `offer-wire.ts` actually calls.
 */
function environmentWire(response: unknown): OfferWire {
  const build = (): { readonly envelope: unknown; readonly ok: true } =>
    ({ envelope: { commandId: "ui-env-probe" }, ok: true });
  return {
    client: { commands: { [ENVIRONMENT_SET_KIND]: build, [ENVIRONMENT_UNSET_KIND]: build } },
    sessionCredential: "probe-session",
    transport: { sendCommand: async (): Promise<unknown> => ({ delivered: true, response }) },
  } as unknown as OfferWire;
}

const environmentWrite = async (kind: "set" | "unset", response: unknown): Promise<unknown> => {
  const port = createEnvironmentVariablesPort(environmentWire(response));
  return kind === "set"
    ? await port.set("preview", "PROBE_NAME", PROBE_VALUE)
    : await port.unset("preview", "PROBE_NAME");
};

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
    // Empty and malformed credential refs, on the field the model reads, cannot become a
    // displayed credential source. No credential values or canaries are created, retained,
    // or printed by this table.
    hostile: () => providerSource(""),
    observe: () => providerSource("not-a-source-reference"),
  },
  {
    boundary: "ENVIRONMENT_WRITE_LAYER",
    expected: { code: "OFFER_ANSWER_UNREADABLE", layer: "CONTROL_ROOM_ENVIRONMENT_WRITE" },
    // A bare string answer on `set`, a null answer on `unset`: two unreadable shapes across the
    // two kinds, one refusal. Neither can report the write as accepted.
    hostile: () => environmentWrite("set", "accepted"),
    observe: () => environmentWrite("unset", null),
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

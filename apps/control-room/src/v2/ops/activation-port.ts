import { DEV_PAYLOADS } from "../../live/live-dispatch-payloads.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { spendOffer } from "../approvals/offer-wire.js";
import type { OfferOutcome, OfferWire } from "../approvals/offer-wire.js";

/**
 * ACTIVATING THE PROJECT from the browser, one button. A fresh project cannot open a goal
 * until five commands are committed in the daemon's own prerequisite order, and until now
 * only a seeded script could drive them. This port spends the daemon's own offer once per
 * command, RE-READING the affordance surface before every step because each commit moves the
 * aggregate's version and the daemon re-offers at the new one — a cached offer is a stale
 * version. Nothing here spells a version, and `project.activate` carries NO witness: the
 * daemon measures its own receipts and mints it (task-4b9c394d), and a caller-supplied one
 * is refused ACTIVATION_WITNESS_CALLER_SUPPLIED @ DAEMON_INGRESS.
 *
 * Transcribed from policy-install-port.ts, deliberately down to the shape of the loop. Its
 * `readSurfaceOnce` is IMPORTED rather than copied: that helper reads /affordances/read and
 * knows nothing about policy, and a second fetch idiom for the same route is exactly what
 * this row's rail forbids.
 */

export { readSurfaceOnce } from "./policy-install-port.js";

/**
 * The daemon's prerequisite order, not this module's preference. The chain is fixed: a caller
 * cannot reorder it, because the order IS the prerequisite.
 *
 * `project.activate` has TWO prerequisite authorities in the daemon and this roster satisfies
 * BOTH. The first is the admission table (COMMAND_PREREQUISITES,
 * apps/daemon/src/bootstrap/bootstrap-sequence.ts), which refuses BOOTSTRAP_PREREQUISITE_MISSING
 * and lists only the three commands before it here. The second is the MEASURED activation
 * receipts (ACTIVATION_RECEIPT_MEMBERS, apps/daemon/src/bootstrap/activation-receipts.ts): the
 * `policy` member is the digest of the INSTALLED SLICE SET, so a store with none is unmeasured
 * and the activate refuses ACTIVATION_POLICY_UNMEASURED @ DAEMON_ACTIVATION_RECEIPTS. That is
 * why `policy.install` is a member HERE while the admission table omits it — the second
 * authority is the one it answers to, and mirroring only the first is what let a fresh store
 * run three steps green and refuse at the fourth (task-d342a2b1).
 *
 * Both mirrors are HAND-TRANSCRIBED: apps/control-room cannot import apps/daemon (no workspace
 * edge, no tsconfig `paths`, and a deep relative import is TS6059), so this roster must be
 * re-checked whenever EITHER authority moves.
 */
export const ACTIVATION_CHAIN_KINDS = Object.freeze([
  "project.register", "project.bind_repository", "provider.probe", "policy.install",
  "project.activate",
] as const);

export type ActivationChainKind = (typeof ACTIVATION_CHAIN_KINDS)[number];

export const ACTIVATION_LAYER = "CONTROL_ROOM_ACTIVATION" as const;
/** The surface read itself failed, so this step was never attempted. */
export const ACTIVATION_SURFACE_UNREADABLE = "ACTIVATION_SURFACE_UNREADABLE" as const;
/** The daemon offers no such command AND does not call it committed: it is unreachable from here. */
export const ACTIVATION_COMMAND_NOT_OFFERED = "ACTIVATION_COMMAND_NOT_OFFERED" as const;
/** No caller half is stated for this kind, so nothing is sent rather than an invented body. */
export const ACTIVATION_BODY_UNSTATED = "ACTIVATION_BODY_UNSTATED" as const;

export type ActivationWire = OfferWire;
export type ActivationOutcome = OfferOutcome;

/**
 * The caller half of each chain command, read off the board's ONE roster
 * (live-dispatch-payloads.ts) rather than minted here. `project.activate` is `{}` there, on
 * purpose and with the reason written beside it; a literal spelled here would be a second,
 * stale source of truth for bodies the daemon already refuses when they drift.
 */
export function activationBodyFor(
  kind: ActivationChainKind,
): Readonly<Record<string, unknown>> | null {
  return DEV_PAYLOADS[kind] ?? null;
}

export interface ActivationPort {
  submit(
    kind: ActivationChainKind, affordance: Readonly<Record<string, unknown>>,
  ): Promise<ActivationOutcome>;
}

export function createActivationPort(wire: ActivationWire): ActivationPort {
  return Object.freeze({
    submit: (
      kind: ActivationChainKind, affordance: Readonly<Record<string, unknown>>,
    ): Promise<ActivationOutcome> => {
      const body = activationBodyFor(kind);
      if (body === null) {
        return Promise.resolve({ code: ACTIVATION_BODY_UNSTATED, layer: ACTIVATION_LAYER, ok: false });
      }
      return spendOffer(wire, kind, affordance, body, "ui-activate", ACTIVATION_LAYER);
    },
  });
}

/**
 * One command's answer. ALREADY_COMMITTED is NOT a refusal: after a chain stops mid-way the
 * commands that succeeded are no longer offered, and reporting the daemon's own COMMITTED
 * step as a refusal would tell an operator that finished work had failed.
 */
export type ActivationStep =
  | { readonly kind: ActivationChainKind; readonly state: "ALREADY_COMMITTED" }
  | { readonly kind: ActivationChainKind; readonly outcome: ActivationOutcome; readonly state: "ANSWERED" };

const offerFor = (
  surface: SurfaceFrame, kind: ActivationChainKind,
): Readonly<Record<string, unknown>> | undefined =>
  surface.offers.find((candidate) => candidate["commandKind"] === kind);

/** The daemon's own word on this command, never inferred from the offer's absence. */
const committed = (surface: SurfaceFrame, kind: ActivationChainKind): boolean =>
  surface.steps.some((step) => step.kind === kind && step.status === "COMMITTED");

const refusedStep = (kind: ActivationChainKind, code: string): ActivationStep =>
  ({ kind, outcome: { code, layer: ACTIVATION_LAYER, ok: false }, state: "ANSWERED" });

/**
 * Drives the chain in order, stopping at the FIRST refusal so a person sees exactly which
 * command the daemon refused and why, at the refusing authority's own code and layer. Each
 * step reads the surface fresh; a read that throws and an unreachable command are each their
 * own recorded refusal, never a guessed version.
 */
export async function driveActivationChain(
  port: ActivationPort,
  readSurface: () => Promise<SurfaceFrame>,
  kinds: readonly ActivationChainKind[] = ACTIVATION_CHAIN_KINDS,
): Promise<readonly ActivationStep[]> {
  const steps: ActivationStep[] = [];
  for (const kind of kinds) {
    let surface: SurfaceFrame;
    try {
      surface = await readSurface();
    } catch {
      steps.push(refusedStep(kind, ACTIVATION_SURFACE_UNREADABLE));
      break;
    }
    const offer = offerFor(surface, kind);
    if (offer === undefined) {
      if (committed(surface, kind)) {
        steps.push({ kind, state: "ALREADY_COMMITTED" });
        continue;
      }
      steps.push(refusedStep(kind, ACTIVATION_COMMAND_NOT_OFFERED));
      break;
    }
    const outcome = await port.submit(kind, offer);
    steps.push({ kind, outcome, state: "ANSWERED" });
    if (!outcome.ok) break;
  }
  return Object.freeze(steps);
}

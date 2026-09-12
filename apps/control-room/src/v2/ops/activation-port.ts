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
 *
 * `policy.validate` IS A MEMBER, and it is the sixth for a THIRD authority nobody had reached
 * from here before. MEASURED 2026-09-09 on a fresh product this browser bootstrapped: the plan
 * gate refused `APPROVAL_INTENT_POLICY_REF_UNAVAILABLE @ DAEMON_APPROVAL_INTENT`, because
 * `approval.decide_intent` — the ONLY approval wire a paired durable HUMAN may ride — derives
 * its `applicablePolicyRef` from the newest replay-verified `PolicyEvaluated`
 * (apps/daemon/src/planning/approval-policy-ref.ts), and nothing but `policy.validate` writes
 * that row. Without it a browser-bootstrapped product activates, compiles a plan, and can then
 * never approve it: a dead end at the product's headline gate, not a slow path.
 *
 * IT SITS BEFORE `project.activate`, which is the order `bootstrap-test-fixtures.ts` already
 * proves and `tests/e2e/foundation/multi-node-world.ts` documents: the evaluation must follow
 * every `policy.install` (a later `PolicyInstalled` reusing the selected slice makes the
 * derivation refuse SUPERSESSION_POLICY_DECISION_POLICY_REUSED) and the admission table asks
 * only for `policy.install` before it (bootstrap-sequence.ts:30), so it is admissible here.
 * IT GRANTS NO RULES, AND ITS TWO OPT-INS ARE THE OPERATOR'S OWN STANDING DECLARATION. The
 * slice `DEV_PAYLOADS` names carries no rules; since task-a47301ee it carries auto-approval
 * opt-ins for `preview.decide` and `release.decide` at the R1 ceiling, which the human operator
 * declares once for the host rather than anything this evaluation mints. R2 and R3 subjects stay
 * human-only regardless (HUMAN_ONLY_TIER), and evaluating the slice only records that the policy
 * was evaluated. This sentence previously read "GRANTS NOTHING ... no auto-approval opt-ins",
 * which that row made false; it sits on the activation chain, where a reader trusts it.
 */
export const ACTIVATION_CHAIN_KINDS = Object.freeze([
  "project.register", "project.bind_repository", "provider.probe", "policy.install",
  "policy.validate", "project.activate",
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
 * A refusal that IS the daemon saying "already done". `policy.install` stays OFFERED after it
 * committed (installing a further slice is legal), so the surface never calls it COMMITTED and
 * the chain re-submits it; a second Activate press was then refused
 * `BOOTSTRAP_POLICY_SLICE_ALREADY_INSTALLED` and stopped BEFORE `policy.validate` and
 * `project.activate` (measured 2026-09-13 on a registered UnAI project: 5 of 6 receipts, backup
 * never written, every press ending at this row). Only the codes listed here are read that way,
 * and only for their own kind; any other refusal still stops the chain unrewritten.
 */
const ALREADY_DONE_REFUSALS: Readonly<Partial<Record<ActivationChainKind, string>>> = Object.freeze({
  "policy.install": "BOOTSTRAP_POLICY_SLICE_ALREADY_INSTALLED",
});

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
    if (!outcome.ok && outcome.code === ALREADY_DONE_REFUSALS[kind]) {
      steps.push({ kind, state: "ALREADY_COMMITTED" });
      continue;
    }
    steps.push({ kind, outcome, state: "ANSWERED" });
    if (!outcome.ok) break;
  }
  return Object.freeze(steps);
}

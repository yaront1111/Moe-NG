import { spendOffer } from "../approvals/offer-wire.js";
import type { OfferOutcome, OfferWire } from "../approvals/offer-wire.js";
import { frameOfSurface } from "../../live/live-board-feed.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";

/**
 * INSTALLING THE STANDARD POLICY from the browser. A fresh project cannot accept delivered
 * work until three slices are installed (the verifier policy, the reviewer calibration and
 * one evaluation policy). The daemon states those bodies on the policy read and offers
 * `policy.install` on the project's policy aggregate; this port spends that offer once per
 * missing slice, re-reading the surface between installs because every install moves the
 * aggregate's version and the daemon re-offers at the new one. Nothing here spells a
 * policy: the bodies are the daemon's, the offer is the daemon's, and each answer is kept.
 */

export const POLICY_INSTALL_COMMAND_KIND = "policy.install" as const;
const POLICY_INSTALL_LAYER = "CONTROL_ROOM_POLICY_INSTALL" as const;
const SURFACE_TIMEOUT_MS = 15_000;

export type PolicyInstallWire = OfferWire;
export type PolicyInstallOutcome = OfferOutcome;

export interface PolicyInstallPort {
  submit(affordance: Readonly<Record<string, unknown>>, slice: Readonly<Record<string, unknown>>): Promise<PolicyInstallOutcome>;
}

export function createPolicyInstallPort(wire: PolicyInstallWire): PolicyInstallPort {
  return Object.freeze({
    submit: (affordance: Readonly<Record<string, unknown>>, slice: Readonly<Record<string, unknown>>): Promise<PolicyInstallOutcome> =>
      spendOffer(wire, POLICY_INSTALL_COMMAND_KIND, affordance, { slice }, "ui-policy-install", POLICY_INSTALL_LAYER),
  });
}

/** One read of the affordance surface, for the offer at the aggregate's current version. */
export async function readSurfaceOnce(headers: Readonly<Record<string, string>>): Promise<SurfaceFrame> {
  const response = await fetch("/affordances/read", {
    body: "{}", headers, method: "POST", signal: AbortSignal.timeout(SURFACE_TIMEOUT_MS),
  });
  return frameOfSurface(await response.json());
}

export interface StandardSliceToInstall {
  readonly kind: string;
  readonly slice: Readonly<Record<string, unknown>>;
  readonly sliceRef: string;
}

export interface InstallStep {
  readonly kind: string;
  readonly sliceRef: string;
  readonly outcome: PolicyInstallOutcome;
}

/**
 * Installs the given slices in order, stopping at the first refusal so a person sees exactly
 * which install the daemon refused and why. Each step reads the surface fresh; an absent
 * `policy.install` offer is its own recorded refusal, never a guessed version.
 */
export async function installStandardPolicy(
  port: PolicyInstallPort,
  readSurface: () => Promise<SurfaceFrame>,
  slices: readonly StandardSliceToInstall[],
): Promise<readonly InstallStep[]> {
  const steps: InstallStep[] = [];
  for (const entry of slices) {
    let surface: SurfaceFrame;
    try {
      surface = await readSurface();
    } catch {
      steps.push({ kind: entry.kind, outcome: { code: "SURFACE_UNREADABLE", layer: POLICY_INSTALL_LAYER, ok: false }, sliceRef: entry.sliceRef });
      break;
    }
    const offer = surface.offers.find((candidate) => candidate["commandKind"] === POLICY_INSTALL_COMMAND_KIND);
    if (offer === undefined) {
      steps.push({ kind: entry.kind, outcome: { code: "POLICY_INSTALL_NOT_OFFERED", layer: POLICY_INSTALL_LAYER, ok: false }, sliceRef: entry.sliceRef });
      break;
    }
    const outcome = await port.submit(offer, entry.slice);
    steps.push({ kind: entry.kind, outcome, sliceRef: entry.sliceRef });
    if (!outcome.ok) break;
  }
  return Object.freeze(steps);
}

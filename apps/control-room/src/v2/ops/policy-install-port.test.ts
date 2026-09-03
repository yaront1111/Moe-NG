import { describe, expect, it, vi } from "vitest";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { createPolicyInstallPort, installStandardPolicy } from "./policy-install-port.js";
import type { PolicyInstallPort } from "./policy-install-port.js";

const offerAt = (version: number): Record<string, unknown> => ({
  commandEnvelopeVersion: "moe-runtime-command/1", commandId: `cmd-${String(version)}`, commandKind: "policy.install",
  expectedVersion: version, inputSchemaVersion: "bootstrap/1", targetAggregateId: "unai-policy",
});
const surfaceWith = (offers: readonly Record<string, unknown>[]): SurfaceFrame => ({ offers } as unknown as SurfaceFrame);
const SLICES = [
  { kind: "VERIFIER_POLICY", slice: { sliceRef: "moe-verifier-policy/1" }, sliceRef: "moe-verifier-policy/1" },
  { kind: "REVIEWER_CALIBRATION", slice: { sliceRef: "moe-reviewer-calibration/1" }, sliceRef: "moe-reviewer-calibration/1" },
] as const;

describe("installStandardPolicy", () => {
  it("re-reads the surface before every install and spends the offer at its current version", async () => {
    let version = 0;
    const readSurface = vi.fn(async () => surfaceWith([offerAt(version)]));
    const submitted: unknown[] = [];
    const port: PolicyInstallPort = {
      submit: async (affordance, slice) => {
        submitted.push([affordance["expectedVersion"], slice["sliceRef"]]);
        version += 1;
        return { commandId: String(affordance["commandId"]), ok: true };
      },
    };
    const steps = await installStandardPolicy(port, readSurface, SLICES);
    expect(submitted).toEqual([[0, "moe-verifier-policy/1"], [1, "moe-reviewer-calibration/1"]]);
    expect(readSurface).toHaveBeenCalledTimes(2);
    expect(steps.map((step) => [step.kind, step.outcome.ok])).toEqual([["VERIFIER_POLICY", true], ["REVIEWER_CALIBRATION", true]]);
  });

  it("stops at the first refusal, and records an absent offer as its own refusal", async () => {
    const port: PolicyInstallPort = { submit: async () => ({ code: "BOOTSTRAP_POLICY_SLICE_INVALID", layer: "DAEMON", ok: false }) };
    const refusedSteps = await installStandardPolicy(port, async () => surfaceWith([offerAt(0)]), SLICES);
    expect(refusedSteps).toHaveLength(1);
    expect(refusedSteps[0]?.outcome).toEqual({ code: "BOOTSTRAP_POLICY_SLICE_INVALID", layer: "DAEMON", ok: false });
    const noOffer = await installStandardPolicy(port, async () => surfaceWith([]), SLICES);
    expect(noOffer[0]?.outcome).toEqual({ code: "POLICY_INSTALL_NOT_OFFERED", layer: "CONTROL_ROOM_POLICY_INSTALL", ok: false });
    const unreadable = await installStandardPolicy(port, () => Promise.reject(new Error("down")), SLICES);
    expect(unreadable[0]?.outcome).toEqual({ code: "SURFACE_UNREADABLE", layer: "CONTROL_ROOM_POLICY_INSTALL", ok: false });
  });
});

describe("createPolicyInstallPort", () => {
  it("spends the daemon's offer with exactly { slice } through the shared wire", async () => {
    const sent: unknown[] = [];
    const built: unknown[] = [];
    const wire = {
      client: { commands: { "policy.install": (affordance: unknown, input: { payload: unknown }) => {
        built.push([affordance, input.payload]);
        return { envelope: { commandId: "cmd-0" }, ok: true };
      } } },
      sessionCredential: "sess",
      transport: { sendCommand: async (envelope: unknown) => { sent.push(envelope); return { delivered: true, response: { ok: true } }; } },
    };
    const outcome = await createPolicyInstallPort(wire as never).submit(offerAt(0), { sliceRef: "moe-verifier-policy/1" });
    expect(outcome).toEqual({ commandId: "cmd-0", ok: true });
    expect(built).toEqual([[offerAt(0), { slice: { sliceRef: "moe-verifier-policy/1" } }]]);
    expect(sent).toHaveLength(1);
  });
});

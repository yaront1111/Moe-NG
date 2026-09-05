import { describe, expect, it, vi } from "vitest";

import { DEV_PAYLOADS } from "../../live/live-dispatch-payloads.js";
import type { SurfaceFrame, SurfaceStep } from "../../live/live-board-feed.js";
import {
  ACTIVATION_BODY_UNSTATED,
  ACTIVATION_CHAIN_KINDS,
  ACTIVATION_COMMAND_NOT_OFFERED,
  ACTIVATION_LAYER,
  ACTIVATION_SURFACE_UNREADABLE,
  activationBodyFor,
  createActivationPort,
  driveActivationChain,
} from "./activation-port.js";
import type { ActivationChainKind, ActivationPort, ActivationStep } from "./activation-port.js";

/**
 * The chain the browser drives, and every way it is allowed to stop. The arms assert the
 * STABLE CODE and the LAYER, not merely that something was refused: two of the three refusal
 * codes are this row's own, and a test that only checked `ok === false` would stay green if
 * the port answered a neighbour's code.
 */

const offerFor = (kind: string, version: number): Record<string, unknown> => ({
  commandEnvelopeVersion: "moe-runtime-command/1", commandId: `cmd-${kind}-${String(version)}`,
  commandKind: kind, expectedVersion: version, inputSchemaVersion: "bootstrap/1",
  targetAggregateId: "unai-project",
});

const committedStep = (kind: string): SurfaceStep => ({
  aggregateId: "unai-project", claim: null, kind, missing: [], status: "COMMITTED", version: 1,
});

const surface = (
  offers: readonly Record<string, unknown>[], steps: readonly SurfaceStep[] = [],
): SurfaceFrame => ({ offers, steps } as unknown as SurfaceFrame);

/** Every chain kind offered at the same version; the version advances as commands commit. */
const allOffered = (version: number): SurfaceFrame =>
  surface(ACTIVATION_CHAIN_KINDS.map((kind) => offerFor(kind, version)));

/** Records what was submitted and answers `ok` unless a kind is listed as refusing. */
function recordingPort(refusals: Readonly<Partial<Record<ActivationChainKind, {
  readonly code: string; readonly layer: string;
}>>> = {}): { readonly port: ActivationPort; readonly sent: [ActivationChainKind, unknown][] } {
  const sent: [ActivationChainKind, unknown][] = [];
  const port: ActivationPort = {
    submit: (kind, affordance) => {
      sent.push([kind, affordance["expectedVersion"]]);
      const refusal = refusals[kind];
      return Promise.resolve(refusal === undefined
        ? { commandId: String(affordance["commandId"]), ok: true as const }
        : { code: refusal.code, layer: refusal.layer, ok: false as const });
    },
  };
  return { port, sent };
}

const kindsOf = (steps: readonly ActivationStep[]): readonly string[] => steps.map((step) => step.kind);

describe("ACTIVATION_CHAIN_KINDS", () => {
  it("is the daemon's prerequisite order, and every kind in it has a stated caller half", () => {
    expect([...ACTIVATION_CHAIN_KINDS]).toEqual([
      "project.register", "project.bind_repository", "provider.probe", "policy.install",
      "project.activate",
    ]);
    // The roster is only worth asserting if it was actually enumerated: a sweep that yields
    // zero cases would otherwise pass silently.
    expect(ACTIVATION_CHAIN_KINDS).toHaveLength(5);
    for (const kind of ACTIVATION_CHAIN_KINDS) {
      expect(activationBodyFor(kind), `no caller half stated for ${kind}`).not.toBeNull();
    }
  });
});

describe("driveActivationChain", () => {
  it("re-reads the surface before EVERY step and spends the offer at its current version", async () => {
    let version = 0;
    const readSurface = vi.fn(() => Promise.resolve(allOffered(version)));
    const { port, sent } = recordingPort();
    const wrapped: ActivationPort = {
      submit: async (kind, affordance) => {
        const outcome = await port.submit(kind, affordance);
        // Every commit moves the aggregate's version; a port that cached the first frame
        // would keep spending version 0 and be refused by a real daemon.
        version += 1;
        return outcome;
      },
    };

    const steps = await driveActivationChain(wrapped, readSurface);

    expect(kindsOf(steps)).toEqual([...ACTIVATION_CHAIN_KINDS]);
    expect(steps.every((step) => step.state === "ANSWERED" && step.outcome.ok)).toBe(true);
    expect(readSurface).toHaveBeenCalledTimes(5);
    expect(sent).toEqual([
      ["project.register", 0], ["project.bind_repository", 1],
      ["provider.probe", 2], ["policy.install", 3], ["project.activate", 4],
    ]);
  });

  it("stops at the daemon's first refusal, keeping its exact code and layer unrewritten", async () => {
    const { port, sent } = recordingPort({
      "provider.probe": { code: "PROVIDER_PROFILE_INPUT_INVALID", layer: "DAEMON_INGRESS" },
    });

    const steps = await driveActivationChain(port, () => Promise.resolve(allOffered(0)));

    expect(steps).toHaveLength(3);
    expect(kindsOf(steps)).toEqual(["project.register", "project.bind_repository", "provider.probe"]);
    const third = steps[2];
    expect(third?.state).toBe("ANSWERED");
    expect(third?.state === "ANSWERED" ? third.outcome : null).toEqual({
      code: "PROVIDER_PROFILE_INPUT_INVALID", layer: "DAEMON_INGRESS", ok: false,
    });
    // project.activate was never attempted.
    expect(sent.map(([kind]) => kind)).not.toContain("project.activate");
  });

  it("records an unreachable command as its own code at this layer, and sends nothing for it", async () => {
    const withoutActivate = surface(
      ACTIVATION_CHAIN_KINDS.filter((kind) => kind !== "project.activate")
        .map((kind) => offerFor(kind, 0)),
    );
    const { port, sent } = recordingPort();

    const steps = await driveActivationChain(port, () => Promise.resolve(withoutActivate));

    expect(steps).toHaveLength(5);
    const last = steps[4];
    expect(last?.kind).toBe("project.activate");
    expect(last?.state === "ANSWERED" ? last.outcome : null).toEqual({
      code: ACTIVATION_COMMAND_NOT_OFFERED, layer: ACTIVATION_LAYER, ok: false,
    });
    expect(ACTIVATION_COMMAND_NOT_OFFERED).toBe("ACTIVATION_COMMAND_NOT_OFFERED");
    expect(ACTIVATION_LAYER).toBe("CONTROL_ROOM_ACTIVATION");
    expect(sent).toHaveLength(4);
    expect(sent.map(([kind]) => kind)).not.toContain("project.activate");
  });

  it("carries on past a command the daemon's own surface already calls COMMITTED", async () => {
    // The common re-run: register and bind succeeded on a previous click, so they are no
    // longer offered. Reporting them as refusals would tell an operator finished work failed.
    const partly = surface(
      [offerFor("provider.probe", 2), offerFor("policy.install", 2), offerFor("project.activate", 2)],
      [committedStep("project.register"), committedStep("project.bind_repository")],
    );
    const { port, sent } = recordingPort();

    const steps = await driveActivationChain(port, () => Promise.resolve(partly));

    expect(steps.map((step) => step.state)).toEqual([
      "ALREADY_COMMITTED", "ALREADY_COMMITTED", "ANSWERED", "ANSWERED", "ANSWERED",
    ]);
    expect(sent.map(([kind]) => kind))
      .toEqual(["provider.probe", "policy.install", "project.activate"]);
  });

  it("records a surface read that threw as its own code and attempts nothing after it", async () => {
    const { port, sent } = recordingPort();

    const steps = await driveActivationChain(port, () => Promise.reject(new Error("daemon restarted")));

    expect(steps).toHaveLength(1);
    expect(steps[0]?.kind).toBe("project.register");
    const only = steps[0];
    expect(only?.state === "ANSWERED" ? only.outcome : null).toEqual({
      code: ACTIVATION_SURFACE_UNREADABLE, layer: ACTIVATION_LAYER, ok: false,
    });
    expect(ACTIVATION_SURFACE_UNREADABLE).toBe("ACTIVATION_SURFACE_UNREADABLE");
    expect(sent).toHaveLength(0);
  });

  it("stops mid-chain when the daemon goes away between steps, naming the step it reached", async () => {
    let reads = 0;
    const readSurface = (): Promise<SurfaceFrame> => {
      reads += 1;
      return reads <= 2 ? Promise.resolve(allOffered(reads - 1)) : Promise.reject(new Error("gone"));
    };
    const { port } = recordingPort();

    const steps = await driveActivationChain(port, readSurface);

    expect(kindsOf(steps)).toEqual(["project.register", "project.bind_repository", "provider.probe"]);
    const stopped = steps[2];
    expect(stopped?.state === "ANSWERED" ? stopped.outcome : null).toEqual({
      code: ACTIVATION_SURFACE_UNREADABLE, layer: ACTIVATION_LAYER, ok: false,
    });
  });
});

describe("createActivationPort", () => {
  /** A wire that records the payload each builder was handed and answers `ok`. */
  function spyWire(): { readonly built: [string, unknown][]; readonly wire: unknown } {
    const built: [string, unknown][] = [];
    const commands = Object.fromEntries(ACTIVATION_CHAIN_KINDS.map((kind) => [
      kind,
      (_affordance: unknown, input: { readonly payload: unknown }) => {
        built.push([kind, input.payload]);
        return { envelope: { commandId: `cmd-${kind}` }, ok: true };
      },
    ]));
    return {
      built,
      wire: {
        client: { commands }, sessionCredential: "sess",
        transport: { sendCommand: () => Promise.resolve({ delivered: true, response: { ok: true } }) },
      },
    };
  }

  it("sends project.activate with an EMPTY payload: no witness reaches the daemon", async () => {
    const { built, wire } = spyWire();

    const outcome = await createActivationPort(wire as never)
      .submit("project.activate", offerFor("project.activate", 3));

    expect(outcome).toEqual({ commandId: "cmd-project.activate", ok: true });
    expect(built).toHaveLength(1);
    const payload = built[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual([]);
    expect(payload).not.toHaveProperty("witness");
    // Asserted against the PRODUCTION roster, not a local copy: the daemon mints its own
    // nine-key witness (task-4b9c394d) and refuses a caller-supplied one.
    expect(Object.keys(DEV_PAYLOADS["project.activate"] ?? { unstated: true })).toEqual([]);
    expect(activationBodyFor("project.activate")).toEqual({});
  });

  it("spends each chain command through the shared wire with the roster's own caller half", async () => {
    const { built, wire } = spyWire();
    const port = createActivationPort(wire as never);

    for (const kind of ACTIVATION_CHAIN_KINDS) await port.submit(kind, offerFor(kind, 0));

    expect(built.map(([kind]) => kind)).toEqual([...ACTIVATION_CHAIN_KINDS]);
    for (const [kind, payload] of built) {
      expect(payload).toEqual(DEV_PAYLOADS[kind]);
      expect(payload).not.toHaveProperty("witness");
    }
  });

  it("refuses at its own code rather than sending an invented body for an unstated kind", async () => {
    const { built, wire } = spyWire();

    const outcome = await createActivationPort(wire as never)
      .submit("not.a.chain.kind" as ActivationChainKind, offerFor("not.a.chain.kind", 0));

    expect(outcome).toEqual({ code: ACTIVATION_BODY_UNSTATED, layer: ACTIVATION_LAYER, ok: false });
    expect(ACTIVATION_BODY_UNSTATED).toBe("ACTIVATION_BODY_UNSTATED");
    expect(built).toHaveLength(0);
  });
});

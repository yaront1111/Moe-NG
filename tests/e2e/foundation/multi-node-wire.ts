/**
 * THE HTTP TRANSPORT the multi-node journey drives the REAL daemon over.
 *
 * It is a transport and nothing else: it seals envelopes with the SHIPPED `toWireEnvelope`,
 * posts them at the daemon's own `/command` route, and reports what the daemon said. It
 * decides no order, invents no command and restates no refusal — a daemon code travels out
 * with the daemon's own code and layer so a failing journey names the fence that answered
 * rather than a local synonym for "no".
 *
 * WHY NOT `wireFor` FROM THE SEED. That transport pins ONE credential for the whole run,
 * because the seed is the operator throughout. This journey has three actors — the operator
 * bootstrap credential, an AGENT session and a durable HUMAN principal's session — and the
 * credential is the thing under test on the Gate 1 leg, so it is a per-request argument here.
 *
 * NO WALL CLOCK AND NO RANDOM SOURCE: `e2e-harness.test.ts` scans every non-test module in
 * this directory for four needles by plain substring match. Every clock reading this journey
 * needs is a PARAMETER supplied by the test file, which the scan excludes.
 */
import { WIRE_PROTOCOL_VERSION } from "../../../apps/daemon/src/http/http-contract.js";
import { toWireEnvelope } from "../../../apps/daemon/src/orchestrator/demo-seed-plan.js";
import type { SeedCommand } from "../../../apps/daemon/src/orchestrator/demo-seed-plan.js";

import { CSRF_TOKEN } from "./j1-loop-harness.js";

/** Every frame the daemon answers with, read as a plain record; never narrowed here. */
export type Frame = Record<string, unknown>;

export const asObject = (value: unknown): Frame | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Frame : null;

export interface DaemonWire {
  /** The operator bootstrap credential, for the legs that are genuinely the operator's. */
  readonly operatorCredential: string;
  post(path: string, body: unknown, credential?: string): Promise<Frame>;
}

/**
 * The daemon's listener guards demand all four headers; Origin is checked against the bound
 * loopback origin, so it is the daemon's OWN origin rather than a spelled constant.
 */
export function daemonWire(origin: string, operatorCredential: string): DaemonWire {
  const post = async (path: string, body: unknown, credential?: string): Promise<Frame> => {
    const response = await fetch(`${origin}${path}`, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        origin,
        "x-moe-csrf": CSRF_TOKEN,
        "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
        "x-moe-session-credential": credential ?? operatorCredential,
      },
      method: "POST",
    });
    const text = await response.text();
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${path} answered non-JSON (${String(response.status)}): ${text}`);
    }
    const frame = asObject(raw);
    if (frame === null) throw new Error(`${path} answered a non-object frame: ${text}`);
    return frame;
  };
  return { operatorCredential, post };
}

/**
 * Throws with the daemon's OWN code and layer rather than a local restatement.
 *
 * A journey step that refuses is the interesting event in this whole file: the message has to
 * carry enough for a reader to know WHICH fence answered without rerunning the suite, so the
 * whole frame is stringified rather than summarised.
 */
export function accepted(step: string, frame: Frame): Frame {
  if (frame["outcome"] !== "ACCEPTED") {
    throw new Error(`${step} was not ACCEPTED: ${JSON.stringify(frame)}`);
  }
  return frame;
}

/** A read route's success outcome, asserted by name so a refusal cannot read as an empty page. */
export function answered(step: string, expected: string, frame: Frame): Frame {
  if (frame["outcome"] !== expected) {
    throw new Error(`${step} did not answer ${expected}: ${JSON.stringify(frame)}`);
  }
  return frame;
}

/** One planned command, sealed at the wire. The plan itself never carries a credential. */
export async function send(
  wire: DaemonWire, command: SeedCommand, credential?: string,
): Promise<Frame> {
  return accepted(
    `${command.commandKind} ${command.commandId}`,
    await wire.post("/command", toWireEnvelope(command, credential ?? wire.operatorCredential),
      credential),
  );
}

export interface CommandDraft {
  readonly commandId: string;
  readonly commandKind: string;
  readonly expectedVersion?: number;
  readonly payload: Record<string, unknown>;
  readonly targetAggregateId: string;
}

/** A draft plus the one correlation id this whole journey travels under. */
export function command(correlationId: string, draft: CommandDraft): SeedCommand {
  return Object.freeze({
    commandId: draft.commandId,
    commandKind: draft.commandKind,
    correlationId,
    expectedVersion: draft.expectedVersion ?? 0,
    payload: Object.freeze(draft.payload),
    targetAggregateId: draft.targetAggregateId,
  });
}

/** Rows off `/affordances/read`, read as records so a caller can look for its own step. */
export interface SurfaceView {
  readonly nextAllowedCommands: readonly Frame[];
  readonly steps: readonly Frame[];
}

export async function readSurface(wire: DaemonWire, projectId: string): Promise<SurfaceView> {
  const frame = answered(
    "/affordances/read", "SURFACE", await wire.post("/affordances/read", { projectId }),
  );
  const rows = (key: string): readonly Frame[] => (Array.isArray(frame[key]) ? frame[key] : [])
    .map(asObject).filter((row): row is Frame => row !== null);
  return { nextAllowedCommands: rows("nextAllowedCommands"), steps: rows("steps") };
}

/** The offer for one command kind, by kind and (optionally) subject. */
export function offerFor(
  surface: SurfaceView, commandKind: string, targetAggregateId?: string,
): Frame {
  const matches = surface.nextAllowedCommands.filter((offer) =>
    offer["commandKind"] === commandKind
    && (targetAggregateId === undefined || offer["targetAggregateId"] === targetAggregateId));
  const only = matches[0];
  if (matches.length !== 1 || only === undefined) {
    throw new Error(`expected exactly one ${commandKind} offer, saw ${String(matches.length)}: `
      + JSON.stringify(surface.nextAllowedCommands.map((offer) => offer["commandKind"])));
  }
  return only;
}

/** One step off the surface by kind and subject; `undefined` when the surface lists none. */
export function stepFor(
  surface: SurfaceView, kind: string, aggregateId: string,
): Frame | undefined {
  return surface.steps.find((step) =>
    step["kind"] === kind && step["aggregateId"] === aggregateId);
}

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { DEV_PAYLOADS, payloadFor } from "../../live/live-dispatch.js";
import {
  AGENT_PROVIDER_COMMAND_KIND, AGENT_PROVIDER_PAYLOAD_ABSENT, KNOWN_PROVIDERS,
  createAgentProviderPort, isKnownProvider,
} from "./agent-provider-port.js";
import type { AgentProviderWire } from "./agent-provider-port.js";

const OFFER = Object.freeze({ commandKind: AGENT_PROVIDER_COMMAND_KIND, expectedVersion: 3 });

function wireRecording(sent: { envelope?: unknown }): AgentProviderWire {
  return {
    client: {
      commands: {
        [AGENT_PROVIDER_COMMAND_KIND]: (
          _affordance: unknown, input: { readonly payload: Readonly<Record<string, unknown>> },
        ) => ({ envelope: { commandId: "cmd-1", payload: input.payload }, ok: true }),
      },
    },
    sessionCredential: "cred-1",
    transport: {
      sendCommand: (envelope: unknown) => {
        sent.envelope = envelope;
        return Promise.resolve({ delivered: true, response: { ok: true } });
      },
    },
  } as unknown as AgentProviderWire;
}

describe("the browser's provider roster is the daemon's", () => {
  it("transcribes KNOWN_PROVIDERS from the daemon's SOURCE TEXT, in the daemon's order", () => {
    // The control room must never IMPORT apps/daemon, so the roster is a copy. Hold it
    // against the daemon's own declaration rather than against a list retyped here: a third
    // provider added on one side alone must red, and the ORDER is load-bearing (the daemon's
    // docblock says claude is named first so a tie is decided there, not in the browser).
    const source = readFileSync(
      resolve(process.cwd(), "..", "daemon", "src", "http", "health-read.ts"), "utf8",
    );
    const body = /export const KNOWN_PROVIDERS = Object\.freeze\(\[(?<names>[^\]]*)\]/u
      .exec(source)?.groups?.["names"];
    if (body === undefined) throw new Error("KNOWN_PROVIDERS not found in apps/daemon/src/http/health-read.ts");
    const declared = [...body.matchAll(/"(?<name>[a-z0-9-]+)"/gu)].map((match) => match.groups?.["name"]);
    expect(declared.length).toBeGreaterThan(0);
    expect(declared).toEqual([...KNOWN_PROVIDERS]);
  });

  it("admits exactly the declared providers", () => {
    for (const provider of KNOWN_PROVIDERS) expect(isKnownProvider(provider)).toBe(true);
    for (const other of ["", "CLAUDE", "gpt", "claude ", "codex-cli"]) {
      expect(isKnownProvider(other)).toBe(false);
    }
  });
});

describe("the toggle dispatches the daemon's kind with the roster's payload", () => {
  it("sends exactly the three keys the daemon's payload gate admits", async () => {
    const sent: { envelope?: unknown } = {};
    const outcome = await createAgentProviderPort(wireRecording(sent)).submit(OFFER, "codex");
    expect(outcome).toEqual({ commandId: "cmd-1", ok: true });
    // The PAYLOAD is the assertion, not that a handler fired: the daemon's registry row
    // admits ["base","goalId","provider"] exactly, and a fourth key or a missing one is
    // refused AGENT_PROVIDER_PAYLOAD_INVALID before any setting is written.
    const payload = (sent.envelope as { readonly payload: Record<string, unknown> }).payload;
    expect(Object.keys(payload).sort()).toEqual(["base", "goalId", "provider"]);
    expect(payload["provider"]).toBe("codex");
    // The project-default sentinel, not a per-goal override.
    expect(payload["goalId"]).toBe("");
  });

  it("overlays ONLY the operator's choice onto the roster body", async () => {
    const sent: { envelope?: unknown } = {};
    await createAgentProviderPort(wireRecording(sent)).submit(OFFER, "claude");
    const payload = (sent.envelope as { readonly payload: Record<string, unknown> }).payload;
    const roster = DEV_PAYLOADS[AGENT_PROVIDER_COMMAND_KIND] as Record<string, unknown>;
    expect(payload["base"]).toBe(roster["base"]);
    expect(payload["goalId"]).toBe(roster["goalId"]);
  });

  it("the payload roster carries this kind, so the port never mints a body", () => {
    // Guards the fail-closed arm below from becoming the production path unnoticed.
    expect(payloadFor(AGENT_PROVIDER_COMMAND_KIND, null)).not.toBeNull();
  });

  it("fails CLOSED, naming its own code, and SENDS NOTHING when the roster carries no body", async () => {
    const sent: { envelope?: unknown } = {};
    const outcome = await createAgentProviderPort(wireRecording(sent), () => null)
      .submit(OFFER, "codex");
    // Refusing is the point: a port that assembled `{base, goalId, provider}` here would be
    // the second source of truth the payload roster exists to prevent, and it would drift
    // silently the day the daemon's payload gate changes.
    expect(outcome).toEqual({
      code: AGENT_PROVIDER_PAYLOAD_ABSENT, layer: "CONTROL_ROOM_AGENT_PROVIDER", ok: false,
    });
    expect(sent.envelope).toBeUndefined();
  });
});

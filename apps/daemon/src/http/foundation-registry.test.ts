import { request as httpRequest } from "node:http";

import { SqliteEventStore } from "@moe/store";
import { afterAll, expect, it, vi } from "vitest";

import { PROJECT_ID } from "../recovery/restore-test-harness.js";
import { readFoundationAttemptRecord } from "../work/foundation-attempt-service.js";
import {
  ACTIVATION_AGGREGATE, CREDENTIAL, DISPATCH_AGGREGATE, cleanupSeamHarnesses, commandRequest,
  dispatchPayload, seamHarness,
} from "./foundation-registry-fixtures.js";
import { ASYNC_ENTRY_REQUIRED_CODE, DAEMON_COMMAND_SEAM } from "./http-async-contract.js";
import { handleAsyncCommandRequest, handleCommandRequest } from "./http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import { startControlRoomListener } from "./http-listener.js";
import { streamPort } from "./event-stream-fixtures.js";

/**
 * The seam fixture now builds a REAL Git repository once per file, because the
 * production composition prepares a workspace before it may launch. That cost
 * lands on the FIRST case, and under full-fleet parallelism it exceeded the 5s
 * default — a slow real operation reading as a hang is a false red.
 */
vi.setConfig({ testTimeout: 30_000 });

/**
 * The async command seam, driven through the PRODUCTION envelope path over a REAL
 * SqliteEventStore and the REAL registry the daemon serves.
 *
 * The physical Claude launch is never replaced: the first dispatch below reaches the
 * shipped launcher and is refused by it, which is what makes the durable record real.
 * The ACCEPTED control is the SECOND dispatch of the same attempt — a replayed
 * reservation adopts the durable record and never launches a second process.
 */

afterAll(cleanupSeamHarnesses);

/**
 * The launch refusal this fixture earns, per platform, and the truth the daemon records
 * for it. Windows reaches the runtime pin over an installed root that does not exist, so
 * the answer is a RUNTIME fault and the attempt is SUSPECT; every other platform is
 * refused by the launcher's explicit platform gate first, which the daemon records as
 * UNKNOWN because an UNSUPPORTED launch proves nothing either way. Both are transcribed
 * from a measured run, and both are the SERVICE's own values rather than the seam's.
 */
const LAUNCH_REFUSAL = process.platform === "win32"
  ? { code: "CLAUDE_RUNTIME_PATH_NOT_FILE", layer: "RUNTIME", truthClass: "SUSPECT" }
  : { code: "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED", layer: "LAUNCHER", truthClass: "UNKNOWN" };

it("dispatches a foundation attempt over a real store and adopts it on replay", async () => {
  const harness = seamHarness("accepted");
  try {
    const first = await handleAsyncCommandRequest(
      harness.deps, commandRequest({ commandId: "cmd-foundation-launch" }));

    // The service's own code and layer, forwarded verbatim: the seam holds no
    // translation table, so a launcher refusal may never read as a seam refusal.
    expect(first).toMatchObject({
      httpStatus: 422, ok: false, outcome: "PORT_REFUSED",
      refusal: { code: LAUNCH_REFUSAL.code, layer: LAUNCH_REFUSAL.layer }, stage: "DISPATCH",
    });

    const reader = SqliteEventStore.openForProject(harness.storePath, PROJECT_ID);
    try {
      // It really dispatched over the store: the activation, the reservation and the
      // single advisory record are all durable facts, not a return value.
      expect(reader.readEvents(ACTIVATION_AGGREGATE).length).toBeGreaterThan(0);
      expect(reader.readEvents(DISPATCH_AGGREGATE)).toHaveLength(2);
      const stored = readFoundationAttemptRecord(reader, ACTIVATION_AGGREGATE);
      expect(stored.ok).toBe(true);
      expect(stored.ok && stored.record).toMatchObject({
        reasonCode: LAUNCH_REFUSAL.code, reasonLayer: LAUNCH_REFUSAL.layer, resultManifest: null,
        truthClass: LAUNCH_REFUSAL.truthClass,
      });
    } finally {
      reader.close();
    }

    const second = await handleAsyncCommandRequest(
      harness.deps, commandRequest({ commandId: "cmd-foundation-adopt" }));

    expect(second).toMatchObject({
      decision: { disposition: "DECIDED", resultCode: "FOUNDATION_ATTEMPT_RECORDED" },
      httpStatus: 200, ok: true, outcome: "ACCEPTED",
    });

    const after = SqliteEventStore.openForProject(harness.storePath, PROJECT_ID);
    try {
      // A replayed reservation NEVER launches again: still exactly one record event.
      expect(after.readEvents(DISPATCH_AGGREGATE)).toHaveLength(2);
    } finally {
      after.close();
    }
  } finally {
    harness.close();
  }
});

it("answers a two-layer-invalid request at the same stage on both entries", async () => {
  const harness = seamHarness("guard-order");
  try {
    // Invalid at AUTHENTICATE and at PAYLOAD_SHAPE at once. Authentication answers
    // first or the daemon parses attacker bytes for a caller it has not identified.
    const hostile = commandRequest({
      credential: "sess-unknown",
      payload: { ...dispatchPayload(), smuggled: true },
    });

    const asynchronous = await handleAsyncCommandRequest(harness.deps, hostile);
    const synchronous = handleCommandRequest(harness.deps, hostile);

    expect(asynchronous.outcome).not.toBe("ACCEPTED");
    expect(asynchronous.ok).toBe(false);
    if (asynchronous.ok || synchronous.ok) return;
    expect(asynchronous.stage).toBe("AUTHENTICATE");
    expect(asynchronous).toStrictEqual(synchronous);
  } finally {
    harness.close();
  }
});

it("refuses an async-only entry on the synchronous entry with a stable code", () => {
  const harness = seamHarness("sync-entry");
  try {
    const result = handleCommandRequest(harness.deps, commandRequest());

    // Not a promise typed as a decision, not a hang: a refusal naming the mismatch.
    expect(result).toMatchObject({
      httpStatus: 422, ok: false, outcome: "PORT_REFUSED",
      refusal: { code: ASYNC_ENTRY_REQUIRED_CODE, layer: DAEMON_COMMAND_SEAM },
      stage: "DISPATCH",
    });
    expect(ASYNC_ENTRY_REQUIRED_CODE).toBe("COMMAND_ASYNC_ENTRY_REQUIRED");
  } finally {
    harness.close();
  }
});

it("serves the async kind over the REAL listener socket, not only in process", async () => {
  const harness = seamHarness("listener");
  const started = await startControlRoomListener({
    csrfToken: "csrf-foundation", deps: harness.deps, subscriptions: streamPort(),
  });
  if (!started.ok) throw new Error(`listener refused to start: ${started.code}`);
  try {
    const body = Buffer.from(commandRequest({ commandId: "cmd-listener-1" }).body as Uint8Array);
    const reply = await new Promise<{ body: Record<string, unknown>; status: number }>(
      (resolve, reject) => {
        const call = httpRequest({
          headers: {
            "content-length": body.byteLength, "content-type": "application/json",
            host: `127.0.0.1:${started.port}`, origin: started.origin,
            "x-moe-csrf": "csrf-foundation", "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
            "x-moe-session-credential": CREDENTIAL,
          },
          host: "127.0.0.1", method: "POST", path: "/command", port: started.port,
          setHost: false,
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
            status: response.statusCode ?? 0,
          }));
        });
        call.on("error", reject);
        call.end(body);
      });

    // DISCRIMINATING: a listener still routing to the synchronous entry would answer
    // COMMAND_ASYNC_ENTRY_REQUIRED here. Reaching the launcher's own code proves the
    // socket path really carried the async dispatch.
    expect(reply.status).toBe(422);
    expect(reply.body).toMatchObject({
      outcome: "PORT_REFUSED",
      refusal: { code: LAUNCH_REFUSAL.code, layer: LAUNCH_REFUSAL.layer },
      stage: "DISPATCH",
    });
  } finally {
    await started.close();
    harness.close();
  }
}, 30_000);

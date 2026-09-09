/**
 * THE BOOT SEAM for `/activation/read`, and the only kind of test that could ever have
 * failed while this defect was live.
 *
 * `createActivationReadPort` shipped with child C and every test of it constructed the port
 * ITSELF, so the whole suite stayed green while the shipped daemon answered HTTP 503
 * `LISTENER_ACTIVATION_UNAVAILABLE` on every request: nothing between the provider and
 * `startControlRoomListener` carried the port. These arms drive the REAL chain — provider
 * factory -> `resolveOptionalDaemonPorts` -> the `daemon-entry` listener spread -> the
 * listener -> `handleActivationReadRequest` — over a real loopback socket, so removing the
 * spread entry, the resolver arm, or the provider factory turns the first arm red.
 */
import { request as httpRequest } from "node:http";

import { expect, it } from "vitest";

import { CAPABILITIES } from "./daemon-command-vocabulary.js";
import { fixtureDependencies } from "./daemon-entry-fixtures.js";
import { startDaemon } from "./daemon-entry.js";
import type { ActivationReadResult } from "./http/activation-read.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import { GOOD_CREDENTIAL, authenticator } from "./http/http-test-fixtures.js";

const CSRF = "activation-entry-csrf";

/** Unmistakably a TEST reader: no production layer spells itself this way. */
const FORWARDED: ActivationReadResult = Object.freeze({
  code: "ACTIVATION_READ_TEST_ONLY", layer: "TEST_READER", outcome: "REFUSED" as const,
});

async function postActivation(
  started: { readonly origin: string; readonly port: number },
  payload: string,
  credential: string = GOOD_CREDENTIAL,
): Promise<{ readonly body: unknown; readonly status: number }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      headers: {
        "content-length": Buffer.byteLength(payload), "content-type": "application/json",
        host: `127.0.0.1:${started.port}`, origin: started.origin,
        "x-moe-csrf": CSRF, "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
        "x-moe-session-credential": credential,
      },
      host: "127.0.0.1", method: "POST", path: "/activation/read", port: started.port,
      setHost: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        status: response.statusCode ?? 0,
      }));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

it("carries the provider's activation reader through the boot seam to the route", async () => {
  const calls = { count: 0 };
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      activation: () => ({
        boundProjectId: "proj-0001",
        readActivation: () => {
          calls.count += 1;
          return Promise.resolve(FORWARDED);
        },
      }),
      provide: () => ({ ...fixtureDependencies(), authenticator: authenticator([CAPABILITIES.ADMIN]) }),
    },
  });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  try {
    // The forwarded body, not merely "not 503": a listener that invented its own answer
    // would still be a 200, and TEST_READER is the proof the PROVIDER's port answered.
    expect(await postActivation(started, "{}")).toEqual({
      body: { code: "ACTIVATION_READ_TEST_ONLY", layer: "TEST_READER", outcome: "REFUSED" },
      status: 200,
    });
    expect(calls.count).toBe(1);
  } finally {
    await started.shutdown();
  }
});

it("refuses the activation route as unavailable when the provider offers no reader", async () => {
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      provide: () => ({ ...fixtureDependencies(), authenticator: authenticator([CAPABILITIES.ADMIN]) }),
    },
  });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  try {
    // The CONTROL for the arm above, and the exact answer the shipped daemon gave at HEAD.
    expect(await postActivation(started, "{}")).toMatchObject({
      body: { code: "LISTENER_ACTIVATION_UNAVAILABLE", layer: "CONTROL_ROOM_LISTENER" },
      status: 503,
    });
  } finally {
    await started.shutdown();
  }
});

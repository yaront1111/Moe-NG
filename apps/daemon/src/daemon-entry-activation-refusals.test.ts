/**
 * THE REFUSAL PLANE AND THE CREDENTIAL CANARY, both driven through the WIRED boot seam.
 *
 * Every arm here goes provider factory -> `resolveOptionalDaemonPorts` -> the `daemon-entry`
 * listener spread -> the listener -> `handleActivationReadRequest`, over a real loopback
 * socket. Asserting a refusal against a directly constructed port would prove the handler is
 * correct and say nothing about the daemon an operator runs — which is exactly how the
 * unwired port shipped green.
 *
 * Each arm asserts the STABLE CODE AND THE LAYER THAT ANSWERED, never merely "it refused":
 * two layers can refuse this route (CONTROL_ROOM_LISTENER for the request shape, ACTIVATION_READ
 * for everything the port owns), so a code without a layer cannot tell you which one spoke.
 */
import { request as httpRequest } from "node:http";

import { expect, it } from "vitest";

import {
  ACTIVATION_RECEIPT_MEMBERS, measuredReceipt, signingReceipt,
} from "./bootstrap/activation-receipts.js";
import type { ActivationReceipts } from "./bootstrap/activation-receipts.js";
import { CAPABILITIES } from "./daemon-command-vocabulary.js";
import { fixtureDependencies } from "./daemon-entry-fixtures.js";
import { startDaemon } from "./daemon-entry.js";
import type { DaemonDependencyProvider } from "./daemon-entry.js";
import { createActivationReadPort } from "./http/activation-read.js";
import type { ActivationReadPort } from "./http/activation-read.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import { GOOD_CREDENTIAL, authenticator } from "./http/http-test-fixtures.js";

const CSRF = "activation-refusal-csrf";
/** The daemon's own project; `http-test-fixtures.principal` authenticates into this one. */
const BOUND_PROJECT = "proj-0001";
/** A held Anthropic token value, planted so the canary can look for it on the wire. */
const CANARY_TOKEN = "sk-ant-canary-must-never-reach-a-screenshot";

async function post(
  started: { readonly origin: string; readonly port: number }, payload: string,
): Promise<{ readonly body: unknown; readonly status: number }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      headers: {
        "content-length": Buffer.byteLength(payload), "content-type": "application/json",
        host: `127.0.0.1:${started.port}`, origin: started.origin,
        "x-moe-csrf": CSRF, "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
        "x-moe-session-credential": GOOD_CREDENTIAL,
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

async function drive(
  dependencies: DaemonDependencyProvider, payload = "{}",
): Promise<{ readonly body: unknown; readonly status: number }> {
  const started = await startDaemon({ csrfToken: CSRF, dependencies });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  try {
    return await post(started, payload);
  } finally {
    await started.shutdown();
  }
}

function provider(
  activation: () => ActivationReadPort, capabilities: readonly string[] = [CAPABILITIES.ADMIN],
): DaemonDependencyProvider {
  return {
    activation,
    provide: () => ({ ...fixtureDependencies(), authenticator: authenticator(capabilities) }),
  };
}

/** A never-called port: the arms below that refuse BEFORE the read must leave it untouched. */
function countingPort(boundProjectId: string, calls: { count: number }): ActivationReadPort {
  return {
    boundProjectId,
    readActivation: () => {
      calls.count += 1;
      return Promise.resolve({ code: "UNREACHED", layer: "TEST_READER", outcome: "REFUSED" });
    },
  };
}

it("refuses a principal without project.admin, and never consults the port", async () => {
  const calls = { count: 0 };
  const answer = await drive(
    provider(() => countingPort(BOUND_PROJECT, calls), [CAPABILITIES.GOAL]),
  );

  expect(answer).toEqual({
    body: {
      code: "ACTIVATION_READ_CAPABILITY_DENIED", layer: "ACTIVATION_READ", outcome: "REFUSED",
    },
    status: 200,
  });
  // NOT DECORATION. The capability gate sits BEFORE the `port === undefined` branch, so this
  // arm would pass on the unwired daemon too. Pinning that the WIRED port was never read is
  // what keeps it a test of this seam rather than a test that passes for the wrong reason.
  expect(calls.count).toBe(0);
});

it("refuses a principal bound to another project, naming the read's own layer", async () => {
  const calls = { count: 0 };
  // Reachable ONLY past the wiring: the mismatch check runs after `port === undefined`, so
  // an unwired daemon answers 503 here instead and this body can never appear.
  const answer = await drive(provider(() => countingPort("proj-somewhere-else", calls)));

  expect(answer).toEqual({
    body: {
      code: "ACTIVATION_READ_PROJECT_MISMATCH", layer: "ACTIVATION_READ", outcome: "REFUSED",
    },
    status: 200,
  });
  expect(calls.count).toBe(0);
});

it("refuses a non-empty body at the LISTENER, not at the read", async () => {
  const calls = { count: 0 };
  const answer = await drive(
    provider(() => countingPort(BOUND_PROJECT, calls)), JSON.stringify({ goalRef: "goal-1" }),
  );

  // A DIFFERENT LAYER answers this one, and that is the point of naming layers at all:
  // the request shape is the listener's business, so CONTROL_ROOM_LISTENER with a 400.
  expect(answer).toEqual({
    body: { code: "LISTENER_ACTIVATION_REQUEST_INVALID", layer: "CONTROL_ROOM_LISTENER" },
    status: 400,
  });
  expect(calls.count).toBe(0);
});

it("turns a throwing measurement into ACTIVATION_READ_UNREADABLE, not a 500", async () => {
  // The REAL production port, so the catch under test is `createActivationReadPort`'s own
  // (activation-read.ts:194-197) rather than a stub that decides to return a refusal.
  const answer = await drive(provider(() => createActivationReadPort({
    input: {
      agentCommand: "claude", artifactRoot: "", projectId: BOUND_PROJECT,
      projectRoot: "", storePath: "",
    },
    measure: () => { throw new Error("measurement exploded"); },
  })));

  expect(answer).toEqual({
    body: { code: "ACTIVATION_READ_UNREADABLE", layer: "ACTIVATION_READ", outcome: "REFUSED" },
    status: 200,
  });
});

/** Receipts whose `repository` reason and ref both carry a held credential value. */
function receiptsLeaking(token: string): ActivationReceipts {
  return Object.freeze({
    distribution: null,
    measuredAt: "2026-09-05T00:00:00.000Z",
    members: Object.freeze(ACTIVATION_RECEIPT_MEMBERS.map((member) => measuredReceipt(
      member,
      `ref/${member}/${token}`,
      `fatal: env ANTHROPIC_AUTH_TOKEN=${token} rejected by remote`,
    ))),
    // The reading is scrubbed on the read route like every other published text, so it carries
    // the same held token these arms hunt for.
    provider: Object.freeze({ command: `claude-${token}`, version: `1.0.0-${token}` }),
    repository: null,
    schemaVersion: "moe-activation-receipts/1" as const,
    signing: signingReceipt(),
    store: null,
  });
}

it("scrubs held credential VALUES out of every reason and ref the wired port publishes", async () => {
  const answer = await drive(provider(() => createActivationReadPort({
    input: {
      agentCommand: "claude", artifactRoot: "", projectId: BOUND_PROJECT,
      projectRoot: "", storePath: "",
    },
    measure: () => Promise.resolve(receiptsLeaking(CANARY_TOKEN)),
    // The daemon HOLDS this token, so `secretValues` must find it and scrub it. A measurement
    // reason is whatever the measurement OBSERVED — a git stderr tail, an OS error string —
    // and this exact shape (`fatal: env ANTHROPIC_AUTH_TOKEN=<token>`) reached the wire
    // verbatim before child C's fence.
    ports: { env: { ANTHROPIC_AUTH_TOKEN: CANARY_TOKEN } },
  })));

  expect(answer.status).toBe(200);
  // THE BYTES THAT LEFT THE PORT, not an internal value: re-serialising the whole response is
  // the only assertion that cannot be satisfied by a scrub applied on one field and missed
  // on another. `backup` is exempt — this route replaces that row wholesale with its own
  // deferred answer, which carries no measured text.
  const wire = JSON.stringify(answer.body);
  expect(wire).not.toContain(CANARY_TOKEN);
  expect(wire).toContain("[redacted]");

  const view = answer.body as {
    readonly members: readonly {
      readonly member: string; readonly reason: string; readonly ref: string | null;
    }[];
    readonly provider: { readonly command: string; readonly version: string } | null;
  };
  // The provider READING is a second published surface, not covered by the member rows: its
  // text is an external CLI's stdout and a host-configured command, so both are scrubbed.
  expect(view.provider)
    .toEqual({ command: "claude-[redacted]", version: "1.0.0-[redacted]" });
  for (const row of view.members.filter((member) => member.member !== "backup")) {
    expect(row.reason).toBe("fatal: env ANTHROPIC_AUTH_TOKEN=[redacted] rejected by remote");
    expect(row.ref).toBe(`ref/${row.member}/[redacted]`);
  }
});

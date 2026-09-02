import { request as httpRequest } from "node:http";

import { expect, it } from "vitest";

import { CAPABILITIES } from "./daemon-command-vocabulary.js";
import { fixtureDependencies } from "./daemon-entry-fixtures.js";
import { startDaemon } from "./daemon-entry.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import { GOOD_CREDENTIAL, authenticator } from "./http/http-test-fixtures.js";

const CSRF = "document-coverage-entry-csrf";

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
      host: "127.0.0.1", method: "POST", path: "/documents/coverage/read",
      port: started.port, setHost: false,
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

it("resolves and forwards the project-bound PRD coverage reader", async () => {
  const seen: unknown[] = [];
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      documentCoverage: () => ({
        boundProjectId: "proj-0001",
        readCoverage: (selector: unknown) => {
          seen.push(selector);
          return { code: "DOCUMENT_COVERAGE_READ_GOAL_UNBOUND", layer: "TEST_READER",
            outcome: "REFUSED" as const };
        },
      }),
      provide: () => ({
        ...fixtureDependencies(),
        authenticator: authenticator([CAPABILITIES.GOAL]),
      }),
    },
  });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  try {
    expect(await post(started, JSON.stringify({ goalRef: "goal-entry" }))).toEqual({
      body: { code: "DOCUMENT_COVERAGE_READ_GOAL_UNBOUND", layer: "TEST_READER", outcome: "REFUSED" },
      status: 200,
    });
    expect(seen).toEqual([{ goalRef: "goal-entry" }]);
  } finally {
    await started.shutdown();
  }
});

it("refuses the coverage route as unavailable when the provider offers no reader", async () => {
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      provide: () => ({
        ...fixtureDependencies(),
        authenticator: authenticator([CAPABILITIES.GOAL]),
      }),
    },
  });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  try {
    expect(await post(started, JSON.stringify({ goalRef: "goal-entry" }))).toMatchObject({
      body: { code: "LISTENER_DOCUMENT_COVERAGE_UNAVAILABLE" }, status: 503,
    });
  } finally {
    await started.shutdown();
  }
});

it("refuses to start on a coverage factory whose port lacks the read method", async () => {
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      documentCoverage: () => ({ boundProjectId: "proj-0001" }) as never,
      provide: () => ({
        ...fixtureDependencies(),
        authenticator: authenticator([CAPABILITIES.GOAL]),
      }),
    },
  });
  expect(started.ok).toBe(false);
  if (started.ok) await started.shutdown();
});

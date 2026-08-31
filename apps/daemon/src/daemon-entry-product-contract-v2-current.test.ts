import { request as httpRequest } from "node:http";

import { expect, it } from "vitest";

import { CAPABILITIES } from "./daemon-command-vocabulary.js";
import { fixtureDependencies } from "./daemon-entry-fixtures.js";
import { startDaemon } from "./daemon-entry.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import { GOOD_CREDENTIAL, authenticator } from "./http/http-test-fixtures.js";

const CSRF = "product-contract-v2-current-entry-csrf";

it("resolves and forwards the project-bound Product Contract /2 current reader", async () => {
  const seen: string[] = [];
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      productContractV2Current: () => ({
        boundProjectId: "proj-0001",
        readCurrent: (contractId: string) => {
          seen.push(contractId);
          return { code: "CURRENT_ABSENT", layer: "TEST_READER", outcome: "REFUSED" as const };
        },
      }),
      provide: () => ({
        ...fixtureDependencies(),
        authenticator: authenticator([CAPABILITIES.PLANNING]),
      }),
      provideV2: () => ({
        ...fixtureDependencies(),
        authenticator: authenticator([CAPABILITIES.PLANNING]),
      }),
    },
  });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  try {
    const payload = JSON.stringify({ contractId: "contract-v2" });
    const reply = await new Promise<{ readonly body: unknown; readonly status: number }>(
      (resolve, reject) => {
        const request = httpRequest({
          headers: {
            "content-length": Buffer.byteLength(payload), "content-type": "application/json",
            host: `127.0.0.1:${started.port}`, origin: started.origin,
            "x-moe-csrf": CSRF, "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
            "x-moe-session-credential": GOOD_CREDENTIAL,
          },
          host: "127.0.0.1", method: "POST", path: "/v2/product-contract/current",
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
      },
    );
    expect(reply).toEqual({
      body: { code: "CURRENT_ABSENT", layer: "TEST_READER", outcome: "REFUSED" },
      status: 200,
    });
    expect(seen).toEqual(["contract-v2"]);
  } finally {
    await started.shutdown();
  }
});

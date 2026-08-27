import { request as httpRequest } from "node:http";

import { expect, it } from "vitest";

import { fixtureDependencies } from "./daemon-entry-fixtures.js";
import { startDaemon } from "./daemon-entry.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";

const CSRF = "goal-catalog-entry-csrf";
const VIEW = Object.freeze({
  goals: Object.freeze([{
    brief: null, goalId: "goal-entry-random", planningRunRef: "run-entry-random",
  }]),
  outcome: "GOALS" as const,
});

it("resolves and forwards the project-bound goal catalog through the daemon entry", async () => {
  const calls: string[] = [];
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      goalCatalog: () => ({
        boundProjectId: "proj-0001",
        readGoals: () => { calls.push("read"); return VIEW; },
      }),
      provide: fixtureDependencies,
    },
  });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  try {
    const payload = "{}";
    const reply = await new Promise<{ readonly body: unknown; readonly status: number }>(
      (resolve, reject) => {
        const request = httpRequest({
          headers: {
            "content-length": Buffer.byteLength(payload), "content-type": "application/json",
            host: `127.0.0.1:${started.port}`, origin: started.origin,
            "x-moe-csrf": CSRF, "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
            "x-moe-session-credential": "sess-good",
          },
          host: "127.0.0.1", method: "POST", path: "/goals/read",
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
    expect(reply).toStrictEqual({ body: VIEW, status: 200 });
    expect(calls).toStrictEqual(["read"]);
  } finally {
    await started.shutdown();
  }
});

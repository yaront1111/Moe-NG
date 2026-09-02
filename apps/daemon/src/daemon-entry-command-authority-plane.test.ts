import { request as httpRequest } from "node:http";

import { expect, it } from "vitest";

import { CAPABILITIES } from "./daemon-command-vocabulary.js";
import { fixtureDependencies } from "./daemon-entry-fixtures.js";
import { startDaemon } from "./daemon-entry.js";
import type { StartedDaemon } from "./daemon-entry.js";
import { authenticator } from "./http/http-test-fixtures.js";

const CSRF = "command-authority-plane-entry-csrf";

function dependencies(): {
  readonly provide: () => ReturnType<typeof fixtureDependencies>;
  readonly provideV2: () => ReturnType<typeof fixtureDependencies>;
} {
  return {
    provide: () => ({
      ...fixtureDependencies(), authenticator: authenticator([CAPABILITIES.PLANNING]),
    }),
    provideV2: () => ({
      ...fixtureDependencies(), authenticator: authenticator([CAPABILITIES.PLANNING]),
    }),
  };
}

async function bootstrap(started: StartedDaemon): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      headers: { host: `127.0.0.1:${started.port}` },
      host: "127.0.0.1", method: "GET", path: "/bootstrap", port: started.port, setHost: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve(
        JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>));
    });
    request.on("error", reject);
    request.end();
  });
}

it("forwards the project-bound plane reader so /bootstrap states the daemon's plane", async () => {
  let reads = 0;
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      ...dependencies(),
      commandAuthorityPlane: () => ({
        boundProjectId: "proj-0001",
        readPlane: () => { reads += 1; return "V2" as const; },
      }),
      sessionHandshake: () => ({
        boundProjectId: "proj-0001",
        mint: () => { throw new Error("bootstrap must not mint"); },
      }),
    },
  });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  try {
    expect(await bootstrap(started)).toEqual({
      commandAuthorityPlane: "V2", csrfToken: CSRF, projectId: "proj-0001",
      protocolVersion: expect.any(String) as string,
    });
    expect(reads).toBe(1);
  } finally {
    await started.shutdown();
  }
});

it("answers V1 when no plane reader is composed", async () => {
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      ...dependencies(),
      sessionHandshake: () => ({
        boundProjectId: "proj-0001",
        mint: () => { throw new Error("bootstrap must not mint"); },
      }),
    },
  });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  try {
    expect((await bootstrap(started))["commandAuthorityPlane"]).toBe("V1");
  } finally {
    await started.shutdown();
  }
});

it("refuses to start on a malformed or throwing plane reader instead of defaulting it", async () => {
  const MALFORMED = Object.freeze([
    { boundProjectId: "proj-0001" },
    { boundProjectId: "", readPlane: () => "V1" as const },
    { boundProjectId: 7, readPlane: () => "V1" as const },
    { readPlane: () => "V1" as const },
  ]);
  expect(MALFORMED).toHaveLength(4);
  for (const port of MALFORMED) {
    const started = await startDaemon({
      csrfToken: CSRF,
      dependencies: { ...dependencies(), commandAuthorityPlane: () => port as never },
    });
    expect(started.ok).toBe(false);
    if (started.ok) { await started.shutdown(); throw new Error("expected refusal"); }
    expect(started.code).toBe("DAEMON_ENTRY_DEPENDENCIES_INVALID");
  }
  const threw = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      ...dependencies(),
      commandAuthorityPlane: () => { throw new Error("reader construction failed"); },
    },
  });
  expect(threw.ok).toBe(false);
  if (threw.ok) { await threw.shutdown(); throw new Error("expected refusal"); }
  expect(threw.code).toBe("DAEMON_ENTRY_PROVIDER_THREW");
});

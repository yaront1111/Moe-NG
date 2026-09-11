import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { startControlRoomListener } from "./http-listener.js";
import {
  authenticator, decisionPort, recordingHandler, registryOf,
} from "./http-test-fixtures.js";

const deps = () => ({
  authenticator: authenticator(),
  decisions: decisionPort(),
  registry: registryOf("goal.create", recordingHandler().handler, ["title"]),
});

it("omits query values from failure logs while preserving the failing route and cause", async () => {
  const lines: string[] = [];
  const listener = await startControlRoomListener({
    csrfToken: "failure-log-csrf",
    deps: deps(),
    log: (line) => { lines.push(line); },
    onRequest: () => { throw new Error("reader unavailable"); },
  });
  if (!listener.ok) throw new Error(listener.code);
  try {
    const response = await fetch(`${listener.origin}/health/read?credential=private-query-value`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "LISTENER_REQUEST_FAILED", layer: "CONTROL_ROOM_LISTENER",
    });
    expect(lines).toEqual(["LISTENER_REQUEST_FAILED GET /health/read Error: reader unavailable"]);
  } finally {
    await listener.close();
  }
});

it("answers failed requests even when the logging sink throws", async () => {
  // A failure in the catch handler is an unhandled rejection under Node's production policy.
  // A child process proves that containment without crashing or changing Vitest's policy.
  const script = `
    import { startControlRoomListener } from ${JSON.stringify(new URL("./http-listener.js", import.meta.url).href)};
    import { authenticator, decisionPort, recordingHandler, registryOf } from ${JSON.stringify(new URL("./http-test-fixtures.ts", import.meta.url).href)};
    const listener = await startControlRoomListener({
      csrfToken: "failure-log-csrf",
      deps: {
        authenticator: authenticator(), decisions: decisionPort(),
        registry: registryOf("goal.create", recordingHandler().handler, ["title"]),
      },
      log: () => { throw new Error("logging sink failed"); },
    });
    if (!listener.ok) throw new Error(listener.code);
    try {
      const responses = [];
      for (let index = 0; index < 2; index++) {
        const response = await fetch(listener.origin + "/command");
        responses.push({ status: response.status, body: await response.json() });
      }
      process.stdout.write(JSON.stringify(responses));
    } finally { await listener.close(); }
  `;
  const result = await promisify(execFile)(process.execPath,
    ["--unhandled-rejections=strict", "--input-type=module", "--eval", script],
    { timeout: 10_000 },
  ).then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code?: unknown; stdout?: string; stderr?: string }) =>
      ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout ?? "null")).toEqual(Array.from({ length: 2 }, () => ({
    status: 500,
    body: { code: "LISTENER_REQUEST_FAILED", layer: "CONTROL_ROOM_LISTENER" },
  })));
});

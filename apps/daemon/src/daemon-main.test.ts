import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, it } from "vitest";

import { runDaemonMain } from "./daemon-main.js";

/**
 * The bin's `--csrf-token` flag must reach the listener: a request presenting the
 * operator-supplied token passes the CSRF gate (and then fails AUTHENTICATION, proving
 * the gate was the thing that passed), while a request without it is refused with the
 * listener's own stable code.
 */

const KNOWN_TOKEN = "dev-csrf-token-1";

const PROVIDER_SOURCE = `export default {
  provide() {
    return {
      authenticator: { authenticate() { return { verdict: "UNAUTHENTICATED" }; } },
      decisions: { decide() { throw new Error("unreachable"); } },
      registry: new Map(),
    };
  },
};
`;

const cleanups: (() => Promise<unknown>)[] = [];

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

it("passes --csrf-token through to the listener gate", async () => {
  const temp = await mkdtemp(join(tmpdir(), "moe-daemon-csrf-"));
  cleanups.push(() => rm(temp, { force: true, recursive: true }));
  const providerPath = join(temp, "provider.mjs");
  await writeFile(providerPath, PROVIDER_SOURCE, "utf8");

  let origin = "";
  let shutdown: (() => Promise<unknown>) | undefined;
  const code = await runDaemonMain(
    [`--dependencies=${providerPath}`, "--port=0", `--csrf-token=${KNOWN_TOKEN}`],
    {
      log: (line) => {
        const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/u.exec(line);
        if (match?.[1] !== undefined) origin = match[1];
      },
      onStarted: (stop) => { shutdown = stop; },
    },
  );
  cleanups.push(async () => shutdown?.());
  expect(code).toBe(0);
  expect(origin).not.toBe("");

  const headers = { "content-type": "application/json", origin, "x-moe-csrf": KNOWN_TOKEN };
  const withToken = await fetch(`${origin}/command`, {
    body: "{}", headers, method: "POST",
  });
  // 401 AUTHENTICATION_FAILED, not 403 LISTENER_CSRF_INVALID: the CSRF gate passed
  // on the flag-supplied token and the next layer answered.
  expect(withToken.status).toBe(401);
  const body = (await withToken.json()) as { error?: { code?: string } };
  expect(body.error?.code).toBe("AUTHENTICATION_FAILED");

  const withoutToken = await fetch(`${origin}/command`, {
    body: "{}", headers: { "content-type": "application/json", origin }, method: "POST",
  });
  expect(withoutToken.status).toBe(403);
  expect(await withoutToken.json()).toMatchObject({ code: "LISTENER_CSRF_INVALID" });
});

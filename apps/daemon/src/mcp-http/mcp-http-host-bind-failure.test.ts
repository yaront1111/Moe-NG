import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { createMcpHttpHost } from "./mcp-http-host.js";

/**
 * THE REFUSAL EVERY SEAT IN THE PROJECT DIES ON.
 *
 * `agent-wrapper-main.ts` throws `new Error(mcpStarted.code)` when this host will not bind, and
 * the wrapper exits before spawning a single seat. The operator saw one token,
 * `MCP_HTTP_HOST_BIND_FAILED`, with no port and no errno — and MOE_MCP_HTTP_PORT makes a fixed-
 * port conflict an ordinary live case, not a hypothetical one.
 *
 * Production wiring, as in `mcp-http-host.test.ts`: a real temp-file store and the real
 * dependencies, because a stubbed host would prove nothing about the shipped bind path.
 */

const CLOCK = (): string => "2026-08-14T00:00:00.000Z";
const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function occupyPort(): Promise<{ close(): Promise<void>; readonly port: number }> {
  const server = createServer();
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve(); }); }),
    port: address.port,
  };
}

it("names the errno and the address when the MCP port is already held", async () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-mcp-bind-"));
  const provider = createStoreDependencies({
    clock: CLOCK,
    credential: "operator-mcp-bind-credential",
    principalId: "operator-local",
    projectId: "project-mcp-bind-1",
    storePath: join(directory, "store.db"),
  });
  cleanups.push(() => {
    provider.close?.();
    rmSync(directory, { force: true, recursive: true });
  });
  const subscriptions = provider.subscriptions?.();
  if (subscriptions === undefined) throw new Error("provider serves no subscription seam");
  const occupied = await occupyPort();

  try {
    const host = createMcpHttpHost({
      deps: provider.provide(),
      port: occupied.port,
      subscriptions,
    });
    const started = await host.start();

    expect(started.ok).toBe(false);
    expect(started).toMatchObject({ code: "MCP_HTTP_HOST_BIND_FAILED" });
    const detail = (started as { readonly detail?: string }).detail ?? "";
    expect(detail).toContain("EADDRINUSE");
    expect(detail).toContain(`127.0.0.1:${String(occupied.port)}`);
    // One line, no stack: this string is printed to an operator, not filed as a record.
    expect(detail).not.toContain("\n");
    expect(detail).not.toContain("at ");
  } finally {
    await occupied.close();
  }
});

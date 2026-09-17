import { createServer } from "node:net";
import { expect, it } from "vitest";

import { startDaemon } from "../daemon-entry.js";
import { fixtureDependencies } from "../daemon-entry-fixtures.js";
import { CONTROL_ROOM_LISTENER_LAYER } from "./http-listener.js";

/**
 * A REFUSAL THAT NAMES THE CAUSE.
 *
 * `moe start` printed exactly `LISTENER_BIND_FAILED CONTROL_ROOM_LISTENER` and exited 1, for a
 * port already held by another daemon, a privileged port, a host that no longer resolves, and
 * any other throw out of `listen` alike. Those demand different actions — stop the other daemon,
 * pick an unprivileged port, fix the host — and the operator could not tell them apart.
 *
 * `refuse` has always accepted a `detail`, and `daemon-main.ts` has always printed it. The bind
 * path simply passed none, and its catch bound nothing to pass.
 */

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

it("names the errno, the syscall and the address a failed bind was refused on", async () => {
  const occupied = await occupyPort();
  try {
    const result = await startDaemon({
      dependencies: { provide: fixtureDependencies },
      port: occupied.port,
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      code: "LISTENER_BIND_FAILED",
      layer: CONTROL_ROOM_LISTENER_LAYER,
    });
    const detail = (result as { readonly detail?: string }).detail ?? "";
    expect(detail).toContain("EADDRINUSE");
    expect(detail).toContain("listen");
    expect(detail).toContain(`127.0.0.1:${String(occupied.port)}`);
  } finally {
    await occupied.close();
  }
});

it("keeps the detail free of anything but the address facts", async () => {
  const occupied = await occupyPort();
  try {
    const result = await startDaemon({
      dependencies: { provide: fixtureDependencies },
      port: occupied.port,
    });

    const detail = (result as { readonly detail?: string }).detail ?? "";

    // One line, so a refusal cannot forge a second line on the operator's console.
    expect(detail).not.toContain("\n");
    // The stack belongs in the diagnostic record, never in the refusal an operator reads.
    expect(detail).not.toContain("at ");
  } finally {
    await occupied.close();
  }
});

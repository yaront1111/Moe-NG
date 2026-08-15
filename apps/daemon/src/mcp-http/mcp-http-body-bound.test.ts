import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";

import { MAX_JSON_BODY_BYTES } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import { MCP_HTTP_BODY_TOO_LARGE, readBoundedNodeBody } from "./mcp-http-body-bound.js";

/** A fake IncomingMessage: an EventEmitter carrying method, headers, and a destroy flag. */
function fakeMessage(method: string, headers: Record<string, string> = {}): IncomingMessage {
  const emitter = new EventEmitter() as EventEmitter & { destroyed: boolean };
  emitter.destroyed = false;
  return Object.assign(emitter, {
    destroy: () => { emitter.destroyed = true; emitter.emit("close"); },
    headers,
    method,
  }) as unknown as IncomingMessage;
}

describe("readBoundedNodeBody", () => {
  it("returns undefined for methods that carry no body", async () => {
    for (const method of ["GET", "HEAD", "DELETE"]) {
      await expect(readBoundedNodeBody(fakeMessage(method))).resolves.toBeUndefined();
    }
  });

  it("assembles a within-bound body verbatim", async () => {
    const message = fakeMessage("POST");
    const done = readBoundedNodeBody(message);
    message.emit("data", Buffer.from("hello "));
    message.emit("data", Buffer.from("world"));
    message.emit("end");
    await expect(done).resolves.toEqual(new Uint8Array(Buffer.from("hello world")));
  });

  it("refuses a declared Content-Length over the cap before reading a byte", async () => {
    const message = fakeMessage("POST", { "content-length": String(MAX_JSON_BODY_BYTES + 1) });
    let read = false;
    message.on("data", () => { read = true; });
    await expect(readBoundedNodeBody(message)).rejects.toThrow(MCP_HTTP_BODY_TOO_LARGE);
    expect(read).toBe(false);
  });

  it("stops buffering and destroys the stream once the cap is passed, never assembling the whole body", async () => {
    // A chunked POST with no Content-Length: the only defense is the running cap.
    const message = fakeMessage("POST");
    const done = readBoundedNodeBody(message);
    const chunk = Buffer.alloc(256 * 1024, 0x61);
    // Five 256KiB chunks = 1.25 MiB > 1 MiB cap; it must reject partway.
    for (let i = 0; i < 5; i += 1) message.emit("data", chunk);
    await expect(done).rejects.toThrow(MCP_HTTP_BODY_TOO_LARGE);
    expect((message as unknown as { destroyed: boolean }).destroyed).toBe(true);
  });

  it("accepts a body exactly at the cap", async () => {
    const message = fakeMessage("POST");
    const done = readBoundedNodeBody(message);
    message.emit("data", Buffer.alloc(MAX_JSON_BODY_BYTES, 0x62));
    message.emit("end");
    const body = await done;
    expect(body?.byteLength).toBe(MAX_JSON_BODY_BYTES);
  });
});

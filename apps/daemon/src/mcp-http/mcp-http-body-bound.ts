import type { IncomingMessage } from "node:http";

import { MAX_JSON_BODY_BYTES } from "@moe/contracts";

/**
 * Bounded body read for the node:http MCP bridge.
 *
 * The adapter enforces the 1 MiB JSON body cap, but only AFTER a Request is
 * built — so a bridge that buffers the whole node stream first has already
 * spent the memory the bound is meant to deny. This reader stops at the cap:
 * an over-large declared Content-Length is refused before a byte is read, and
 * a chunked body with no length is cut off the moment the running total passes
 * the cap, with the socket destroyed so no more arrives. This mirrors
 * `readCappedBytes` in `@moe/mcp`'s web server for the node transport.
 */
export const MCP_HTTP_BODY_TOO_LARGE = "MCP_HTTP_BODY_TOO_LARGE" as const;

/** GET/HEAD/DELETE carry no body; an empty body and no body are distinct to the SDK transport. */
function bodilessMethod(method: string | undefined): boolean {
  return method === "GET" || method === "HEAD" || method === "DELETE";
}

export function readBoundedNodeBody(
  message: IncomingMessage,
): Promise<Uint8Array | undefined> {
  if (bodilessMethod(message.method)) return Promise.resolve(undefined);

  const declared = message.headers["content-length"];
  if (declared !== undefined) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > MAX_JSON_BODY_BYTES) {
      return Promise.reject(new Error(MCP_HTTP_BODY_TOO_LARGE));
    }
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      message.destroy();
      reject(new Error(MCP_HTTP_BODY_TOO_LARGE));
    };
    message.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.byteLength;
      if (total > MAX_JSON_BODY_BYTES) {
        fail();
        return;
      }
      chunks.push(chunk);
    });
    message.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });
    message.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

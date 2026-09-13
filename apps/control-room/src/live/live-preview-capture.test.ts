import { describe, expect, it, vi } from "vitest";

import { captureHeadersOf, createCaptureLoader } from "./live-preview-capture.js";

const HEADERS = Object.freeze({
  "content-type": "application/json",
  "x-moe-csrf": "csrf-1",
  "x-moe-protocol-version": "moe-wire/1",
  "x-moe-session-credential": "cred-1",
});
const URL_PATH = "/preview/capture/goal-1/abc/orders.png";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function answering(status: number, contentType: string, body: BodyInit): FetchMock {
  return vi.fn<typeof fetch>(async () =>
    new Response(body, { headers: { "content-type": contentType }, status }));
}

describe("the capture loader", () => {
  it("GETs the route path with the session headers, and hands back the PNG bytes", async () => {
    const fetchImpl = answering(200, "image/png", PNG);
    const blob = await createCaptureLoader(HEADERS, fetchImpl)(URL_PATH);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(URL_PATH);
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    // THE FENCE THE ROUTE KEEPS: the token and the credential travel as headers, which is
    // exactly what a bare <img src> could never send - and why this loader exists.
    expect(init?.headers).toEqual({
      "x-moe-csrf": "csrf-1", "x-moe-protocol-version": "moe-wire/1",
      "x-moe-session-credential": "cred-1",
    });
    expect(blob).not.toBeNull();
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(PNG);
  });

  it("answers null for a refusal, for a non-image answer, and for a transport fault", async () => {
    const refused = JSON.stringify({ code: "LISTENER_CSRF_INVALID", layer: "CONTROL_ROOM_LISTENER" });
    expect(await createCaptureLoader(HEADERS, answering(403, "application/json", refused))(URL_PATH))
      .toBeNull();
    // A 200 that is not a PNG is not a capture either: the route publishes image/png ALONE.
    expect(await createCaptureLoader(HEADERS, answering(200, "text/html; charset=utf-8", "<html>"))(URL_PATH))
      .toBeNull();
    const failing = vi.fn<typeof fetch>(async () => { throw new TypeError("network down"); });
    expect(await createCaptureLoader(HEADERS, failing)(URL_PATH)).toBeNull();
  });

  it("drops only the JSON content-type from the bundle, case-insensitively, and keeps the rest", () => {
    expect(captureHeadersOf({ ...HEADERS, "Content-Type": "text/plain", "x-extra": "kept" })).toEqual({
      "x-extra": "kept", "x-moe-csrf": "csrf-1", "x-moe-protocol-version": "moe-wire/1",
      "x-moe-session-credential": "cred-1",
    });
    expect(Object.isFrozen(captureHeadersOf(HEADERS))).toBe(true);
  });
});

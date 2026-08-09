import { expect, it } from "vitest";

import { createControlRoomTransport } from "./client-transport.js";
import type { FetchLike } from "./client-transport.js";

const ORIGIN = "http://127.0.0.1:54321";
const CSRF = "csrf-token-for-dossier-test";
const CREDENTIAL = "sess-dossier-0001";
const PROTOCOL = "gated-wire-version";

it("reads the authenticated document dossier with an exact empty request", async () => {
  const calls: Array<{ readonly body: string; readonly headers: Headers;
    readonly method: string; readonly url: string }> = [];
  const dossier = Object.freeze({
    advisoryOnly: true,
    authority: "NONE",
    ok: true,
    outcome: "DOSSIER",
  });
  const fetch: FetchLike = async (input, init) => {
    calls.push({
      body: String(init.body),
      headers: new Headers(init.headers),
      method: init.method ?? "GET",
      url: input,
    });
    return new Response(JSON.stringify(dossier), { status: 200 });
  };
  const transport = createControlRoomTransport({
    csrfToken: CSRF,
    fetch,
    origin: ORIGIN,
    sessionCredential: CREDENTIAL,
    wireProtocolVersion: PROTOCOL,
  });

  const result = await transport.readDocumentDossier();

  const captured = calls[0];
  expect(captured?.method).toBe("POST");
  expect(captured?.url).toBe(`${ORIGIN}/documents/dossier/read`);
  expect(captured?.url).not.toContain(CREDENTIAL);
  expect(captured?.headers.get("x-moe-session-credential")).toBe(CREDENTIAL);
  expect(captured?.headers.get("x-moe-csrf")).toBe(CSRF);
  expect(captured?.headers.get("x-moe-protocol-version")).toBe(PROTOCOL);
  expect(captured?.body).toBe("{}");
  expect(result).toStrictEqual({ delivered: true, response: dossier, status: 200 });
});

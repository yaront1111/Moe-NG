import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { PREVIEW_DOCUMENT_WORK_PROPOSAL } from "../preview/document-preview-data.js";
import { LiveControlRoom } from "./live-app.js";
import type { LiveSetup } from "./live-config.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("attaches the authenticated daemon dossier to the live workspace", async () => {
  let dossierReads = 0;
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
    code: "AFFORDANCE_TEST_EMPTY",
    outcome: "REFUSED",
  }), { status: 200 }));
  const setup: LiveSetup = {
    client: { commands: {} } as never,
    headers: Object.freeze({}),
    ok: true,
    projection: "moe.board",
    sessionCredential: "live-session",
    subscriberId: "control-room-1",
    transport: {
      readDocumentDossier: async () => {
        dossierReads += 1;
        return {
          delivered: true,
          response: {
            advisoryOnly: true,
            aggregateId: "document-work/abc",
            aggregateSequence: 1,
            authority: "NONE",
            committedAt: "2026-08-09T18:00:00.000Z",
            eventId: "document-work-proposal/abc",
            ok: true,
            outcome: "DOSSIER",
            proposal: PREVIEW_DOCUMENT_WORK_PROPOSAL,
          },
          status: 200,
        };
      },
      readEventPage: async () => ({
        code: "TRANSPORT_REQUEST_FAILED",
        delivered: false,
        layer: "CONTROL_ROOM_TRANSPORT",
      }),
      sendCommand: async () => ({
        code: "TRANSPORT_REQUEST_FAILED",
        delivered: false,
        layer: "CONTROL_ROOM_TRANSPORT",
      }),
    },
  };

  render(<LiveControlRoom setup={setup} />);

  await waitFor(() => {
    expect(screen.getByTestId("cr.preview.dossier").getAttribute("data-state")).toBe("READY");
  });
  expect(screen.getByText("stale-port-recovery")).toBeDefined();
  expect(dossierReads).toBe(1);
});

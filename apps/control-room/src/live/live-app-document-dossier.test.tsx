import type { ControlRoomTransport } from "@moe/control-room-client";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { PREVIEW_DOCUMENT_WORK_PROPOSAL } from "../preview/document-preview-data.js";
import { LiveControlRoom } from "./live-app.js";
import type { LiveSetup } from "./live-config.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setupWith(
  readDocumentDossier: ControlRoomTransport["readDocumentDossier"],
): LiveSetup {
  return {
    client: { commands: {} } as never,
    headers: Object.freeze({}),
    ok: true,
    projection: "moe.board",
    sessionCredential: "live-session",
    subscriberId: "control-room-1",
    transport: {
      readDocumentDossier,
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
}

const DOSSIER_ANSWER = Object.freeze({
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
} as const);

it("attaches the authenticated daemon dossier to the live workspace", async () => {
  let dossierReads = 0;
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
    code: "AFFORDANCE_TEST_EMPTY",
    outcome: "REFUSED",
  }), { status: 200 }));
  const setup = setupWith(async () => {
    dossierReads += 1;
    return DOSSIER_ANSWER;
  });

  render(<LiveControlRoom setup={setup} />);

  await waitFor(() => {
    expect(screen.getByTestId("cr.preview.dossier").getAttribute("data-state")).toBe("READY");
  });
  expect(screen.getByText("stale-port-recovery")).toBeDefined();
  expect(dossierReads).toBe(1);
});

it("marks canonical destinations unavailable in the single live workspace", () => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
    code: "AFFORDANCE_TEST_EMPTY",
    outcome: "REFUSED",
  }), { status: 200 }));

  render(<LiveControlRoom setup={setupWith(async () => DOSSIER_ANSWER)} />);

  const destinations = screen.getAllByRole("button", {
    name: /^(Approvals|Goals|Health|Policy|Resources|Runs & leases)$/u,
  });
  expect(destinations).toHaveLength(6);
  for (const destination of destinations) {
    expect((destination as HTMLButtonElement).disabled).toBe(true);
    expect(destination.getAttribute("aria-current")).toBeNull();
  }
  expect(screen.getByText("The live attachment is a single daemon workspace."))
    .toBeDefined();
});

it("never commits the previous setup's dossier under a replacement setup", async () => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
    code: "AFFORDANCE_TEST_EMPTY",
    outcome: "REFUSED",
  }), { status: 200 }));
  const first = setupWith(async () => DOSSIER_ANSWER);
  const pending = new Promise<never>(() => undefined);
  const second = setupWith(async () => await pending);
  const committedStates: Array<string | null> = [];
  function Observer({ setup }: { readonly setup: LiveSetup }) {
    useLayoutEffect(() => {
      committedStates.push(document.querySelector("[data-testid='cr.preview.dossier']")
        ?.getAttribute("data-state") ?? null);
    }, [setup]);
    return <LiveControlRoom setup={setup} />;
  }
  const { rerender } = render(<Observer setup={first} />);
  await waitFor(() => {
    expect(screen.getByTestId("cr.preview.dossier").getAttribute("data-state")).toBe("READY");
  });

  committedStates.length = 0;
  rerender(<Observer setup={second} />);

  expect(committedStates).toStrictEqual(["LOADING"]);
});

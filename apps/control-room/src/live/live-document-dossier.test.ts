import type { SendResult } from "@moe/control-room-client";
import { describe, expect, it } from "vitest";

import { PREVIEW_DOCUMENT_WORK_PROPOSAL } from "../preview/document-preview-data.js";
import {
  LIVE_DOCUMENT_DOSSIER_LOADING,
  createLiveDocumentDossierFeed,
  mapDocumentDossierAnswer,
} from "./live-document-dossier.js";

const DOSSIER = Object.freeze({
  advisoryOnly: true,
  aggregateId: "document-work/abc",
  aggregateSequence: 1,
  authority: "NONE",
  committedAt: "2026-08-09T18:00:00.000Z",
  eventId: "document-work-proposal/abc",
  ok: true,
  outcome: "DOSSIER",
  proposal: PREVIEW_DOCUMENT_WORK_PROPOSAL,
});

function delivered(response: unknown, status = 200): SendResult {
  return Object.freeze({ delivered: true, response, status });
}

describe("live document dossier mapping", () => {
  it("maps an exact daemon dossier through the public proposal adapter", () => {
    const state = mapDocumentDossierAnswer(delivered(DOSSIER));

    expect(state).toMatchObject({
      dossierIdentity: DOSSIER.eventId,
      origin: "DAEMON",
      status: "READY",
    });
    if (state.status !== "READY") throw new Error("expected a ready daemon dossier");
    expect(state.proposal).toEqual(PREVIEW_DOCUMENT_WORK_PROPOSAL);
    expect(Object.isFrozen(state.proposal)).toBe(true);
  });

  it("preserves service and transport refusal identities without inventing a dossier", () => {
    expect(mapDocumentDossierAnswer(delivered({
      advisoryOnly: true,
      authority: "NONE",
      code: "DOCUMENT_WORK_DOSSIER_MISSING",
      layer: "DAEMON_READ_MODEL",
      ok: false,
      outcome: "REFUSED",
    }))).toStrictEqual({
      advisoryOnly: true,
      authority: "NONE",
      code: "DOCUMENT_WORK_DOSSIER_MISSING",
      layer: "DAEMON_READ_MODEL",
      status: "ERROR",
    });
    expect(mapDocumentDossierAnswer({
      code: "TRANSPORT_REQUEST_FAILED",
      delivered: false,
      layer: "CONTROL_ROOM_TRANSPORT",
    })).toStrictEqual({
      advisoryOnly: true,
      authority: "NONE",
      code: "TRANSPORT_REQUEST_FAILED",
      layer: "CONTROL_ROOM_TRANSPORT",
      status: "ERROR",
    });
  });

  it.each([
    ["wrong authority", { ...DOSSIER, authority: "TASK_WRITE" }],
    ["extra response field", { ...DOSSIER, extra: true }],
    ["duplicate source binding", {
      ...DOSSIER,
      proposal: {
        ...PREVIEW_DOCUMENT_WORK_PROPOSAL,
        sources: [
          PREVIEW_DOCUMENT_WORK_PROPOSAL.sources[0],
          PREVIEW_DOCUMENT_WORK_PROPOSAL.sources[0],
        ],
      },
    }],
    ["unbound citation", {
      ...DOSSIER,
      proposal: {
        ...PREVIEW_DOCUMENT_WORK_PROPOSAL,
        candidates: [{
          ...PREVIEW_DOCUMENT_WORK_PROPOSAL.candidates[0],
          sourceRefs: ["missing-source"],
        }],
      },
    }],
  ] as const)("refuses a malformed %s", (_label, response) => {
    expect(mapDocumentDossierAnswer(delivered(response))).toMatchObject({
      advisoryOnly: true,
      authority: "NONE",
      status: "ERROR",
    });
  });
});

it("ignores an in-flight dossier answer after the feed stops", async () => {
  let answer: ((result: SendResult) => void) | undefined;
  const pending = new Promise<SendResult>((resolve) => { answer = resolve; });
  const states: unknown[] = [];
  const feed = createLiveDocumentDossierFeed({
    intervalMs: 10_000,
    onState: (state) => states.push(state),
    transport: { readDocumentDossier: async () => await pending },
  });

  feed.start();
  expect(states).toStrictEqual([LIVE_DOCUMENT_DOSSIER_LOADING]);
  feed.stop();
  answer?.(delivered(DOSSIER));
  await pending;
  await Promise.resolve();

  expect(states).toStrictEqual([LIVE_DOCUMENT_DOSSIER_LOADING]);
});

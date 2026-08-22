import type { SendResult } from "@moe/control-room-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PREVIEW_DOCUMENT_WORK_PROPOSAL } from "../preview/document-preview-data.js";
import {
  LIVE_DOCUMENT_DOSSIER_LOADING,
  createLiveDocumentDossierFeed,
  mapDocumentDossierAnswer,
} from "./live-document-dossier.js";

afterEach(() => { vi.useRealTimers(); });

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

  it("carries the authenticator's PORT_REFUSED frame out at its stage layer", () => {
    // A credential valid at handshake time but later revoked/expired: the
    // authenticator answers PORT_REFUSED, distinct in shape from the adapter REFUSED.
    expect(mapDocumentDossierAnswer(delivered({
      httpStatus: 401,
      ok: false,
      outcome: "PORT_REFUSED",
      refusal: { code: "SESSION_CREDENTIAL_REVOKED" },
      stage: "AUTHENTICATE",
    }, 401))).toStrictEqual({
      advisoryOnly: true,
      authority: "NONE",
      code: "SESSION_CREDENTIAL_REVOKED",
      layer: "AUTHENTICATE",
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

it("does not reset live disclosure state for an unchanged durable dossier", async () => {
  vi.useFakeTimers();
  let reads = 0;
  const states: unknown[] = [];
  const feed = createLiveDocumentDossierFeed({
    intervalMs: 10,
    onState: (state) => states.push(state),
    transport: {
      readDocumentDossier: async () => {
        reads += 1;
        return delivered({ ...DOSSIER, proposal: { ...PREVIEW_DOCUMENT_WORK_PROPOSAL } });
      },
    },
  });

  feed.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(states).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(10);

  expect(reads).toBe(2);
  expect(states).toHaveLength(2);
  feed.stop();
});

it("refuses changed proposal content rebound to the same durable event identity", async () => {
  vi.useFakeTimers();
  let reads = 0;
  const states: Array<{ readonly code?: string; readonly status: string }> = [];
  const feed = createLiveDocumentDossierFeed({
    intervalMs: 10,
    onState: (state) => states.push(state),
    transport: {
      readDocumentDossier: async () => {
        reads += 1;
        return delivered(reads === 1 ? DOSSIER : {
          ...DOSSIER,
          proposal: { ...PREVIEW_DOCUMENT_WORK_PROPOSAL, projectId: "rebound-project" },
        });
      },
    },
  });

  feed.start();
  await vi.advanceTimersByTimeAsync(10);

  expect(states.at(-1)).toMatchObject({
    code: "DOCUMENT_DOSSIER_IDENTITY_REBOUND",
    status: "ERROR",
  });
  feed.stop();
});

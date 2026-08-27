import { createHash } from "node:crypto";

import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import { MAX_DOCUMENT_INGEST_TEXT_UTF8_BYTES } from "./document-source-contract.js";
import {
  documentSourceAggregateId,
  documentSourceRef,
} from "./document-source-identifiers.js";
import { ingestDocument } from "./document-ingest.js";
import { documentWorkAggregateId } from "./document-work-identifiers.js";
import { readLatestDocumentWorkDossier } from "./document-work-read.js";

const PROJECT_ID = "project-1";
const PRINCIPAL = "operator-1";

function openStore(): SqliteEventStore {
  return SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
}

function sha256Of(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function ingest(
  store: SqliteEventStore,
  payload: unknown,
  overrides: { readonly correlationId?: string; readonly decidedAt?: string } = {},
): ReturnType<typeof ingestDocument> {
  return ingestDocument(store, {
    correlationId: overrides.correlationId ?? "ingest-correlation-1",
    decidedAt: overrides.decidedAt ?? "2026-08-22T12:00:00.000Z",
    payload,
    principalId: PRINCIPAL,
    projectId: PROJECT_ID,
  });
}

const MARKDOWN = "# Build the widget\n\nAn operator dropped this PRD in the browser.\n";

describe("operator document ingest", () => {
  it("computes the sha itself and records a source-bound provisional proposal", () => {
    const store = openStore();
    try {
      const result = ingest(store, {
        displayPath: "docs/prd.md", mediaType: "text/markdown", text: MARKDOWN,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("ingest was refused");

      const expectedSha = sha256Of(MARKDOWN);
      const expectedBytes = Buffer.byteLength(MARKDOWN, "utf8");
      const expectedSourceRef = documentSourceRef(
        expectedSha, "docs/prd.md", "text/markdown",
      );
      expect(result.contentSha256).toBe(expectedSha);
      expect(result.byteLength).toBe(expectedBytes);
      expect(result.disposition).toBe("DECIDED");
      expect(result.sourceDisposition).toBe("DECIDED");

      expect(result.proposal.sources).toHaveLength(1);
      expect(result.proposal.sources[0]).toStrictEqual({
        byteLength: expectedBytes,
        contentSha256: expectedSha,
        displayPath: "docs/prd.md",
        sourceRef: expectedSourceRef,
      });
      expect(result.proposal.candidates).toHaveLength(1);
      expect(result.proposal.candidates[0]?.title).toBe("Build the widget");
      expect(result.proposal.candidates[0]?.sourceRefs).toStrictEqual([expectedSourceRef]);
      expect(result.proposal.truthClass).toBe("AGENT_REPORTED");
      expect(result.proposal.authority).toBe("NONE");
    } finally {
      store.close();
    }
  });

  it("ignores a caller digest: the recorded sha is the daemon's own", () => {
    const store = openStore();
    try {
      // A caller-supplied digest is not even an admitted key; the payload allow-list drops it
      // and the daemon still records the true sha of the text.
      const result = ingest(store, {
        contentSha256: "f".repeat(64),
        displayPath: "docs/prd.md",
        mediaType: "text/plain",
        text: "plain body",
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("an unlisted key must refuse at payload shape");
      expect({ code: result.code, layer: result.layer }).toStrictEqual({
        code: "DOCUMENT_WORK_INGEST_PAYLOAD_INVALID", layer: "DAEMON_INGRESS",
      });
    } finally {
      store.close();
    }
  });

  it("carries an operator objective onto the provisional candidate", () => {
    const store = openStore();
    try {
      const result = ingest(store, {
        displayPath: "notes.txt",
        mediaType: "text/plain",
        objective: "Ship the widget behind a flag.",
        text: "First line\nsecond line",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("ingest was refused");
      expect(result.proposal.candidates[0]?.objective).toBe("Ship the widget behind a flag.");
      expect(result.proposal.candidates[0]?.title).toBe("First line");
    } finally {
      store.close();
    }
  });

  it("re-ingesting identical bytes replays: no second event, same ids", () => {
    const store = openStore();
    try {
      const payload = { displayPath: "docs/prd.md", mediaType: "text/markdown", text: MARKDOWN };
      const first = ingest(store, payload);
      const second = ingest(store, payload, {
        correlationId: "ingest-correlation-2", decidedAt: "2026-08-22T13:00:00.000Z",
      });
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) throw new Error("ingest was refused");

      expect([first.disposition, second.disposition]).toStrictEqual(["DECIDED", "REPLAYED"]);
      expect(second.sourceDisposition).toBe("REPLAYED");
      expect(second.contentSha256).toBe(first.contentSha256);
      expect(second.proposalEventId).toBe(first.proposalEventId);
      expect(second.sourceEventId).toBe(first.sourceEventId);

      expect(store.readEvents(documentWorkAggregateId(PROJECT_ID))).toHaveLength(1);
      expect(store.readEvents(documentSourceAggregateId(
        PROJECT_ID, first.contentSha256, first.proposal.sources[0]?.sourceRef,
      )))
        .toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("records identical brief bytes for two goal-specific display paths without collision", () => {
    const store = openStore();
    try {
      const first = ingest(store, {
        displayPath: "moe-goals/goal-one/intake.md",
        mediaType: "text/markdown",
        text: MARKDOWN,
      }, { correlationId: "goal-one" });
      const second = ingest(store, {
        displayPath: "moe-goals/goal-two/intake.md",
        mediaType: "text/markdown",
        text: MARKDOWN,
      }, { correlationId: "goal-two", decidedAt: "2026-08-22T13:00:00.000Z" });
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) throw new Error("goal brief ingest was refused");

      expect([first.disposition, second.disposition]).toStrictEqual(["DECIDED", "DECIDED"]);
      expect([first.sourceDisposition, second.sourceDisposition])
        .toStrictEqual(["DECIDED", "DECIDED"]);
      expect(second.contentSha256).toBe(first.contentSha256);
      expect(second.proposalEventId).not.toBe(first.proposalEventId);
      expect(second.sourceAggregateId).not.toBe(first.sourceAggregateId);
      expect(second.sourceEventId).not.toBe(first.sourceEventId);
      expect(store.readEvents(documentWorkAggregateId(PROJECT_ID))).toHaveLength(2);

      const dossier = readLatestDocumentWorkDossier(store, PROJECT_ID);
      expect(dossier.ok).toBe(true);
      if (!dossier.ok) throw new Error("dossier read was refused");
      expect(dossier.proposal.sources[0]?.displayPath)
        .toBe("moe-goals/goal-two/intake.md");
      expect(dossier.source?.displayPath).toBe("moe-goals/goal-two/intake.md");
    } finally {
      store.close();
    }
  });

  it("replays an earlier document even after a later one advanced the shared aggregate", () => {
    const store = openStore();
    try {
      const docA = { displayPath: "a.md", mediaType: "text/markdown", text: "# Alpha\n" };
      const docB = { displayPath: "b.md", mediaType: "text/markdown", text: "# Bravo\n" };
      const firstA = ingest(store, docA);
      ingest(store, docB, { correlationId: "c-b" });
      const replayA = ingest(store, docA, { correlationId: "c-a2" });
      expect(firstA.ok && replayA.ok).toBe(true);
      if (!firstA.ok || !replayA.ok) throw new Error("ingest was refused");
      expect(replayA.disposition).toBe("REPLAYED");
      expect(replayA.proposalEventId).toBe(firstA.proposalEventId);
      // Two documents, two proposal events on the shared aggregate; A wrote exactly once.
      expect(store.readEvents(documentWorkAggregateId(PROJECT_ID))).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("refuses an over-size text by its own code before any mutation", () => {
    const store = openStore();
    try {
      const big = "a".repeat(MAX_DOCUMENT_INGEST_TEXT_UTF8_BYTES + 1);
      const result = ingest(store, {
        displayPath: "big.txt", mediaType: "text/plain", text: big,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("over-size text must refuse");
      expect({ code: result.code, layer: result.layer }).toStrictEqual({
        code: "DOCUMENT_WORK_INGEST_TEXT_TOO_LARGE", layer: "DAEMON_INGRESS",
      });
      expect(store.readEventsAfter(0n).items).toStrictEqual([]);
    } finally {
      store.close();
    }
  });

  it.each([
    ["unsupported media type", { displayPath: "x.md", mediaType: "text/html", text: "hi" },
      "DOCUMENT_WORK_INGEST_MEDIA_TYPE_UNSUPPORTED"],
    ["an extra key", { displayPath: "x.md", mediaType: "text/plain", text: "hi", extra: 1 },
      "DOCUMENT_WORK_INGEST_PAYLOAD_INVALID"],
    ["a missing key", { displayPath: "x.md", mediaType: "text/plain" },
      "DOCUMENT_WORK_INGEST_PAYLOAD_INVALID"],
    ["an empty text", { displayPath: "x.md", mediaType: "text/plain", text: "" },
      "DOCUMENT_WORK_INGEST_PAYLOAD_INVALID"],
    ["a newline in the display path",
      { displayPath: "a\nb", mediaType: "text/plain", text: "hi" },
      "DOCUMENT_WORK_INGEST_PAYLOAD_INVALID"],
  ] as const)("refuses %s at the payload shape and writes nothing", (_label, payload, code) => {
    const store = openStore();
    try {
      const result = ingest(store, payload);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("malformed payload must refuse");
      expect({ code: result.code, layer: result.layer }).toStrictEqual({
        code, layer: "DAEMON_INGRESS",
      });
      expect(store.readEventsAfter(0n).items).toStrictEqual([]);
    } finally {
      store.close();
    }
  });

  it("dossier read returns the daemon sha and a bounded excerpt of the latest ingest", () => {
    const store = openStore();
    try {
      ingest(store, { displayPath: "old.md", mediaType: "text/markdown", text: "# Old\n" });
      const latest = ingest(store, {
        displayPath: "docs/prd.md", mediaType: "text/markdown", text: MARKDOWN,
      }, { correlationId: "c-latest" });
      expect(latest.ok).toBe(true);
      if (!latest.ok) throw new Error("ingest was refused");

      const dossier = readLatestDocumentWorkDossier(store, PROJECT_ID);
      expect(dossier.ok).toBe(true);
      if (!dossier.ok) throw new Error("dossier read was refused");
      expect(dossier.proposal.sources[0]?.contentSha256).toBe(latest.contentSha256);
      expect(dossier.source).toStrictEqual({
        byteLength: Buffer.byteLength(MARKDOWN, "utf8"),
        contentSha256: latest.contentSha256,
        displayPath: "docs/prd.md",
        excerpt: MARKDOWN,
        excerptTruncated: false,
        mediaType: "text/markdown",
      });
    } finally {
      store.close();
    }
  });
});

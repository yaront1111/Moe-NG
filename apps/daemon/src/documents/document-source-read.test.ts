import { createHash } from "node:crypto";

import { SqliteEventStore } from "@moe/store";
import type { CursorPage, StoredEvent } from "@moe/store";
import { describe, expect, it } from "vitest";

import { DOCUMENT_SOURCE_SCHEMA_VERSION } from "./document-source-contract.js";
import { documentSourceAggregateId } from "./document-source-identifiers.js";
import { readDocumentSourceView } from "./document-source-read.js";
import { ingestDocument } from "./document-ingest.js";
import { readLatestDocumentWorkDossier } from "./document-work-read.js";
import { recordDocumentWorkProposal } from "./document-work-service.js";
import { input } from "./document-work-service-test-fixtures.js";

const PROJECT_ID = "project-1";
const encoder = new TextEncoder();

function sha256Of(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

describe("dossier source read", () => {
  it("reports ABSENT for a sha with no stored text", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      expect(readDocumentSourceView(store, PROJECT_ID, "a".repeat(64)))
        .toStrictEqual({ kind: "ABSENT" });
    } finally {
      store.close();
    }
  });

  it("leaves an agent-authored dossier (no ingested text) without a source", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      recordDocumentWorkProposal(store, input());
      const dossier = readLatestDocumentWorkDossier(store, PROJECT_ID);
      expect(dossier.ok).toBe(true);
      if (!dossier.ok) throw new Error("dossier read was refused");
      expect("source" in dossier).toBe(false);
    } finally {
      store.close();
    }
  });

  it("fails closed when stored text does not content-address to its sha", () => {
    const real = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      const text = "# Real document\n";
      const ingested = ingestDocument(real, {
        correlationId: "c-1", decidedAt: "2026-08-22T12:00:00.000Z",
        payload: { displayPath: "d.md", mediaType: "text/markdown", text },
        principalId: "operator-1", projectId: PROJECT_ID,
      });
      expect(ingested.ok).toBe(true);
      if (!ingested.ok) throw new Error("ingest was refused");
      const sha = ingested.contentSha256;
      const sourceAggregateId = documentSourceAggregateId(PROJECT_ID, sha);

      // An INTERNALLY CONSISTENT record for different text (it hashes to its own declared sha),
      // stored under the aggregate the proposal's sha keys. The codec admits it; only the read's
      // binding of the stored text to the sha the proposal NAMES can catch the substitution.
      const otherText = "# A completely different document\n";
      const tampered = encoder.encode(JSON.stringify({
        byteLength: Buffer.byteLength(otherText, "utf8"),
        contentSha256: sha256Of(otherText),
        displayPath: "d.md",
        mediaType: "text/markdown",
        schemaVersion: DOCUMENT_SOURCE_SCHEMA_VERSION,
        text: otherText,
      }));
      const tamperingStore = {
        commitExpectedVersionDecision: real.commitExpectedVersionDecision.bind(real),
        getAggregateVersion: real.getAggregateVersion.bind(real),
        getCommandDecision: real.getCommandDecision.bind(real),
        readAggregateEvents: (
          aggregateId: string, afterSequence: number, limit: number, maxBytes?: number,
        ): CursorPage<StoredEvent, number> => {
          const page = real.readAggregateEvents(aggregateId, afterSequence, limit, maxBytes);
          if (aggregateId !== sourceAggregateId) return page;
          return {
            ...page,
            items: page.items.map((event) => ({ ...event, payload: tampered })),
          } as unknown as CursorPage<StoredEvent, number>;
        },
      } as unknown as Parameters<typeof readLatestDocumentWorkDossier>[0];

      const dossier = readLatestDocumentWorkDossier(tamperingStore, PROJECT_ID);
      expect(dossier).toStrictEqual({
        advisoryOnly: true,
        authority: "NONE",
        code: "DOCUMENT_WORK_DOSSIER_SOURCE_INVALID",
        layer: "DAEMON_READ_MODEL",
        ok: false,
        outcome: "REFUSED",
      });

      // sanity: the untampered read still yields the view
      expect(readDocumentSourceView(real, PROJECT_ID, sha).kind).toBe("VIEW");
    } finally {
      real.close();
    }
  });
});

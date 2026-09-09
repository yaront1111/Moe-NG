import { createHash } from "node:crypto";

import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import { MAX_DOCUMENT_INGEST_TEXT_UTF8_BYTES } from "./document-source-contract.js";
import {
  documentSourceAggregateId,
  documentSourceRef,
} from "./document-source-identifiers.js";
import { ingestDocument } from "./document-ingest.js";
import {
  admitDocumentSource,
  currentDocumentSourceRef,
  documentSourceLegOf,
  documentSourceRecordOf,
} from "./document-source-leg.js";
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

  // task-fc42ae5e: SINGLE-AUTHORITY PROOF. The goal.create bind path may not re-derive the
  // source identity; it composes the same exported derivation ingestDocument itself records.
  // Asserted against the DURABLE bytes, not against a value this test computed, so a drift
  // between the export and the ingest route reds here rather than silently binding a goal to
  // an aggregate nobody else can find.
  it("task-fc42ae5e: the exported derivation is byte-identical to what ingestDocument records", () => {
    const store = openStore();
    try {
      const payload = {
        displayPath: "docs/prd.md", mediaType: "text/markdown", text: MARKDOWN,
      };
      const result = ingest(store, payload);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("ingest was refused");

      const admitted = admitDocumentSource(payload);
      if ("refusal" in admitted) throw new Error(`admission refused: ${admitted.refusal.code}`);
      const record = documentSourceRecordOf(admitted.value);
      const leg = documentSourceLegOf(PROJECT_ID, record, currentDocumentSourceRef(record));

      // Anchor the derivation OUTSIDE the module under test first. Comparing the export to
      // ingestDocument alone is a fixed point: both compose documentSourceLegOf, so a mutation
      // inside it moves both sides and the comparison stays green. The identifiers module is the
      // independent authority, so these two assertions are what a derivation mutant reds on.
      const expectedRef = documentSourceRef(sha256Of(MARKDOWN), "docs/prd.md", "text/markdown");
      expect(currentDocumentSourceRef(record)).toBe(expectedRef);
      expect(leg.aggregateId).toBe(
        documentSourceAggregateId(PROJECT_ID, sha256Of(MARKDOWN), expectedRef),
      );

      expect(leg.aggregateId).toBe(result.sourceAggregateId);
      expect(leg.eventId).toBe(result.sourceEventId);
      expect(record.contentSha256).toBe(result.contentSha256);
      expect(record.byteLength).toBe(result.byteLength);

      const page = store.readAggregateEvents(leg.aggregateId, 0, 10);
      expect(page.items).toHaveLength(1);
      const durable = page.items[0];
      if (durable === undefined) throw new Error("no durable source event");
      expect(Buffer.from(durable.payload).equals(Buffer.from(leg.payload))).toBe(true);
      expect(durable.eventId).toBe(leg.eventId);
    } finally {
      store.close();
    }
  });

  // task-fc42ae5e: the exported admitter is the ONLY parser of an operator source object, so a
  // caller cannot smuggle a binding field past it. Asserts the code AND the refusing layer.
  it("task-fc42ae5e: the exported admitter refuses a caller-supplied source binding", () => {
    const hostile = admitDocumentSource({
      displayPath: "docs/prd.md",
      mediaType: "text/markdown",
      sourceRef: "source:attacker-chosen",
      text: MARKDOWN,
    });
    if (!("refusal" in hostile)) throw new Error("hostile extra key was admitted");
    expect(hostile.refusal.code).toBe("DOCUMENT_WORK_INGEST_PAYLOAD_INVALID");
    expect(hostile.refusal.layer).toBe("DAEMON_INGRESS");
  });
});

describe("operator ingest after goal.create_with_source bound the same document", () => {
  it("ingests the PRD the goal binding already landed, instead of refusing EXPECTED_VERSION_CONFLICT forever", async () => {
    const fixtures = await import("../bootstrap/bootstrap-test-fixtures.js");
    const store = fixtures.openStore();
    try {
      fixtures.driveThrough(store, "goal.create");
      const source = { displayPath: "docs/prd.md", mediaType: "text/markdown", text: MARKDOWN };
      const bound = fixtures.send(store, fixtures.envelope("goal.create_with_source", 0, {
        instructions: "Build it.", source, title: "Bound goal",
      }, fixtures.GOAL_CREATE_COMMAND_ID));
      if (!bound.ok) throw new Error(`goal bind refused: ${bound.code}`);

      // The goal binding leg appended the content-addressed source at version 1 under the goal's
      // own decision key. The ingest used to present expectedVersion 0 against it, refuse
      // EXPECTED_VERSION_CONFLICT, persist the refusal row and replay it on every retry.
      const first = ingestDocument(store, {
        correlationId: "ingest-after-goal", decidedAt: "2026-09-05T12:00:00.000Z",
        payload: source, principalId: "operator-local", projectId: fixtures.PROJECT_ID,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("ingest was refused");
      expect(first.contentSha256).toBe(sha256Of(MARKDOWN));
      expect(first.disposition).toBe("DECIDED");

      const again = ingestDocument(store, {
        correlationId: "ingest-after-goal", decidedAt: "2026-09-05T12:00:00.000Z",
        payload: source, principalId: "operator-local", projectId: fixtures.PROJECT_ID,
      });
      expect(again.ok).toBe(true);
      if (!again.ok) throw new Error("re-ingest was refused");
      expect(again.disposition).toBe("REPLAYED");
    } finally {
      fixtures.closeStores();
    }
  });
});

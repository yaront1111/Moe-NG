import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { describe, expect, it } from "vitest";

import { SqliteEventStore } from "@moe/store";

import {
  COORDINATION_ENVELOPE_KINDS, COORDINATION_LIMITS, coordinationCapability,
  createCoordinationService, createDurableMailbox,
} from "./index.js";
import type {
  CoordinationAccepted, CoordinationAddress, CoordinationDelivery, CoordinationEnvelopeKind,
  CoordinationReadResult, CoordinationRefused, CoordinationSendResult, CoordinationService,
} from "./index.js";

const NOW = 1_800_000_000_000;
const PROJECT = "moe-coordination-durable";
const TRANSPORT = "transport-integration";
const PRESENTATION = Object.freeze({ proofMaterial: "never-stored-secret" });
const CODER: CoordinationAddress = Object.freeze({
  effectId: null, role: "CODER", sessionId: "session-coder",
});
const REVIEWER: CoordinationAddress = Object.freeze({
  effectId: null, role: "REVIEWER", sessionId: "session-reviewer",
});

interface Controls {
  authAnswer: null | (() => unknown);
  now: number;
  sessionId: string;
}

interface Session {
  readonly close: () => void;
  readonly controls: Controls;
  readonly service: CoordinationService;
}

function grants(sessionId: string): readonly string[] {
  const list: string[] = [];
  for (const kind of COORDINATION_ENVELOPE_KINDS) {
    list.push(coordinationCapability("SEND", REVIEWER.sessionId, kind));
    list.push(coordinationCapability("SEND", CODER.sessionId, kind));
  }
  for (const endpoint of ["ACKNOWLEDGE", "READ", "REPLAY"] as const) {
    list.push(coordinationCapability(endpoint, sessionId));
  }
  return Object.freeze(list);
}

function openSession(path: string, sessionId: string): Session {
  const store = SqliteEventStore.openForProject(path, PROJECT);
  const controls: Controls = { authAnswer: null, now: NOW, sessionId };
  const service = createCoordinationService({
    authenticate: () => controls.authAnswer === null
      ? Object.freeze({
        capabilities: grants(controls.sessionId), ok: true, principalId: "principal-1",
        sessionId: controls.sessionId,
      })
      : controls.authAnswer(),
    mailbox: createDurableMailbox(store),
    now: () => controls.now,
    resolveEffectBinding: (query) => Object.freeze({
      bound: true, effectId: query.effectId, sessionId: query.sessionId,
    }),
    resolveRecipient: (address) => Object.freeze({ known: true, role: address.role }),
  });
  return { close: () => store.close(), controls, service };
}

function withDirectory(run: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "moe-coordination-"));
  try {
    run(join(directory, "coordination.sqlite"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function withSession(path: string, sessionId: string, run: (session: Session) => void): void {
  const session = openSession(path, sessionId);
  try {
    run(session);
  } finally {
    session.close();
  }
}

function envelope(kind: CoordinationEnvelopeKind, messageId: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    advisory: { advisoryOnly: true, text: "advisory only" }, correlationId: "corr-durable",
    data: { note: kind }, kind, messageId, recipient: REVIEWER, sender: CODER,
    ttlMilliseconds: 3_600_000,
  };
  if (kind === "CONTROL") base["control"] = "ATTENTION_REQUESTED";
  if (kind === "HANDOFF") {
    base["handoff"] = {
      artifactDigests: ["a".repeat(64)], baseRef: "main", blockers: [],
      criteria: ["gate green"], decisions: ["ship it"], headRef: "topic",
      nextAction: "run the focused gate", objective: "hand off coordination",
      repository: "moe-next", scopes: ["packages/coordination"],
      verificationDigests: ["b".repeat(64)],
    };
  }
  return base;
}

function send(session: Session, value: unknown): CoordinationSendResult {
  return session.service.send({
    envelope: value, presentation: PRESENTATION, transportId: TRANSPORT,
  });
}

function accepted(result: CoordinationSendResult): CoordinationAccepted {
  if (result.outcome === "REFUSED") throw new Error(`unexpected refusal ${result.code}`);
  return result;
}

function items(result: CoordinationReadResult): readonly CoordinationDelivery[] {
  if (result.outcome !== "PAGE") throw new Error(`expected a page, got ${result.outcome}`);
  return result.items;
}

function refusalOf(result: CoordinationReadResult | CoordinationSendResult): CoordinationRefused {
  if (result.outcome !== "REFUSED") throw new Error(`expected a refusal, got ${result.outcome}`);
  return result;
}

function mailboxArgs(): {
  readonly mailbox: CoordinationAddress; readonly presentation: unknown;
  readonly transportId: string;
} {
  return { mailbox: REVIEWER, presentation: PRESENTATION, transportId: TRANSPORT };
}

describe("coordination durability across restart", () => {
  it("resumes strictly after the durable ack with identical ids, digests, and sequences", () => {
    withDirectory((path) => {
      const enqueued: CoordinationAccepted[] = [];
      withSession(path, CODER.sessionId, (writer) => {
        for (const kind of ["EVENT", "REQUEST", "CONTROL", "HANDOFF"] as const) {
          enqueued.push(accepted(send(writer, envelope(kind, `msg-${kind.toLowerCase()}`))));
        }
      });
      expect(enqueued.map((entry) => entry.sequence)).toStrictEqual([1, 2, 3, 4]);

      let firstRead: readonly CoordinationDelivery[] = [];
      withSession(path, REVIEWER.sessionId, (reader) => {
        firstRead = items(reader.service.read(mailboxArgs()));
        // Redelivery before acknowledgement: the same four entries, unchanged.
        expect(items(reader.service.read(mailboxArgs())).map((item) => item.digest))
          .toStrictEqual(firstRead.map((item) => item.digest));
      });
      expect(firstRead.map((item) => item.envelope.kind))
        .toStrictEqual(["EVENT", "REQUEST", "CONTROL", "HANDOFF"]);

      withSession(path, REVIEWER.sessionId, (reader) => {
        const replayed = items(reader.service.replay({ ...mailboxArgs(), fromSequence: 0 }));
        expect(replayed.map((item) => item.digest)).toStrictEqual(
          firstRead.map((item) => item.digest),
        );
        const second = replayed[1];
        expect(second).toBeDefined();
        if (second === undefined) return;
        expect(reader.service.acknowledge({
          ...mailboxArgs(), digest: second.digest, messageId: second.envelope.messageId,
          sequence: second.sequence,
        }).outcome).toBe("ACKNOWLEDGED");
        // Replay must not have advanced anything: the ack above was the first advance.
        expect(items(reader.service.read(mailboxArgs())).map((item) => item.sequence))
          .toStrictEqual([3, 4]);
      });

      withSession(path, REVIEWER.sessionId, (reader) => {
        const resumed = items(reader.service.read(mailboxArgs()));
        expect(resumed.map((item) => item.sequence)).toStrictEqual([3, 4]);
        expect(resumed.map((item) => item.envelope.messageId))
          .toStrictEqual(["msg-control", "msg-handoff"]);
        expect(resumed.map((item) => item.digest))
          .toStrictEqual([firstRead[2]?.digest, firstRead[3]?.digest]);
        expect(resumed.map((item) => item.sentAt))
          .toStrictEqual([firstRead[2]?.sentAt, firstRead[3]?.sentAt]);
      });
    });
  });

  it("deduplicates a concurrent duplicate send and answers a response across a restart", () => {
    withDirectory((path) => {
      let first: CoordinationAccepted | null = null;
      withSession(path, CODER.sessionId, (writer) => {
        first = accepted(send(writer, envelope("REQUEST", "msg-req")));
        const duplicate = accepted(send(writer, envelope("REQUEST", "msg-req")));
        expect(duplicate.outcome).toBe("DEDUPLICATED");
        expect(duplicate.sequence).toBe(first.sequence);
        expect(duplicate.digest).toBe(first.digest);
      });
      expect(first).not.toBeNull();

      withSession(path, REVIEWER.sessionId, (responder) => {
        const response = accepted(responder.service.send({
          envelope: {
            advisory: null, correlationId: "corr-durable", data: { verdict: "ok" },
            inReplyTo: "msg-req", kind: "RESPONSE", messageId: "msg-res", recipient: CODER,
            sender: REVIEWER, ttlMilliseconds: 3_600_000,
          },
          presentation: PRESENTATION, transportId: TRANSPORT,
        }));
        expect(response.outcome).toBe("ACCEPTED");
        const orphan = refusalOf(responder.service.send({
          envelope: {
            advisory: null, correlationId: "corr-durable", data: {}, inReplyTo: "msg-absent",
            kind: "RESPONSE", messageId: "msg-res-2", recipient: CODER, sender: REVIEWER,
            ttlMilliseconds: 3_600_000,
          },
          presentation: PRESENTATION, transportId: TRANSPORT,
        }));
        expect(orphan.code).toBe("COORDINATION_REPLY_TARGET_MISSING");
        expect(orphan.layer).toBe("CORRELATION");
      });
    });
  });

  it("refuses every non-positive authenticator verdict at AUTHENTICATION", () => {
    const verdicts: ReadonlyArray<readonly [string, () => unknown]> = [
      ["revoked", () => Object.freeze({ ok: false, reason: "REVOKED" })],
      ["expired", () => Object.freeze({ ok: false, reason: "SESSION_EXPIRED" })],
      ["replayed", () => Object.freeze({ ok: false, reason: "SESSION_REPLAYED" })],
      ["throws", () => {
        throw new Error("identity seam unavailable");
      }],
    ];
    expect(verdicts.length).toBeGreaterThan(0);
    withDirectory((path) => {
      withSession(path, CODER.sessionId, (writer) => {
        for (const [label, verdict] of verdicts) {
          writer.controls.authAnswer = verdict;
          const refused = refusalOf(send(writer, envelope("EVENT", "msg-event")));
          expect(refused.code, label).toBe("COORDINATION_AUTHENTICATION_FAILED");
          expect(refused.layer, label).toBe("AUTHENTICATION");
        }
        // Every refusal above must have left the durable mailbox untouched.
        writer.controls.authAnswer = null;
        writer.controls.sessionId = REVIEWER.sessionId;
        expect(items(writer.service.replay({
          ...mailboxArgs(), fromSequence: 0,
        })).length).toBe(0);
      });
    });
  });

  it("refuses beyond the durable outstanding depth and reports a cursor ahead as a gap", () => {
    withDirectory((path) => {
      withSession(path, CODER.sessionId, (writer) => {
        const depth = COORDINATION_LIMITS.maxOutstandingMessages;
        for (let index = 0; index < depth; index += 1) {
          expect(accepted(send(writer, envelope("EVENT", `msg-${index}`))).sequence)
            .toBe(index + 1);
        }
        const full = refusalOf(send(writer, envelope("EVENT", `msg-${depth}`)));
        expect(full.code).toBe("COORDINATION_MAILBOX_FULL");
        expect(full.layer).toBe("MAILBOX");
      });
      withSession(path, REVIEWER.sessionId, (reader) => {
        const gap = reader.service.replay({ ...mailboxArgs(), fromSequence: 10_000 });
        expect(gap.outcome).toBe("CURSOR_GAP");
        if (gap.outcome !== "CURSOR_GAP") return;
        expect(gap.mailboxSequence).toBe(COORDINATION_LIMITS.maxOutstandingMessages);
        expect(gap.durableCursor).toBe(0);
      });
    });
  });

  it("marks a message expired at the exact boundary of its durable time-to-live", () => {
    withDirectory((path) => {
      withSession(path, CODER.sessionId, (writer) => {
        accepted(send(writer, {
          ...envelope("EVENT", "msg-ttl"), ttlMilliseconds: 5_000,
        }));
        // ttl=0 can no longer reach the mailbox: the published minimum is 1 and the codec
        // refuses an under-minimum ttl before anything durable is touched.
        const dead = refusalOf(send(writer, {
          ...envelope("EVENT", "msg-dead"), ttlMilliseconds: 0,
        }));
        expect(dead.code).toBe("COORDINATION_INPUT_INVALID");
        expect(dead.layer).toBe("DECODE");
      });
      withSession(path, REVIEWER.sessionId, (reader) => {
        reader.controls.now = NOW + 4_999;
        expect(items(reader.service.read(mailboxArgs()))[0]?.state).toBe("DELIVERABLE");
        reader.controls.now = NOW + 5_000;
        const expired = items(reader.service.read(mailboxArgs()))[0];
        expect(expired?.state).toBe("EXPIRED");
        expect(expired?.sequence).toBe(1);
        expect(reader.service.acknowledge({
          ...mailboxArgs(), digest: expired?.digest ?? "", messageId: "msg-ttl", sequence: 1,
        }).outcome).toBe("ACKNOWLEDGED");
      });
    });
  });
});

it("loads the curated entrypoint in Node's strip-types runtime with no missing bridge", async () => {
  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const worker = new Worker(
      new URL("./coordination-entrypoint-smoke-worker.mjs", import.meta.url),
      { execArgv: ["--experimental-strip-types"] },
    );
    worker.once("message", (message: Record<string, unknown>) => resolve(message));
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`coordination smoke worker exited with ${code}`));
    });
  });

  expect(result["outcome"]).toBe("IMPORTED");
  expect(result["undefinedExports"]).toStrictEqual([]);
  expect(result["leakedNames"]).toStrictEqual([]);
  expect(result["serviceFrozen"]).toBe(true);
  expect(result["serviceMembers"]).toStrictEqual(["acknowledge", "read", "replay", "send"]);
  expect(result["refusedCode"]).toBe("COORDINATION_AUTHENTICATION_FAILED");
  expect(result["refusedLayer"]).toBe("AUTHENTICATION");
  expect(result["exportedNames"]).toStrictEqual([
    "COORDINATION_CODES", "COORDINATION_CONTROL_KINDS", "COORDINATION_ENDPOINTS",
    "COORDINATION_ENDPOINT_VERSION", "COORDINATION_ENVELOPE_KINDS",
    "COORDINATION_ENVELOPE_VERSION", "COORDINATION_FORBIDDEN_FIELDS", "COORDINATION_LAYERS",
    "COORDINATION_LIMITS", "COORDINATION_ROLES", "COORDINATION_SCOPE",
    "coordinationCapability", "coordinationRequestDigest", "createCoordinationService",
    "createDurableMailbox",
  ]);
});

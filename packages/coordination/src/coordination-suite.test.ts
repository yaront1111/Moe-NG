import { describe, expect, it } from "vitest";

import { DurableStoreError, SqliteEventStore } from "@moe/store";

import {
  COORDINATION_CODES, COORDINATION_CONTROL_KINDS, COORDINATION_ENDPOINTS,
  COORDINATION_ENVELOPE_KINDS, COORDINATION_ENVELOPE_VERSION, COORDINATION_LAYERS,
  COORDINATION_LIMITS, COORDINATION_ROLES, COORDINATION_SCOPE, coordinationCapability,
} from "./coordination-contracts.js";
import type {
  CoordinationAccepted, CoordinationAckResult, CoordinationAddress, CoordinationDelivery,
  CoordinationEndpoint, CoordinationEnvelopeKind, CoordinationReadResult, CoordinationRefused,
  CoordinationSendResult,
} from "./coordination-contracts.js";
import { decodeCoordinationEnvelope } from "./coordination-codec.js";
import { createDurableMailbox } from "./coordination-mailbox.js";
import type { CoordinationEventStore } from "./coordination-mailbox.js";
import { createCoordinationService } from "./coordination-service.js";
import type { CoordinationService } from "./coordination-service.js";

const NOW = 1_800_000_000_000;
const PROJECT = "moe-coordination-project";
const TRANSPORT = "transport-1";
/** Credential material handed to the endpoint. It must never reach a durable envelope. */
const PRESENTATION = Object.freeze({ proofMaterial: "never-stored-secret" });
const CODER: CoordinationAddress = Object.freeze({
  effectId: null, role: "CODER", sessionId: "session-coder",
});
const REVIEWER: CoordinationAddress = Object.freeze({
  effectId: null, role: "REVIEWER", sessionId: "session-reviewer",
});
const TERMINAL: CoordinationAddress = Object.freeze({
  effectId: "effect-77", role: "TERMINAL", sessionId: "session-terminal",
});

type Draft = Record<string, unknown>;

function draft(kind: CoordinationEnvelopeKind, overrides: Draft = {}): Draft {
  const base: Draft = {
    advisory: null, correlationId: "corr-1", data: { note: "hello" }, kind,
    messageId: `msg-${kind.toLowerCase()}`, recipient: REVIEWER, sender: CODER,
    ttlMilliseconds: 60_000,
  };
  if (kind === "RESPONSE") base["inReplyTo"] = "msg-request";
  if (kind === "CONTROL") base["control"] = "HEARTBEAT";
  if (kind === "HANDOFF") base["handoff"] = handoff();
  return { ...base, ...overrides };
}

function handoff(): Draft {
  return {
    artifactDigests: ["a".repeat(64)], baseRef: "main", blockers: [], criteria: ["tests green"],
    decisions: ["use the store"], headRef: "feature", nextAction: "run the gate",
    objective: "land coordination", repository: "moe-next", scopes: ["packages/coordination"],
    verificationDigests: ["b".repeat(64)],
  };
}

interface Controls {
  authAnswer: (endpoint: CoordinationEndpoint, digest: string) => unknown;
  capabilities: string[];
  effectAnswer: (effectId: string, sessionId: string) => unknown;
  now: number;
  recipientAnswer: (address: CoordinationAddress) => unknown;
  seenDigests: string[];
  sessionId: string;
}

interface Harness {
  readonly controls: Controls;
  readonly service: CoordinationService;
  readonly store: SqliteEventStore;
}

function allCapabilities(sessionId: string): string[] {
  const grants: string[] = [];
  for (const kind of COORDINATION_ENVELOPE_KINDS) {
    grants.push(coordinationCapability("SEND", REVIEWER.sessionId, kind));
    grants.push(coordinationCapability("SEND", TERMINAL.sessionId, kind));
    grants.push(coordinationCapability("SEND", CODER.sessionId, kind));
  }
  for (const endpoint of ["ACKNOWLEDGE", "READ", "REPLAY"] as const) {
    grants.push(coordinationCapability(endpoint, sessionId));
  }
  return grants;
}

function defaultRecipientAnswer(address: CoordinationAddress): unknown {
  return Object.freeze({ known: true, role: address.role });
}

function defaultEffectAnswer(effectId: string, sessionId: string): unknown {
  return Object.freeze({ bound: true, effectId, sessionId });
}

function openHarness(wrap: (store: SqliteEventStore) => CoordinationEventStore = passthrough): Harness {
  const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
  const controls: Controls = {
    authAnswer: (_endpoint, _digest) => undefined,
    capabilities: allCapabilities(CODER.sessionId),
    effectAnswer: defaultEffectAnswer,
    now: NOW,
    recipientAnswer: defaultRecipientAnswer,
    seenDigests: [],
    sessionId: CODER.sessionId,
  };
  const service = createCoordinationService({
    authenticate: (request) => {
      controls.seenDigests.push(request.requestDigest);
      const override = controls.authAnswer(request.endpoint, request.requestDigest);
      if (override !== undefined) return override;
      return Object.freeze({
        capabilities: Object.freeze([...controls.capabilities]),
        ok: true, principalId: "principal-1", sessionId: controls.sessionId,
      });
    },
    mailbox: createDurableMailbox(wrap(store)),
    now: () => controls.now,
    resolveEffectBinding: (query) => controls.effectAnswer(query.effectId, query.sessionId),
    resolveRecipient: (address) => controls.recipientAnswer(address),
  });
  return { controls, service, store };
}

function withHarness(run: (harness: Harness) => void): void {
  const harness = openHarness();
  try {
    run(harness);
  } finally {
    harness.store.close();
  }
}

type AnyResult = CoordinationAckResult | CoordinationReadResult | CoordinationSendResult;

function refusal(result: AnyResult): CoordinationRefused {
  expect(result.outcome).toBe("REFUSED");
  if (result.outcome !== "REFUSED") throw new Error("expected a refusal");
  return result;
}

function stored(result: CoordinationSendResult): CoordinationAccepted {
  if (result.outcome === "REFUSED") throw new Error(`unexpected refusal ${result.code}`);
  return result;
}

function send(harness: Harness, envelope: unknown): CoordinationSendResult {
  return harness.service.send({ envelope, presentation: PRESENTATION, transportId: TRANSPORT });
}

function mailboxArgs(mailbox: CoordinationAddress): {
  readonly mailbox: CoordinationAddress; readonly presentation: unknown;
  readonly transportId: string;
} {
  return { mailbox, presentation: PRESENTATION, transportId: TRANSPORT };
}

describe("coordination vocabulary", () => {
  it("publishes frozen, unique, sorted vocabularies for every axis", () => {
    const axes = [
      COORDINATION_CODES, COORDINATION_CONTROL_KINDS, COORDINATION_ENDPOINTS,
      COORDINATION_ENVELOPE_KINDS, COORDINATION_LAYERS, COORDINATION_ROLES,
    ];
    expect(axes.length).toBeGreaterThan(0);
    for (const axis of axes) {
      expect(Object.isFrozen(axis)).toBe(true);
      expect(axis.length).toBeGreaterThan(0);
      expect(new Set(axis).size).toBe(axis.length);
      expect([...axis]).toStrictEqual([...axis].sort());
    }
    expect(COORDINATION_ENVELOPE_KINDS).toStrictEqual([
      "CONTROL", "EVENT", "HANDOFF", "REQUEST", "RESPONSE",
    ]);
    expect(COORDINATION_ENDPOINTS).toStrictEqual(["ACKNOWLEDGE", "READ", "REPLAY", "SEND"]);
    expect(COORDINATION_LAYERS).toStrictEqual([
      "ADDRESS", "AUTHENTICATION", "CAPABILITY", "CORRELATION", "DECODE", "MAILBOX", "STORE",
    ]);
    expect(COORDINATION_ENVELOPE_VERSION).toBe("moe-coordination-envelope/1");
    expect(COORDINATION_SCOPE).toBe("moe:coordination");
    expect(Object.isFrozen(COORDINATION_LIMITS)).toBe(true);
  });

  it("derives a distinct capability string per endpoint and per send kind", () => {
    const grants = new Set<string>();
    let generated = 0;
    for (const kind of COORDINATION_ENVELOPE_KINDS) {
      grants.add(coordinationCapability("SEND", REVIEWER.sessionId, kind));
      generated += 1;
    }
    for (const endpoint of COORDINATION_ENDPOINTS) {
      if (endpoint === "SEND") continue;
      grants.add(coordinationCapability(endpoint, REVIEWER.sessionId));
      generated += 1;
    }
    expect(generated).toBe(COORDINATION_ENVELOPE_KINDS.length + COORDINATION_ENDPOINTS.length - 1);
    expect(grants.size).toBe(generated);
  });
});

describe("coordination envelope codec", () => {
  it("accepts every envelope kind and freezes the decoded result", () => {
    let accepted = 0;
    for (const kind of COORDINATION_ENVELOPE_KINDS) {
      const result = decodeCoordinationEnvelope(draft(kind));
      expect(result.ok, `kind ${kind}`).toBe(true);
      if (!result.ok) continue;
      accepted += 1;
      expect(result.envelope.kind).toBe(kind);
      expect(Object.isFrozen(result.envelope)).toBe(true);
      expect(Object.isFrozen(result.envelope.sender)).toBe(true);
      expect(Object.isFrozen(result.envelope.data)).toBe(true);
      expect(result.digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(result.canonicalBytes.byteLength).toBeGreaterThan(0);
    }
    expect(accepted).toBe(COORDINATION_ENVELOPE_KINDS.length);
  });

  it("is byte-deterministic under key reordering and returns a stable digest", () => {
    const ordered = decodeCoordinationEnvelope(draft("EVENT"));
    const shuffled = decodeCoordinationEnvelope({
      ttlMilliseconds: 60_000, sender: CODER, recipient: REVIEWER, messageId: "msg-event",
      kind: "EVENT", data: { note: "hello" }, correlationId: "corr-1", advisory: null,
    });
    expect(ordered.ok && shuffled.ok).toBe(true);
    if (!ordered.ok || !shuffled.ok) return;
    expect([...shuffled.canonicalBytes]).toStrictEqual([...ordered.canonicalBytes]);
    expect(shuffled.digest).toBe(ordered.digest);
  });

  it("refuses every malformed envelope shape at DECODE with its exact code", () => {
    const cases: ReadonlyArray<readonly [string, unknown, string]> = [
      ["null envelope", null, "COORDINATION_INPUT_INVALID"],
      ["array envelope", [], "COORDINATION_INPUT_INVALID"],
      ["proxy envelope", new Proxy(draft("EVENT"), {}), "COORDINATION_INPUT_INVALID"],
      ["unknown key", draft("EVENT", { sequence: 1 }), "COORDINATION_INPUT_INVALID"],
      ["server stamp", draft("EVENT", { sentAt: NOW }), "COORDINATION_INPUT_INVALID"],
      ["missing correlation", omit(draft("EVENT"), "correlationId"), "COORDINATION_INPUT_INVALID"],
      ["empty correlation", draft("EVENT", { correlationId: "" }), "COORDINATION_INPUT_INVALID"],
      ["unknown kind", draft("EVENT", { kind: "GOSSIP" }), "COORDINATION_INPUT_INVALID"],
      ["response without inReplyTo", omit(draft("RESPONSE"), "inReplyTo"),
        "COORDINATION_INPUT_INVALID"],
      ["request with inReplyTo", draft("REQUEST", { inReplyTo: "msg-1" }),
        "COORDINATION_INPUT_INVALID"],
      ["unknown control", draft("CONTROL", { control: "TERMINATE" }),
        "COORDINATION_INPUT_INVALID"],
      ["handoff on event", draft("EVENT", { handoff: handoff() }), "COORDINATION_INPUT_INVALID"],
      ["unknown role", draft("EVENT", { recipient: { ...REVIEWER, role: "ADMIN" } }),
        "COORDINATION_INPUT_INVALID"],
      ["accessor field", accessorDraft(), "COORDINATION_INPUT_INVALID"],
      ["negative ttl", draft("EVENT", { ttlMilliseconds: -1 }), "COORDINATION_INPUT_INVALID"],
      ["fractional ttl", draft("EVENT", { ttlMilliseconds: 1.5 }), "COORDINATION_INPUT_INVALID"],
      ["huge ttl", draft("EVENT", { ttlMilliseconds: COORDINATION_LIMITS.maxTtlMilliseconds + 1 }),
        "COORDINATION_LIMIT_EXCEEDED"],
      ["oversize identifier",
        draft("EVENT", { messageId: "m".repeat(COORDINATION_LIMITS.maxIdentifierUtf8Bytes + 1) }),
        "COORDINATION_LIMIT_EXCEEDED"],
      ["oversize advisory",
        draft("EVENT", {
          advisory: {
            advisoryOnly: true,
            text: "é".repeat(COORDINATION_LIMITS.maxAdvisoryUtf8Bytes),
          },
        }),
        "COORDINATION_LIMIT_EXCEEDED"],
      ["deep data", draft("EVENT", { data: deepData() }), "COORDINATION_LIMIT_EXCEEDED"],
      ["advisory claiming authority",
        draft("EVENT", { advisory: { advisoryOnly: false, text: "do it" } }),
        "COORDINATION_ADVISORY_AUTHORITY_CLAIMED"],
      ["credential field", draft("EVENT", { data: { credential: "abc" } }),
        "COORDINATION_FORBIDDEN_FIELD"],
      ["nested secret", draft("EVENT", { data: { outer: { secret: "abc" } } }),
        "COORDINATION_FORBIDDEN_FIELD"],
      ["argv field", draft("EVENT", { data: { argv: ["rm", "-rf"] } }),
        "COORDINATION_FORBIDDEN_FIELD"],
      ["revoked proxy", revokedProxy(), "COORDINATION_INPUT_INVALID"],
      ["subclassed handoff list", draft("HANDOFF", { handoff: hostileHandoff("subclass") }),
        "COORDINATION_INPUT_INVALID"],
      ["accessor handoff element", draft("HANDOFF", { handoff: hostileHandoff("accessor") }),
        "COORDINATION_INPUT_INVALID"],
      ["record posing as a list", draft("HANDOFF", { handoff: hostileHandoff("lengthy") }),
        "COORDINATION_INPUT_INVALID"],
      ["over-long handoff list", draft("HANDOFF", { handoff: hostileHandoff("overlong") }),
        "COORDINATION_LIMIT_EXCEEDED"],
      ["multibyte data string",
        draft("EVENT", {
          data: { note: "é".repeat(COORDINATION_LIMITS.maxTextUtf8Bytes) },
        }),
        "COORDINATION_LIMIT_EXCEEDED"],
    ];
    expect(cases.length).toBeGreaterThan(0);
    for (const [label, input, code] of cases) {
      const result = decodeCoordinationEnvelope(input);
      expect(result.ok, label).toBe(false);
      if (result.ok) continue;
      expect(result.code, label).toBe(code);
      expect(result.layer, label).toBe("DECODE");
      expect(result.detail, label).not.toContain("abc");
    }
  });

  it("never echoes hostile bytes back in the refusal detail", () => {
    const result = decodeCoordinationEnvelope(draft("EVENT", { correlationId: " <script>" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).not.toContain("<script>");
  });
});

function omit(record: Draft, key: string): Draft {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

function accessorDraft(): Draft {
  const base = draft("EVENT");
  return Object.defineProperty(base, "messageId", { configurable: true, get: () => "msg-event" });
}

function revokedProxy(): unknown {
  const revocable = Proxy.revocable(draft("EVENT"), {});
  revocable.revoke();
  return revocable.proxy;
}

/** Four ways to smuggle a value past a naive `Array.isArray` + `for...of` list reader. */
function hostileHandoff(mode: "accessor" | "lengthy" | "overlong" | "subclass"): Draft {
  const base = handoff();
  if (mode === "subclass") {
    base["scopes"] = Object.setPrototypeOf(["ok"], Object.create(Array.prototype));
  }
  if (mode === "accessor") {
    base["scopes"] = Object.defineProperty([], "0", {
      configurable: true, enumerable: true, get: () => "ok",
    });
  }
  if (mode === "lengthy") base["scopes"] = { 0: "ok", length: 1 };
  if (mode === "overlong") {
    base["scopes"] = new Array<string>(COORDINATION_LIMITS.maxHandoffEntries + 1).fill("ok");
  }
  return base;
}

function deepData(): Draft {
  let value: Draft = { leaf: 1 };
  for (let index = 0; index <= COORDINATION_LIMITS.maxDataDepth + 1; index += 1) {
    value = { nested: value };
  }
  return value;
}

describe("coordination endpoints", () => {
  it("refuses every endpoint at AUTHENTICATION when the binding is not positive", () => {
    const answers: ReadonlyArray<readonly [string, unknown]> = [
      ["undefined-free negative", { ok: false }],
      ["unfrozen positive", { capabilities: [], ok: true, principalId: "p", sessionId: "s" }],
      ["missing session", Object.freeze({ capabilities: [], ok: true, principalId: "p" })],
      ["string answer", "OK"],
      ["null answer", null],
    ];
    let generated = 0;
    withHarness((harness) => {
      for (const endpoint of COORDINATION_ENDPOINTS) {
        for (const [label, answer] of answers) {
          harness.controls.authAnswer = () => (answer === undefined ? null : answer);
          const result = invoke(harness, endpoint);
          generated += 1;
          const refused = refusal(result);
          expect(refused.code, `${endpoint}/${label}`).toBe("COORDINATION_AUTHENTICATION_FAILED");
          expect(refused.layer, `${endpoint}/${label}`).toBe("AUTHENTICATION");
        }
      }
    });
    expect(generated).toBe(COORDINATION_ENDPOINTS.length * answers.length);
  });

  it("refuses every endpoint at AUTHENTICATION when the authenticator throws", () => {
    let generated = 0;
    withHarness((harness) => {
      for (const endpoint of COORDINATION_ENDPOINTS) {
        harness.controls.authAnswer = () => {
          throw new Error("authenticator exploded");
        };
        const refused = refusal(invoke(harness, endpoint));
        generated += 1;
        expect(refused.code, endpoint).toBe("COORDINATION_AUTHENTICATION_FAILED");
        expect(refused.layer, endpoint).toBe("AUTHENTICATION");
        expect(refused.detail).not.toContain("exploded");
      }
    });
    expect(generated).toBe(COORDINATION_ENDPOINTS.length);
  });

  it("refuses every endpoint at CAPABILITY when the exact grant is absent", () => {
    let generated = 0;
    withHarness((harness) => {
      for (const endpoint of COORDINATION_ENDPOINTS) {
        harness.controls.capabilities = ["coordination:send:event:someone-else"];
        const refused = refusal(invoke(harness, endpoint));
        generated += 1;
        expect(refused.code, endpoint).toBe("COORDINATION_CAPABILITY_DENIED");
        expect(refused.layer, endpoint).toBe("CAPABILITY");
      }
    });
    expect(generated).toBe(COORDINATION_ENDPOINTS.length);
  });

  it("binds authentication to the canonical request digest of each endpoint", () => {
    withHarness((harness) => {
      for (const endpoint of COORDINATION_ENDPOINTS) invoke(harness, endpoint);
      expect(harness.controls.seenDigests.length).toBe(COORDINATION_ENDPOINTS.length);
      for (const digest of harness.controls.seenDigests) expect(digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(new Set(harness.controls.seenDigests).size).toBe(COORDINATION_ENDPOINTS.length);
    });
  });

  it("refuses a send whose sender is not the authenticated session", () => {
    withHarness((harness) => {
      harness.controls.sessionId = "session-impostor";
      const refused = refusal(send(harness, draft("EVENT")));
      expect(refused.code).toBe("COORDINATION_SENDER_MISMATCH");
      expect(refused.layer).toBe("AUTHENTICATION");
    });
  });
});

function invoke(harness: Harness, endpoint: CoordinationEndpoint): AnyResult {
  if (endpoint === "SEND") return send(harness, draft("EVENT"));
  if (endpoint === "READ") return harness.service.read(mailboxArgs(CODER));
  if (endpoint === "REPLAY") {
    return harness.service.replay({ ...mailboxArgs(CODER), fromSequence: 0 });
  }
  return harness.service.acknowledge({
    ...mailboxArgs(CODER), digest: "0".repeat(64), messageId: "msg-event", sequence: 1,
  });
}

describe("coordination addressing", () => {
  it("refuses an unknown recipient at ADDRESS without mutating the mailbox", () => {
    withHarness((harness) => {
      harness.controls.recipientAnswer = () => Object.freeze({ known: false });
      const refused = refusal(send(harness, draft("EVENT")));
      expect(refused.code).toBe("COORDINATION_RECIPIENT_UNKNOWN");
      expect(refused.layer).toBe("ADDRESS");
      expect(readOwn(harness, REVIEWER)).toStrictEqual([]);
    });
  });

  it("refuses a throwing, unknown, or mismatched recipient registry answer", () => {
    const answers: ReadonlyArray<readonly [string, () => unknown]> = [
      ["throws", () => {
        throw new Error("registry down");
      }],
      ["unfrozen", () => ({ known: true, role: REVIEWER.role })],
      ["unknown shape", () => "UNKNOWN"],
      ["role mismatch", () => Object.freeze({ known: true, role: "CODER" })],
    ];
    expect(answers.length).toBeGreaterThan(0);
    withHarness((harness) => {
      for (const [label, answer] of answers) {
        harness.controls.recipientAnswer = answer;
        const refused = refusal(send(harness, draft("EVENT")));
        expect(refused.code, label).toBe("COORDINATION_RECIPIENT_UNKNOWN");
        expect(refused.layer, label).toBe("ADDRESS");
      }
    });
  });

  it("requires a current positive effect binding for a terminal address", () => {
    const answers: ReadonlyArray<readonly [string, unknown]> = [
      ["negative", Object.freeze({ bound: false })],
      ["unfrozen", { bound: true, effectId: TERMINAL.effectId, sessionId: TERMINAL.sessionId }],
      ["stale effect", Object.freeze({
        bound: true, effectId: "effect-old", sessionId: TERMINAL.sessionId,
      })],
      ["mismatched session", Object.freeze({
        bound: true, effectId: TERMINAL.effectId, sessionId: "session-other",
      })],
      ["unknown", "UNKNOWN"],
    ];
    expect(answers.length).toBeGreaterThan(0);
    withHarness((harness) => {
      for (const [label, answer] of answers) {
        harness.controls.effectAnswer = () => answer;
        const refused = refusal(send(harness, draft("EVENT", { recipient: TERMINAL })));
        expect(refused.code, label).toBe("COORDINATION_TERMINAL_BINDING_INVALID");
        expect(refused.layer, label).toBe("ADDRESS");
        expect(readOwn(harness, TERMINAL), label).toStrictEqual([]);
      }
      harness.controls.effectAnswer = () => {
        throw new Error("effect registry down");
      };
      const thrown = refusal(send(harness, draft("EVENT", { recipient: TERMINAL })));
      expect(thrown.code).toBe("COORDINATION_TERMINAL_BINDING_INVALID");
    });
  });

  it("accepts a terminal recipient whose effect binding is current", () => {
    withHarness((harness) => {
      const result = send(harness, draft("EVENT", { recipient: TERMINAL }));
      expect(result.outcome).toBe("ACCEPTED");
    });
  });
});

/** Observation helper. It restores the DEFAULT registry and effect answers for the duration
 *  of the read, so a test that broke a port to force a send refusal can still inspect the
 *  mailbox and prove the refusal left no durable trace. */
function readOwn(
  harness: Harness, mailbox: CoordinationAddress,
): readonly CoordinationDelivery[] {
  const previous = { ...harness.controls };
  harness.controls.sessionId = mailbox.sessionId;
  harness.controls.capabilities = allCapabilities(mailbox.sessionId);
  harness.controls.recipientAnswer = defaultRecipientAnswer;
  harness.controls.effectAnswer = defaultEffectAnswer;
  try {
    const page = harness.service.read(mailboxArgs(mailbox));
    expect(page.outcome).toBe("PAGE");
    if (page.outcome !== "PAGE") return [];
    return page.items;
  } finally {
    harness.controls.sessionId = previous.sessionId;
    harness.controls.capabilities = previous.capabilities;
    harness.controls.recipientAnswer = previous.recipientAnswer;
    harness.controls.effectAnswer = previous.effectAnswer;
  }
}

describe("coordination correlation", () => {
  it("accepts a response that reverses the stored request addresses", () => {
    withHarness((harness) => {
      expect(send(harness, draft("REQUEST", { messageId: "msg-req" })).outcome).toBe("ACCEPTED");
      harness.controls.sessionId = REVIEWER.sessionId;
      harness.controls.capabilities = allCapabilities(REVIEWER.sessionId);
      const response = send(harness, draft("RESPONSE", {
        inReplyTo: "msg-req", messageId: "msg-res", recipient: CODER, sender: REVIEWER,
      }));
      expect(response.outcome).toBe("ACCEPTED");
    });
  });

  it("refuses a response whose request does not exist", () => {
    withHarness((harness) => {
      harness.controls.sessionId = REVIEWER.sessionId;
      harness.controls.capabilities = allCapabilities(REVIEWER.sessionId);
      const refused = refusal(send(harness, draft("RESPONSE", {
        inReplyTo: "msg-missing", messageId: "msg-res", recipient: CODER, sender: REVIEWER,
      })));
      expect(refused.code).toBe("COORDINATION_REPLY_TARGET_MISSING");
      expect(refused.layer).toBe("CORRELATION");
    });
  });

  it("refuses a response to a non-request and a response with swapped addresses", () => {
    withHarness((harness) => {
      expect(send(harness, draft("EVENT", { messageId: "msg-evt" })).outcome).toBe("ACCEPTED");
      expect(send(harness, draft("REQUEST", { messageId: "msg-req" })).outcome).toBe("ACCEPTED");
      harness.controls.sessionId = REVIEWER.sessionId;
      harness.controls.capabilities = allCapabilities(REVIEWER.sessionId);
      const toEvent = refusal(send(harness, draft("RESPONSE", {
        inReplyTo: "msg-evt", messageId: "msg-res-1", recipient: CODER, sender: REVIEWER,
      })));
      expect(toEvent.code).toBe("COORDINATION_REPLY_TARGET_MISSING");
      const swapped = refusal(send(harness, draft("RESPONSE", {
        inReplyTo: "msg-req", messageId: "msg-res-2", recipient: TERMINAL, sender: REVIEWER,
      })));
      expect(swapped.code).toBe("COORDINATION_REPLY_ADDRESS_MISMATCH");
      expect(swapped.layer).toBe("CORRELATION");
      const drifted = refusal(send(harness, draft("RESPONSE", {
        correlationId: "corr-other", inReplyTo: "msg-req", messageId: "msg-res-3",
        recipient: CODER, sender: REVIEWER,
      })));
      expect(drifted.code).toBe("COORDINATION_CORRELATION_MISMATCH");
      expect(drifted.layer).toBe("CORRELATION");
    });
  });
});

describe("coordination mailbox durability", () => {
  it("stamps a server-owned sequence and preserves send order", () => {
    withHarness((harness) => {
      const sequences: number[] = [];
      for (const kind of COORDINATION_ENVELOPE_KINDS) {
        if (kind === "RESPONSE") continue;
        const result = send(harness, draft(kind, { messageId: `msg-${kind}` }));
        expect(result.outcome, kind).toBe("ACCEPTED");
        sequences.push(stored(result).sequence);
      }
      expect(sequences.length).toBe(COORDINATION_ENVELOPE_KINDS.length - 1);
      expect(sequences).toStrictEqual([1, 2, 3, 4]);
      const items = readOwn(harness, REVIEWER);
      expect(items.map((item) => item.sequence)).toStrictEqual(sequences);
    });
  });

  it("deduplicates an identical resend and keeps the original stamps", () => {
    withHarness((harness) => {
      const first: CoordinationAccepted = stored(send(harness, draft("EVENT")));
      expect(first.outcome).toBe("ACCEPTED");
      expect(send(harness, draft("REQUEST", { messageId: "msg-filler" })).outcome)
        .toBe("ACCEPTED");
      harness.controls.now = NOW + 5_000;
      const again: CoordinationAccepted = stored(send(harness, draft("EVENT")));
      expect(again.outcome).toBe("DEDUPLICATED");
      expect(again.sequence).toBe(first.sequence);
      expect(again.sentAt).toBe(first.sentAt);
      expect(again.digest).toBe(first.digest);
      expect(readOwn(harness, REVIEWER).length).toBe(2);
    });
  });

  it("maps a reused message id with different bytes to an idempotency conflict", () => {
    withHarness((harness) => {
      expect(send(harness, draft("EVENT")).outcome).toBe("ACCEPTED");
      const refused = refusal(send(harness, draft("EVENT", { data: { note: "different" } })));
      expect(refused.code).toBe("COORDINATION_IDEMPOTENCY_CONFLICT");
      expect(refused.layer).toBe("STORE");
      expect(readOwn(harness, REVIEWER).length).toBe(1);
    });
  });

  it("refuses the N+1st outstanding message with a mailbox-full code", () => {
    withHarness((harness) => {
      const limit = COORDINATION_LIMITS.maxOutstandingMessages;
      for (let index = 0; index < limit; index += 1) {
        const result = send(harness, draft("EVENT", { messageId: `msg-${index}` }));
        expect(result.outcome, `message ${index}`).toBe("ACCEPTED");
      }
      const refused = refusal(send(harness, draft("EVENT", { messageId: `msg-${limit}` })));
      expect(refused.code).toBe("COORDINATION_MAILBOX_FULL");
      expect(refused.layer).toBe("MAILBOX");
    });
  });

  it("refuses a send whose time-to-live has already elapsed", () => {
    withHarness((harness) => {
      const refused = refusal(send(harness, draft("EVENT", { ttlMilliseconds: 0 })));
      expect(refused.code).toBe("COORDINATION_MESSAGE_EXPIRED");
      expect(refused.layer).toBe("MAILBOX");
    });
  });

  it("reports an expired message as a typed sequence-bearing item at the boundary", () => {
    withHarness((harness) => {
      expect(send(harness, draft("EVENT", { ttlMilliseconds: 1_000 })).outcome).toBe("ACCEPTED");
      harness.controls.now = NOW + 999;
      const before = readOwn(harness, REVIEWER);
      expect(before[0]?.state).toBe("DELIVERABLE");
      harness.controls.now = NOW + 1_000;
      const after = readOwn(harness, REVIEWER);
      expect(after.length).toBe(1);
      expect(after[0]?.state).toBe("EXPIRED");
      expect(after[0]?.sequence).toBe(1);
    });
  });
});

describe("coordination delivery cursors", () => {
  it("repeats unacknowledged messages and resumes strictly after the durable ack", () => {
    withHarness((harness) => {
      expect(send(harness, draft("EVENT", { messageId: "msg-1" })).outcome).toBe("ACCEPTED");
      expect(send(harness, draft("EVENT", { messageId: "msg-2" })).outcome).toBe("ACCEPTED");
      harness.controls.sessionId = REVIEWER.sessionId;
      harness.controls.capabilities = allCapabilities(REVIEWER.sessionId);
      const first = harness.service.read(mailboxArgs(REVIEWER));
      expect(first.outcome).toBe("PAGE");
      const repeated = harness.service.read(mailboxArgs(REVIEWER));
      expect(repeated.outcome).toBe("PAGE");
      if (first.outcome !== "PAGE" || repeated.outcome !== "PAGE") return;
      expect(repeated.items.map((item) => item.sequence)).toStrictEqual([1, 2]);
      const head = first.items[0];
      expect(head).toBeDefined();
      if (head === undefined) return;
      const acked = harness.service.acknowledge({
        ...mailboxArgs(REVIEWER), digest: head.digest, messageId: head.envelope.messageId,
        sequence: head.sequence,
      });
      expect(acked.outcome).toBe("ACKNOWLEDGED");
      const next = harness.service.read(mailboxArgs(REVIEWER));
      expect(next.outcome).toBe("PAGE");
      if (next.outcome !== "PAGE") return;
      expect(next.items.map((item) => item.sequence)).toStrictEqual([2]);
    });
  });

  it("refuses an acknowledgement that regresses, drifts, or names a missing message", () => {
    withHarness((harness) => {
      expect(send(harness, draft("EVENT", { messageId: "msg-1" })).outcome).toBe("ACCEPTED");
      harness.controls.sessionId = REVIEWER.sessionId;
      harness.controls.capabilities = allCapabilities(REVIEWER.sessionId);
      const page = harness.service.read(mailboxArgs(REVIEWER));
      if (page.outcome !== "PAGE") throw new Error("expected a page");
      const head = page.items[0];
      if (head === undefined) throw new Error("expected an item");
      const base = { ...mailboxArgs(REVIEWER), digest: head.digest, messageId: "msg-1" };
      const wrongDigest = refusal(harness.service.acknowledge({
        ...base, digest: "c".repeat(64), sequence: 1,
      }));
      expect(wrongDigest.code).toBe("COORDINATION_ACK_UNKNOWN_MESSAGE");
      expect(wrongDigest.layer).toBe("MAILBOX");
      const wrongId = refusal(harness.service.acknowledge({
        ...base, messageId: "msg-other", sequence: 1,
      }));
      expect(wrongId.code).toBe("COORDINATION_ACK_UNKNOWN_MESSAGE");
      const ahead = refusal(harness.service.acknowledge({ ...base, sequence: 9 }));
      expect(ahead.code).toBe("COORDINATION_ACK_UNKNOWN_MESSAGE");
      expect(harness.service.acknowledge({ ...base, sequence: 1 }).outcome).toBe("ACKNOWLEDGED");
      const regressed = refusal(harness.service.acknowledge({ ...base, sequence: 1 }));
      expect(regressed.code).toBe("COORDINATION_ACK_REGRESSION");
      expect(regressed.layer).toBe("MAILBOX");
    });
  });

  it("replays from an explicit historical cursor without advancing the durable ack", () => {
    withHarness((harness) => {
      expect(send(harness, draft("EVENT", { messageId: "msg-1" })).outcome).toBe("ACCEPTED");
      expect(send(harness, draft("EVENT", { messageId: "msg-2" })).outcome).toBe("ACCEPTED");
      harness.controls.sessionId = REVIEWER.sessionId;
      harness.controls.capabilities = allCapabilities(REVIEWER.sessionId);
      const page = harness.service.read(mailboxArgs(REVIEWER));
      if (page.outcome !== "PAGE") throw new Error("expected a page");
      const second = page.items[1];
      if (second === undefined) throw new Error("expected two items");
      expect(harness.service.acknowledge({
        ...mailboxArgs(REVIEWER), digest: second.digest, messageId: second.envelope.messageId,
        sequence: 2,
      }).outcome).toBe("ACKNOWLEDGED");
      const replayed = harness.service.replay({ ...mailboxArgs(REVIEWER), fromSequence: 0 });
      expect(replayed.outcome).toBe("PAGE");
      if (replayed.outcome !== "PAGE") return;
      expect(replayed.items.map((item) => item.sequence)).toStrictEqual([1, 2]);
      const after = harness.service.read(mailboxArgs(REVIEWER));
      expect(after.outcome).toBe("PAGE");
      if (after.outcome !== "PAGE") return;
      expect(after.items).toStrictEqual([]);
    });
  });

  it("reports a cursor ahead of the mailbox as a typed gap", () => {
    withHarness((harness) => {
      expect(send(harness, draft("EVENT", { messageId: "msg-1" })).outcome).toBe("ACCEPTED");
      harness.controls.sessionId = REVIEWER.sessionId;
      harness.controls.capabilities = allCapabilities(REVIEWER.sessionId);
      const gap = harness.service.replay({ ...mailboxArgs(REVIEWER), fromSequence: 9 });
      expect(gap.outcome).toBe("CURSOR_GAP");
      if (gap.outcome !== "CURSOR_GAP") return;
      expect(gap.mailboxSequence).toBe(1);
      expect(gap.durableCursor).toBe(0);
    });
  });

  it("bounds and validates the requested page size", () => {
    withHarness((harness) => {
      harness.controls.sessionId = REVIEWER.sessionId;
      harness.controls.capabilities = allCapabilities(REVIEWER.sessionId);
      for (const limit of [0, -1, 1.5, COORDINATION_LIMITS.maxPageSize + 1]) {
        const refused = refusal(harness.service.read({ ...mailboxArgs(REVIEWER), limit }));
        expect(refused.layer, `limit ${limit}`).toBe("DECODE");
        expect(refused.code, `limit ${limit}`).toBe(
          limit === COORDINATION_LIMITS.maxPageSize + 1
            ? "COORDINATION_LIMIT_EXCEEDED"
            : "COORDINATION_INPUT_INVALID",
        );
      }
    });
  });
});

describe("coordination store failure mapping", () => {
  it("maps a store throw and an unknown outcome without claiming delivery", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["OUTCOME_UNKNOWN", "COORDINATION_OUTCOME_UNKNOWN"],
      ["STORE_BUSY", "COORDINATION_STORE_BUSY"],
      ["STORE_CORRUPT", "COORDINATION_STORE_UNAVAILABLE"],
      ["COMMAND_ID_CONFLICT", "COORDINATION_IDEMPOTENCY_CONFLICT"],
    ];
    expect(cases.length).toBeGreaterThan(0);
    for (const [storeCode, code] of cases) {
      const harness = openHarness((store) => failingCommit(store, storeCode, false));
      try {
        const refused = refusal(send(harness, draft("EVENT")));
        expect(refused.code, storeCode).toBe(code);
        expect(refused.layer, storeCode).toBe("STORE");
        expect(readOwn(harness, REVIEWER), storeCode).toStrictEqual([]);
      } finally {
        harness.store.close();
      }
    }
  });
});

function passthrough(store: SqliteEventStore): CoordinationEventStore {
  return store;
}

describe("coordination store failure mapping against the real error class", () => {
  it("reads the code off a genuine DurableStoreError, not just a hand-shaped stub", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["OUTCOME_UNKNOWN", "COORDINATION_OUTCOME_UNKNOWN"],
      ["STORE_BUSY", "COORDINATION_STORE_BUSY"],
      ["COMMAND_ID_CONFLICT", "COORDINATION_IDEMPOTENCY_CONFLICT"],
    ];
    expect(cases.length).toBeGreaterThan(0);
    for (const [storeCode, code] of cases) {
      const harness = openHarness((store) => failingCommit(store, storeCode, true));
      try {
        const refused = refusal(send(harness, draft("EVENT")));
        expect(refused.code, storeCode).toBe(code);
        expect(refused.layer, storeCode).toBe("STORE");
      } finally {
        harness.store.close();
      }
    }
  });
});

/** Delegates every read to the real store and fails only the write, so the mapping is
 *  exercised against genuine durable state rather than a fully stubbed seam. */
function failingCommit(
  store: SqliteEventStore, code: string, real: boolean,
): CoordinationEventStore {
  return {
    commit: () => {
      if (real) {
        throw new DurableStoreError(code as "OUTCOME_UNKNOWN", "injected by the adversarial pass");
      }
      const error = new Error(`${code}: injected`);
      (error as { code?: string }).code = code;
      error.name = "DurableStoreError";
      throw error;
    },
    getAggregateVersion: (aggregateId) => store.getAggregateVersion(aggregateId),
    getCommandReceipt: (commandId) => store.getCommandReceipt(commandId),
    readAggregateEvents: (aggregateId, after, limit, maxDecodedBytes) =>
      store.readAggregateEvents(aggregateId, after, limit, maxDecodedBytes),
  };
}

describe("coordination advisory text", () => {
  it("keeps advisory text immutable data with no authority affordance", () => {
    withHarness((harness) => {
      const advisory = { advisoryOnly: true, text: "please rerun the gate" };
      expect(send(harness, draft("EVENT", { advisory })).outcome).toBe("ACCEPTED");
      const carried = readOwn(harness, REVIEWER)[0]?.envelope.advisory;
      expect(carried?.advisoryOnly).toBe(true);
      expect(Object.isFrozen(carried)).toBe(true);
    });
  });

  it("stores no dispatch, lifecycle, or effect callback on the service surface", () => {
    withHarness((harness) => {
      expect(Object.keys(harness.service).sort()).toStrictEqual([
        "acknowledge", "read", "replay", "send",
      ]);
      expect(Object.isFrozen(harness.service)).toBe(true);
    });
  });

  it("never writes the credential presentation into the durable envelope", () => {
    withHarness((harness) => {
      expect(send(harness, draft("EVENT")).outcome).toBe("ACCEPTED");
      const items = readOwn(harness, REVIEWER);
      expect(JSON.stringify(items[0]?.envelope)).not.toContain("never-stored-secret");
    });
  });
});

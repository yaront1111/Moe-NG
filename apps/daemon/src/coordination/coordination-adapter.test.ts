import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { COORDINATION_ENVELOPE_KINDS, COORDINATION_LIMITS } from "@moe/coordination";
import type {
  CoordinationAddress, CoordinationEndpoint, CoordinationEnvelopeKind, CoordinationRole,
  CoordinationSendResult,
} from "@moe/coordination";
import { RECOVERY_BINDING_CODEC_VERSION, SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  SESSION_PROOF_ALGORITHM, SESSION_PROOF_PROTOCOL_VERSION,
} from "../identity/session-authority-contracts.js";
import {
  canonicalSessionProofBytes, sessionAuthorityRequestDigest, sessionClientKeyId,
} from "../identity/session-authority-protocol.js";
import { coordinationPresentationDigest, createCoordinationAdapter } from "./coordination-adapter.js";
import type { CoordinationAdapter } from "./coordination-adapter.js";
import { recipientAggregateId } from "./recipient-registry.js";

const PROJECT_ID = "project-coordination-adapter";
const PRINCIPAL_ID = "agent-coordination-adapter";
const PROFILE_REVISION_ID = "profile-coordination-v1";
const TRANSPORT_ID = "coordination.v1";
const TRANSPORT_IDS = Object.freeze([TRANSPORT_ID]);
const NOW = Date.parse("2026-08-11T09:00:00.000Z");
const TTL_MS = 3_600_000;
const RECOVERY_INCARNATION_REF = "61".repeat(32);
const RECOVERY_KEY_EPOCH_REF = "62".repeat(32);

function installRecovery(store: SqliteEventStore): void {
  const installed = store.installRecoveryBinding({
    bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
    incarnationRef: RECOVERY_INCARNATION_REF,
    installedAt: "2026-08-12T00:00:00.000Z",
    keyEpochRef: RECOVERY_KEY_EPOCH_REF,
    payload: new TextEncoder().encode("coordination-recovery-binding"),
    slot: "ACTIVE",
  });
  if (!installed.ok) throw new Error(`recovery setup failed: ${installed.code}`);
}

const directories: string[] = [];
const stores: SqliteEventStore[] = [];
let nonceCounter = 0;

function nextNonce(): string {
  nonceCounter += 1;
  return nonceCounter.toString(16).padStart(32, "0");
}

interface Harness {
  adapter: CoordinationAdapter;
  now: number;
  readonly path: string;
  readonly reopen: () => void;
  store: SqliteEventStore;
}

function harness(): Harness {
  const directory = mkdtempSync(join(tmpdir(), "moe-coordination-adapter-"));
  directories.push(directory);
  const path = join(directory, "store.sqlite");
  const opened = SqliteEventStore.openForProject(path, PROJECT_ID);
  installRecovery(opened);
  stores.push(opened);
  const state: Harness = {
    adapter: undefined as unknown as CoordinationAdapter,
    now: NOW,
    path,
    reopen: (): void => {
      state.store.close();
      const next = SqliteEventStore.openForProject(path, PROJECT_ID);
      stores.push(next);
      state.store = next;
      state.adapter = createCoordinationAdapter({
        clock: () => state.now, projectId: PROJECT_ID, store: next,
      });
    },
    store: opened,
  };
  state.adapter = createCoordinationAdapter({
    clock: () => state.now, projectId: PROJECT_ID, store: opened,
  });
  return state;
}

afterEach(() => {
  while (stores.length > 0) {
    try {
      stores.pop()?.close();
    } catch {
      // A recreation test may already have closed the handle.
    }
  }
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { force: true, recursive: true });
  }
});

interface ClientKey {
  readonly clientKeyId: string;
  readonly privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  readonly publicKeySpkiHex: string;
}

function clientKey(): ClientKey {
  const pair = generateKeyPairSync("ed25519");
  const publicKeySpkiHex = pair.publicKey.export({ format: "der", type: "spki" }).toString("hex");
  const clientKeyId = sessionClientKeyId(publicKeySpkiHex);
  if (clientKeyId === null) throw new Error("production rejected Node's canonical Ed25519 SPKI");
  return Object.freeze({ clientKeyId, privateKey: pair.privateKey, publicKeySpkiHex });
}

function proofOf(challenge: Uint8Array, key: ClientKey, issuedAt: number, nonce: string) {
  return Object.freeze({
    algorithm: SESSION_PROOF_ALGORITHM,
    issuedAt,
    nonce,
    protocolVersion: SESSION_PROOF_PROTOCOL_VERSION,
    signatureHex: sign(null, challenge, key.privateKey).toString("hex"),
  });
}

interface OpenedSession {
  readonly credentialId: string;
  readonly expiresAt: number;
  readonly generation: number;
  readonly key: ClientKey;
  readonly sessionId: string;
  readonly recoveryIncarnationRef: string;
  readonly keyEpochRef: string;
}

function createPrincipal(state: Harness): void {
  const result = state.adapter.sessions.createPrincipal({
    commandId: "command-create-principal",
    correlationId: "correlation-create-principal",
    kind: "AGENT" as const,
    principalId: PRINCIPAL_ID,
    profileRevisionId: PROFILE_REVISION_ID,
  });
  if (!result.ok) throw new Error(`principal setup failed: ${result.code}`);
}

function openSession(state: Harness, suffix: string): OpenedSession {
  const key = clientKey();
  const sessionId = `session-${suffix}`;
  const credentialId = `credential-${suffix}`;
  const commandId = `command-open-${suffix}`;
  const requestDigest = sessionAuthorityRequestDigest({
    clientKeyId: key.clientKeyId, credentialId, generation: 1, kind: "OPEN_SESSION",
    principalId: PRINCIPAL_ID, profileRevisionId: PROFILE_REVISION_ID, projectId: PROJECT_ID,
    publicKeySpkiHex: key.publicKeySpkiHex, sessionId, transportId: TRANSPORT_ID,
    transportIds: TRANSPORT_IDS,
  });
  const nonce = nextNonce();
  const challenge = canonicalSessionProofBytes({
    clientKeyId: key.clientKeyId, credentialId, generation: 1, issuedAt: state.now, nonce,
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID, requestDigest, requestId: commandId,
    sessionId, transportId: TRANSPORT_ID,
    recoveryIncarnationRef: RECOVERY_INCARNATION_REF, keyEpochRef: RECOVERY_KEY_EPOCH_REF,
  });
  const opened = state.adapter.sessions.openSession({
    clientKeyId: key.clientKeyId, commandId, correlationId: `correlation-open-${suffix}`,
    credentialId, principalId: PRINCIPAL_ID, proof: proofOf(challenge, key, state.now, nonce),
    publicKeySpkiHex: key.publicKeySpkiHex, requestDigest, sessionId,
    transportId: TRANSPORT_ID, transportIds: TRANSPORT_IDS,
  });
  if (!opened.ok) throw new Error(`session setup failed: ${opened.code}`);
  return Object.freeze({
    credentialId, expiresAt: opened.authority.session.expiresAt,
    generation: opened.authority.session.generation, key, sessionId,
    recoveryIncarnationRef: opened.authority.session.recoveryIncarnationRef,
    keyEpochRef: opened.authority.session.keyEpochRef,
  });
}

function addressOf(session: OpenedSession, role: CoordinationRole): CoordinationAddress {
  return Object.freeze({ effectId: null, role, sessionId: session.sessionId });
}

function register(state: Harness, address: CoordinationAddress, suffix: string): void {
  const result = state.adapter.recipients.register({
    commandId: `command-recipient-${suffix}`,
    correlationId: `correlation-recipient-${suffix}`,
    recipient: address,
  });
  if (result.outcome === "REFUSED") throw new Error(`recipient setup failed: ${result.code}`);
}

interface PresentationOverrides {
  readonly key?: ClientKey;
  readonly nonce?: string;
}

/**
 * A caller presents PROOF, never an answer. The digest is the one the adapter recomputes from
 * the live coordination request, so a presentation signed for one endpoint cannot be attached
 * to another, and the durable nonce burn makes each one single-use.
 */
function presentationOf(
  state: Harness, session: OpenedSession, endpoint: CoordinationEndpoint, requestId: string,
  targets: readonly string[], overrides: PresentationOverrides = {},
): Record<string, unknown> {
  const key = overrides.key ?? session.key;
  const nonce = overrides.nonce ?? nextNonce();
  const requestDigest = coordinationPresentationDigest({
    endpoint, requestId, sessionId: session.sessionId, transportId: TRANSPORT_ID,
  });
  const challenge = canonicalSessionProofBytes({
    clientKeyId: session.key.clientKeyId, credentialId: session.credentialId,
    generation: session.generation, issuedAt: state.now, nonce, principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID, requestDigest, requestId, sessionId: session.sessionId,
    transportId: TRANSPORT_ID, recoveryIncarnationRef: session.recoveryIncarnationRef,
    keyEpochRef: session.keyEpochRef,
  });
  return {
    clientKeyId: session.key.clientKeyId, credentialId: session.credentialId,
    generation: session.generation, principalId: PRINCIPAL_ID,
    proof: proofOf(challenge, key, state.now, nonce), requestId,
    sessionId: session.sessionId, targets,
  };
}

interface EnvelopeOverrides {
  readonly advisory?: unknown;
  readonly correlationId?: string;
  readonly data?: Record<string, unknown>;
  readonly inReplyTo?: string;
}

function envelopeOf(
  kind: CoordinationEnvelopeKind, messageId: string, sender: CoordinationAddress,
  recipient: CoordinationAddress, overrides: EnvelopeOverrides = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    advisory: overrides.advisory ?? { advisoryOnly: true, text: `advisory for ${kind}` },
    correlationId: overrides.correlationId ?? `correlation-${messageId}`,
    data: overrides.data ?? { note: kind }, kind, messageId, recipient, sender,
    ttlMilliseconds: TTL_MS,
  };
  if (kind === "CONTROL") base["control"] = "ATTENTION_REQUESTED";
  if (kind === "RESPONSE") base["inReplyTo"] = overrides.inReplyTo ?? "message-seed";
  if (kind === "HANDOFF") {
    base["handoff"] = {
      artifactDigests: ["a".repeat(64)], baseRef: "main", blockers: [],
      criteria: ["gate green"], decisions: ["ship it"], headRef: "topic",
      nextAction: "close the session and stop the daemon", objective: "hand off coordination",
      repository: "moe-next", scopes: ["apps/daemon"], verificationDigests: ["b".repeat(64)],
    };
  }
  return base;
}

let requestCounter = 0;

function nextRequestId(label: string): string {
  requestCounter += 1;
  return `request-${label}-${requestCounter}`;
}

function sendAs(
  state: Harness, session: OpenedSession, envelope: Record<string, unknown>,
  targets: readonly string[],
): CoordinationSendResult {
  const requestId = nextRequestId("send");
  return state.adapter.send({
    envelope, presentation: presentationOf(state, session, "SEND", requestId, targets),
    transportId: TRANSPORT_ID,
  });
}

function readAs(state: Harness, session: OpenedSession, mailbox: CoordinationAddress) {
  const requestId = nextRequestId("read");
  return state.adapter.read({
    mailbox, presentation: presentationOf(state, session, "READ", requestId, []),
    transportId: TRANSPORT_ID,
  });
}

function replayAs(
  state: Harness, session: OpenedSession, mailbox: CoordinationAddress, fromSequence: number,
) {
  const requestId = nextRequestId("replay");
  return state.adapter.replay({
    fromSequence, mailbox,
    presentation: presentationOf(state, session, "REPLAY", requestId, []),
    transportId: TRANSPORT_ID,
  });
}

function acknowledgeAs(
  state: Harness, session: OpenedSession, mailbox: CoordinationAddress, digest: string,
  messageId: string, sequence: number,
) {
  const requestId = nextRequestId("ack");
  return state.adapter.acknowledge({
    digest, mailbox, messageId,
    presentation: presentationOf(state, session, "ACKNOWLEDGE", requestId, []),
    sequence, transportId: TRANSPORT_ID,
  });
}

function accepted(result: CoordinationSendResult) {
  if (result.outcome === "REFUSED") {
    throw new Error(`unexpected refusal ${result.code} at ${result.layer}`);
  }
  return result;
}

/**
 * Every authoritative lifecycle fact this adapter must never move: the durable session
 * snapshot and the committed recipient ledger, as bytes. The mailbox and the replay-nonce
 * ledger are deliberately excluded — those DO change on legitimate traffic, and folding them
 * in would make the assertion vacuous.
 */
function lifecycleDigest(state: Harness, sessionIds: readonly string[]): string {
  return sessionIds.map((sessionId) => {
    const authority = JSON.stringify(state.adapter.sessions.readSessionAuthority(sessionId));
    const events = state.store.readEvents(recipientAggregateId(sessionId))
      .map((event) => `${event.eventType}#${event.aggregateSequence}`).join(",");
    return `${sessionId}=${authority}[${events}]`;
  }).join("||");
}

interface Pair {
  readonly coder: OpenedSession;
  readonly coderAddress: CoordinationAddress;
  readonly reviewer: OpenedSession;
  readonly reviewerAddress: CoordinationAddress;
}

function registeredPair(state: Harness): Pair {
  createPrincipal(state);
  const coder = openSession(state, "coder");
  const reviewer = openSession(state, "reviewer");
  const coderAddress = addressOf(coder, "CODER");
  const reviewerAddress = addressOf(reviewer, "REVIEWER");
  register(state, coderAddress, "coder");
  register(state, reviewerAddress, "reviewer");
  return { coder, coderAddress, reviewer, reviewerAddress };
}

describe("daemon coordination adapter durability", () => {
  it("sequences every envelope kind and replays it byte-identically after recreation", () => {
    const state = harness();
    const pair = registeredPair(state);
    const seed = accepted(sendAs(
      state, pair.reviewer,
      envelopeOf("REQUEST", "message-seed", pair.reviewerAddress, pair.coderAddress),
      [pair.coder.sessionId],
    ));
    expect(seed.sequence).toBe(1);

    const sent = COORDINATION_ENVELOPE_KINDS.map((kind) => accepted(sendAs(
      state, pair.coder,
      envelopeOf(kind, `message-${kind.toLowerCase()}`, pair.coderAddress, pair.reviewerAddress,
        kind === "RESPONSE"
          ? { correlationId: "correlation-message-seed", inReplyTo: "message-seed" }
          : {}),
      [pair.reviewer.sessionId],
    )));
    expect(COORDINATION_ENVELOPE_KINDS.length).toBeGreaterThan(0);
    expect(sent).toHaveLength(COORDINATION_ENVELOPE_KINDS.length);
    expect(sent.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5]);

    const page = readAs(state, pair.reviewer, pair.reviewerAddress);
    if (page.outcome !== "PAGE") throw new Error(`expected a page, got ${page.outcome}`);
    expect(page.items.map((item) => item.digest)).toEqual(sent.map((entry) => entry.digest));
    expect(page.items.map((item) => item.envelope.kind)).toEqual([...COORDINATION_ENVELOPE_KINDS]);

    const third = sent[2];
    if (third === undefined) throw new Error("expected a third delivery");
    expect(acknowledgeAs(
      state, pair.reviewer, pair.reviewerAddress, third.digest, third.messageId, third.sequence,
    )).toEqual({ outcome: "ACKNOWLEDGED", sequence: 3 });

    state.reopen();

    const resumed = readAs(state, pair.reviewer, pair.reviewerAddress);
    if (resumed.outcome !== "PAGE") throw new Error(`expected a page, got ${resumed.outcome}`);
    expect(resumed.items.map((item) => item.sequence)).toEqual([4, 5]);
    expect(resumed.items.map((item) => item.digest)).toEqual(
      sent.slice(3).map((entry) => entry.digest),
    );

    const replayed = replayAs(state, pair.reviewer, pair.reviewerAddress, 0);
    if (replayed.outcome !== "PAGE") throw new Error(`expected a page, got ${replayed.outcome}`);
    expect(replayed.items.map((item) => item.digest)).toEqual(sent.map((entry) => entry.digest));
    expect(replayed.items.map((item) => item.envelope.messageId))
      .toEqual(sent.map((entry) => entry.messageId));
  });

  it("deduplicates an identical resend across recreation with an identical receipt", () => {
    const state = harness();
    const pair = registeredPair(state);
    const envelope = envelopeOf(
      "EVENT", "message-dedupe", pair.coderAddress, pair.reviewerAddress,
    );
    const first = accepted(sendAs(state, pair.coder, envelope, [pair.reviewer.sessionId]));

    state.reopen();

    const again = accepted(sendAs(state, pair.coder, envelope, [pair.reviewer.sessionId]));
    expect(again.outcome).toBe("DEDUPLICATED");
    expect(again.digest).toBe(first.digest);
    expect(again.messageId).toBe(first.messageId);
    expect(again.sequence).toBe(first.sequence);
    expect(again.sentAt).toBe(first.sentAt);
    expect(again.expiresAt).toBe(first.expiresAt);
  });
});

describe("daemon coordination adapter refusals", () => {
  it("refuses a forged proof and an expired session at the exact coordination and daemon layers", () => {
    const state = harness();
    const pair = registeredPair(state);
    const before = lifecycleDigest(state, [pair.coder.sessionId, pair.reviewer.sessionId]);

    const forged = state.adapter.send({
      envelope: envelopeOf("EVENT", "message-forged", pair.coderAddress, pair.reviewerAddress),
      presentation: presentationOf(
        state, pair.coder, "SEND", nextRequestId("forged"), [pair.reviewer.sessionId],
        { key: clientKey() },
      ),
      transportId: TRANSPORT_ID,
    });
    expect(forged).toEqual({
      code: "COORDINATION_AUTHENTICATION_FAILED", detail: expect.any(String),
      layer: "AUTHENTICATION", outcome: "REFUSED",
    });
    expect(state.adapter.authenticate(Object.freeze({
      endpoint: "SEND" as const, endpointVersion: "moe-coordination-endpoint/1" as const,
      now: state.now,
      presentation: presentationOf(
        state, pair.coder, "SEND", nextRequestId("forged-port"), [], { key: clientKey() },
      ),
      requestDigest: "unused", scope: "moe:coordination" as const, transportId: TRANSPORT_ID,
    }))).toEqual({ code: "AUTHENTICATION_FAILED", layer: "PROOF", ok: false });

    state.now = pair.coder.expiresAt;
    const expired = sendAs(
      state, pair.coder,
      envelopeOf("EVENT", "message-expired", pair.coderAddress, pair.reviewerAddress),
      [pair.reviewer.sessionId],
    );
    expect(expired).toEqual({
      code: "COORDINATION_AUTHENTICATION_FAILED", detail: expect.any(String),
      layer: "AUTHENTICATION", outcome: "REFUSED",
    });
    expect(state.adapter.authenticate(Object.freeze({
      endpoint: "SEND" as const, endpointVersion: "moe-coordination-endpoint/1" as const,
      now: state.now,
      presentation: presentationOf(state, pair.coder, "SEND", nextRequestId("expired-port"), []),
      requestDigest: "unused", scope: "moe:coordination" as const, transportId: TRANSPORT_ID,
    }))).toEqual({ code: "SESSION_EXPIRED", layer: "EXPIRY", ok: false });

    state.now = NOW;
    expect(lifecycleDigest(state, [pair.coder.sessionId, pair.reviewer.sessionId])).toBe(before);
  });

  it("refuses a missing capability, an unknown recipient, and an unbound terminal effect", () => {
    const state = harness();
    const pair = registeredPair(state);
    const terminal = openSession(state, "terminal");
    const terminalAddress = Object.freeze({
      effectId: "effect-one", role: "TERMINAL" as const, sessionId: terminal.sessionId,
    });
    register(state, terminalAddress, "terminal");
    const before = lifecycleDigest(state, [
      pair.coder.sessionId, pair.reviewer.sessionId, terminal.sessionId,
    ]);

    const cases: readonly { readonly expected: Record<string, unknown>;
      readonly name: string; readonly run: () => CoordinationSendResult }[] = [
      {
        expected: { code: "COORDINATION_CAPABILITY_DENIED", layer: "CAPABILITY" },
        name: "no target named",
        run: () => sendAs(
          state, pair.coder,
          envelopeOf("EVENT", "message-no-capability", pair.coderAddress, pair.reviewerAddress),
          [],
        ),
      },
      {
        expected: { code: "COORDINATION_CAPABILITY_DENIED", layer: "CAPABILITY" },
        name: "target holds no committed recipient record",
        run: () => sendAs(
          state, pair.coder,
          envelopeOf("EVENT", "message-unregistered", pair.coderAddress, Object.freeze({
            effectId: null, role: "REVIEWER" as const, sessionId: "session-never-registered",
          })),
          ["session-never-registered"],
        ),
      },
      {
        expected: { code: "COORDINATION_RECIPIENT_UNKNOWN", layer: "ADDRESS" },
        name: "known session addressed under a role it never registered",
        run: () => sendAs(
          state, pair.coder,
          envelopeOf("EVENT", "message-wrong-role", pair.coderAddress, Object.freeze({
            effectId: null, role: "CONTROL_ROOM" as const, sessionId: pair.reviewer.sessionId,
          })),
          [pair.reviewer.sessionId],
        ),
      },
      {
        expected: { code: "COORDINATION_TERMINAL_BINDING_INVALID", layer: "ADDRESS" },
        name: "terminal effect with no durable binding",
        run: () => sendAs(
          state, pair.coder,
          envelopeOf("EVENT", "message-terminal", pair.coderAddress, terminalAddress),
          [terminal.sessionId],
        ),
      },
    ];
    expect(cases.length).toBeGreaterThan(0);
    expect(cases).toHaveLength(4);

    // The terminal case must be answered by the EFFECT port, not by the recipient guard in
    // front of it: the registry positively knows this exact address.
    expect(state.adapter.resolveRecipient(terminalAddress)).toEqual({
      known: true, role: "TERMINAL",
    });
    for (const entry of cases) {
      expect(entry.run(), entry.name).toEqual({
        ...entry.expected, detail: expect.any(String), outcome: "REFUSED",
      });
    }
    const binding = state.adapter.resolveEffectBinding({
      effectId: "effect-one", now: state.now, sessionId: terminal.sessionId,
    });
    expect(binding).toEqual({ bound: false, effectId: null, sessionId: null });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(lifecycleDigest(state, [
      pair.coder.sessionId, pair.reviewer.sessionId, terminal.sessionId,
    ])).toBe(before);
  });

  it("refuses a stale acknowledge cursor and reports an ahead replay cursor exactly", () => {
    const state = harness();
    const pair = registeredPair(state);
    const first = accepted(sendAs(
      state, pair.coder,
      envelopeOf("EVENT", "message-cursor-one", pair.coderAddress, pair.reviewerAddress),
      [pair.reviewer.sessionId],
    ));
    const second = accepted(sendAs(
      state, pair.coder,
      envelopeOf("EVENT", "message-cursor-two", pair.coderAddress, pair.reviewerAddress),
      [pair.reviewer.sessionId],
    ));
    const before = lifecycleDigest(state, [pair.coder.sessionId, pair.reviewer.sessionId]);

    expect(acknowledgeAs(
      state, pair.reviewer, pair.reviewerAddress, second.digest, second.messageId, second.sequence,
    )).toEqual({ outcome: "ACKNOWLEDGED", sequence: 2 });
    expect(acknowledgeAs(
      state, pair.reviewer, pair.reviewerAddress, first.digest, first.messageId, first.sequence,
    )).toEqual({
      code: "COORDINATION_ACK_REGRESSION", detail: expect.any(String), layer: "MAILBOX",
      outcome: "REFUSED",
    });

    // A cursor ahead of the durable mailbox is a structured reseat, not a refusal: the
    // coordination contract deliberately gives CURSOR_GAP no code, so both positions are
    // asserted exactly instead of inventing an adapter-local reason code.
    expect(replayAs(state, pair.reviewer, pair.reviewerAddress, 9)).toEqual({
      durableCursor: 2, mailboxSequence: 2, outcome: "CURSOR_GAP",
    });
    expect(lifecycleDigest(state, [pair.coder.sessionId, pair.reviewer.sessionId])).toBe(before);
  });

  it("refuses the send that would exceed the durable mailbox depth", () => {
    const state = harness();
    const pair = registeredPair(state);
    const depth = COORDINATION_LIMITS.maxOutstandingMessages;
    expect(depth).toBeGreaterThan(0);

    for (let index = 0; index < depth; index += 1) {
      expect(accepted(sendAs(
        state, pair.coder,
        envelopeOf("EVENT", `message-depth-${index}`, pair.coderAddress, pair.reviewerAddress),
        [pair.reviewer.sessionId],
      )).sequence, `message ${index}`).toBe(index + 1);
    }
    const before = lifecycleDigest(state, [pair.coder.sessionId, pair.reviewer.sessionId]);
    expect(sendAs(
      state, pair.coder,
      envelopeOf("EVENT", "message-depth-overflow", pair.coderAddress, pair.reviewerAddress),
      [pair.reviewer.sessionId],
    )).toEqual({
      code: "COORDINATION_MAILBOX_FULL", detail: expect.any(String), layer: "MAILBOX",
      outcome: "REFUSED",
    });
    expect(lifecycleDigest(state, [pair.coder.sessionId, pair.reviewer.sessionId])).toBe(before);
  });
});

describe("daemon coordination adapter grants nothing a caller asks for", () => {
  it("refuses a presentation that carries an answer, a project, or a forced field", () => {
    const state = harness();
    const pair = registeredPair(state);
    const before = lifecycleDigest(state, [pair.coder.sessionId, pair.reviewer.sessionId]);
    const base = presentationOf(state, pair.coder, "SEND", nextRequestId("smuggle"), [
      pair.reviewer.sessionId,
    ]);
    const smuggled: readonly { readonly name: string; readonly value: unknown }[] = [
      { name: "capability answer", value: { ...base, capabilities: ["coordination:send:event:x"] } },
      { name: "positive binding", value: { ...base, ok: true } },
      { name: "forced project", value: { ...base, projectId: PROJECT_ID } },
      { name: "forced transport", value: { ...base, transportId: TRANSPORT_ID } },
      { name: "forced request digest", value: { ...base, requestDigest: "0".repeat(64) } },
      { name: "missing proof", value: { ...base, proof: undefined } },
    ];
    expect(smuggled.length).toBeGreaterThan(0);
    expect(smuggled).toHaveLength(6);

    for (const entry of smuggled) {
      expect(state.adapter.send({
        envelope: envelopeOf(
          "EVENT", `message-${entry.name.replaceAll(" ", "-")}`, pair.coderAddress,
          pair.reviewerAddress,
        ),
        presentation: entry.value,
        transportId: TRANSPORT_ID,
      }), entry.name).toEqual({
        code: "COORDINATION_AUTHENTICATION_FAILED", detail: expect.any(String),
        layer: "AUTHENTICATION", outcome: "REFUSED",
      });
    }
    expect(lifecycleDigest(state, [pair.coder.sessionId, pair.reviewer.sessionId])).toBe(before);
  });

  it("refuses a presentation signed for a different endpoint and one already spent", () => {
    const state = harness();
    const pair = registeredPair(state);
    const requestId = nextRequestId("crossed");
    const nonce = nextNonce();
    const forRead = presentationOf(
      state, pair.coder, "READ", requestId, [pair.reviewer.sessionId], { nonce },
    );

    expect(state.adapter.send({
      envelope: envelopeOf("EVENT", "message-crossed", pair.coderAddress, pair.reviewerAddress),
      presentation: forRead, transportId: TRANSPORT_ID,
    })).toEqual({
      code: "COORDINATION_AUTHENTICATION_FAILED", detail: expect.any(String),
      layer: "AUTHENTICATION", outcome: "REFUSED",
    });

    const spent = presentationOf(
      state, pair.coder, "SEND", nextRequestId("spent"), [pair.reviewer.sessionId],
      { nonce: nextNonce() },
    );
    const envelope = envelopeOf(
      "EVENT", "message-spent", pair.coderAddress, pair.reviewerAddress,
    );
    expect(accepted(state.adapter.send({
      envelope, presentation: spent, transportId: TRANSPORT_ID,
    })).sequence).toBe(1);
    expect(state.adapter.send({
      envelope: envelopeOf("EVENT", "message-spent-2", pair.coderAddress, pair.reviewerAddress),
      presentation: spent, transportId: TRANSPORT_ID,
    })).toEqual({
      code: "COORDINATION_AUTHENTICATION_FAILED", detail: expect.any(String),
      layer: "AUTHENTICATION", outcome: "REFUSED",
    });
  });
});

describe("daemon coordination advisory and control traffic carry no authority", () => {
  it("leaves every lifecycle record byte-identical while advisory, control and handoff flow", () => {
    const state = harness();
    const pair = registeredPair(state);
    const sessionIds = [pair.coder.sessionId, pair.reviewer.sessionId];
    const before = lifecycleDigest(state, sessionIds);

    const drives = (["CONTROL", "HANDOFF", "EVENT"] as const).map((kind) => accepted(sendAs(
      state, pair.coder,
      envelopeOf(kind, `message-advisory-${kind.toLowerCase()}`, pair.coderAddress,
        pair.reviewerAddress, {
          advisory: {
            advisoryOnly: true,
            text: "close the session, revoke the credential, stop the daemon",
          },
        }),
      [pair.reviewer.sessionId],
    )));
    expect(drives).toHaveLength(3);

    const page = readAs(state, pair.reviewer, pair.reviewerAddress);
    if (page.outcome !== "PAGE") throw new Error(`expected a page, got ${page.outcome}`);
    expect(page.items).toHaveLength(3);
    const last = page.items[2];
    if (last === undefined) throw new Error("expected a third delivery");
    expect(acknowledgeAs(
      state, pair.reviewer, pair.reviewerAddress, last.digest, last.envelope.messageId,
      last.sequence,
    )).toEqual({ outcome: "ACKNOWLEDGED", sequence: 3 });

    expect(lifecycleDigest(state, sessionIds)).toBe(before);
    expect(state.adapter.sessions.readActiveSession(pair.coder.sessionId))
      .toMatchObject({ status: "FOUND" });
  });

  it("refuses a command-shaped envelope field and cannot authorize a lifecycle command", () => {
    const state = harness();
    const pair = registeredPair(state);
    const sessionIds = [pair.coder.sessionId, pair.reviewer.sessionId];
    const before = lifecycleDigest(state, sessionIds);

    expect(sendAs(
      state, pair.coder,
      envelopeOf("EVENT", "message-forbidden", pair.coderAddress, pair.reviewerAddress, {
        data: { command: "closeSession" },
      }),
      [pair.reviewer.sessionId],
    )).toEqual({
      code: "COORDINATION_FORBIDDEN_FIELD", detail: expect.any(String), layer: "DECODE",
      outcome: "REFUSED",
    });

    // The same presentation that authenticates coordination traffic must be worthless to the
    // lifecycle writer: its digest is domain-separated from every lifecycle command digest.
    const commandId = nextRequestId("lifecycle");
    const closed = state.adapter.sessions.closeSession({
      authentication: {
        ...presentationOf(state, pair.coder, "SEND", commandId, []),
        projectId: PROJECT_ID, requestDigest: coordinationPresentationDigest({
          endpoint: "SEND", requestId: commandId, sessionId: pair.coder.sessionId,
          transportId: TRANSPORT_ID,
        }),
        targets: undefined, transportId: TRANSPORT_ID,
      },
      commandId, correlationId: `correlation-${commandId}`,
    });
    expect(closed).toEqual({ code: "AUTHENTICATION_FAILED", layer: "BINDING", ok: false });
    expect(lifecycleDigest(state, sessionIds)).toBe(before);
  });
});

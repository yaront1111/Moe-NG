import { afterAll, describe, expect, it } from "vitest";

import {
  MAX_PROJECT_STACK_FRAME_BYTES,
  PROJECT_STACK_PROTOCOL_FRAME_TOO_LARGE,
  PROJECT_STACK_PROTOCOL_LAYER,
  PROJECT_STACK_PROTOCOL_MALFORMED,
  PROJECT_STACK_PROTOCOL_VERSION,
  decodeProjectStackControlLine,
  decodeProjectStackHostLine,
  encodeProjectStackControlFrame,
  encodeProjectStackHostFrame,
} from "./project-stack-protocol.js";
import type { ProjectStackControlFrame, ProjectStackHostFrame } from "./project-stack-protocol.js";

const INSTANCE = "123e4567-e89b-42d3-a456-426614174000";
const INCARNATION = "223e4567-e89b-42d3-a456-426614174001";

/** Every roster in this file is pinned at this exact, nonzero size. */
const ROSTER_SIZE = 4;

/** The only refusal the protocol layer may emit for a malformed line. */
const MALFORMED_REFUSAL = {
  code: PROJECT_STACK_PROTOCOL_MALFORMED,
  layer: PROJECT_STACK_PROTOCOL_LAYER,
  ok: false,
} as const;

/** The only refusal the protocol layer may emit before it parses an oversized line. */
const FRAME_TOO_LARGE_REFUSAL = {
  code: PROJECT_STACK_PROTOCOL_FRAME_TOO_LARGE,
  layer: PROJECT_STACK_PROTOCOL_LAYER,
  ok: false,
} as const;

interface MalformedControlCase {
  readonly frame: unknown;
  readonly label: string;
}

/**
 * Immutable roster of malformed/legacy control lines. Its exact size and label
 * set are asserted below, so deleting a member reddens instead of silently
 * shrinking the generated `it.each` fan-out.
 */
const MALFORMED_CONTROL_CASES: readonly MalformedControlCase[] = Object.freeze([
  {
    frame: {
      confirmationLabel: "ABCD-EF01-2345", instanceId: INSTANCE,
      kind: "APPROVE_PAIRING", schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    },
    label: "uppercase confirmation label",
  },
  {
    frame: {
      confirmationLabel: "abcd-ef01-2345", instanceId: "foreign",
      kind: "APPROVE_PAIRING", schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    },
    label: "foreign instance id",
  },
  {
    frame: {
      instanceId: INSTANCE, kind: "STOP", requestId: INSTANCE,
      schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    },
    label: "legacy requestId on STOP",
  },
  {
    frame: {
      instanceId: INSTANCE, kind: "OPEN_TICKET",
      schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    },
    label: "unknown OPEN_TICKET kind",
  },
]);

const MALFORMED_CONTROL_LABELS: readonly string[] = [
  "uppercase confirmation label",
  "foreign instance id",
  "legacy requestId on STOP",
  "unknown OPEN_TICKET kind",
];

/**
 * Immutable roster of secret-free host frames. Exact size and kind order are
 * asserted below, and the sweep records what it actually executed, so a deleted
 * member cannot shrink coverage while every count line stays put.
 */
const SECRET_FREE_HOST_FRAMES: readonly ProjectStackHostFrame[] = Object.freeze([
  {
    incarnationId: INCARNATION, instanceId: INSTANCE, kind: "READY",
    origin: "http://127.0.0.1:43123", projectId: "project-a",
    schemaVersion: PROJECT_STACK_PROTOCOL_VERSION, storePath: "C:\\work\\.moe\\store.sqlite",
  },
  {
    incarnationId: INCARNATION, instanceId: INSTANCE, kind: "PAIRING_APPROVED",
    schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
  },
  {
    code: "PAIRING_CONFIRMATION_UNKNOWN", incarnationId: INCARNATION,
    instanceId: INSTANCE, kind: "PAIRING_REFUSED", layer: "CONTROL_ROOM_PAIRING_APPROVAL",
    schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
  },
  {
    exitCode: 0, incarnationId: INCARNATION, instanceId: INSTANCE, kind: "TERMINAL",
    schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
  },
]);

const SECRET_FREE_HOST_KINDS: readonly string[] = [
  "READY", "PAIRING_APPROVED", "PAIRING_REFUSED", "TERMINAL",
];

const executedMalformedLabels: string[] = [];

describe("private project-stack approval protocol", () => {
  afterAll(() => {
    expect(executedMalformedLabels).toEqual(MALFORMED_CONTROL_LABELS);
    expect(executedMalformedLabels).toHaveLength(ROSTER_SIZE);
  });

  it("pins the malformed control roster at exactly four unique cases", () => {
    expect(MALFORMED_CONTROL_CASES).toHaveLength(ROSTER_SIZE);
    expect(MALFORMED_CONTROL_CASES.map((entry) => entry.label)).toEqual(MALFORMED_CONTROL_LABELS);
    expect(new Set(MALFORMED_CONTROL_CASES.map((entry) => entry.label)).size).toBe(ROSTER_SIZE);
    expect(Object.isFrozen(MALFORMED_CONTROL_CASES)).toBe(true);
  });

  it("round-trips an instance-bound approval without a request id or bearer", () => {
    const frame: ProjectStackControlFrame = {
      confirmationLabel: "abcd-ef01-2345",
      instanceId: INSTANCE,
      kind: "APPROVE_PAIRING",
      schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    };
    const encoded = encodeProjectStackControlFrame(frame);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) throw new Error(encoded.code);
    expect(encoded.line).not.toMatch(/requestId|pairingToken|credential/u);
    expect(decodeProjectStackControlLine(encoded.line)).toEqual({ frame, ok: true });
  });

  it("round-trips STOP bound to the same instance", () => {
    const frame: ProjectStackControlFrame = {
      instanceId: INSTANCE, kind: "STOP", schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    };
    const encoded = encodeProjectStackControlFrame(frame);
    if (!encoded.ok) throw new Error(encoded.code);
    expect(decodeProjectStackControlLine(encoded.line)).toEqual({ frame, ok: true });
  });

  it.each(MALFORMED_CONTROL_CASES)("refuses $label at the protocol layer", ({ frame, label }) => {
    executedMalformedLabels.push(label);
    expect(decodeProjectStackControlLine(JSON.stringify(frame))).toEqual(MALFORMED_REFUSAL);
  });
});

describe("secret-free project-stack host protocol", () => {
  it("pins the secret-free host roster at exactly four unique kinds", () => {
    expect(SECRET_FREE_HOST_FRAMES).toHaveLength(ROSTER_SIZE);
    expect(SECRET_FREE_HOST_FRAMES.map((frame) => frame.kind)).toEqual(SECRET_FREE_HOST_KINDS);
    expect(new Set(SECRET_FREE_HOST_FRAMES.map((frame) => frame.kind)).size).toBe(ROSTER_SIZE);
    expect(Object.isFrozen(SECRET_FREE_HOST_FRAMES)).toBe(true);
  });

  it("round-trips only secret-free host frames", () => {
    const swept: string[] = [];
    for (const frame of SECRET_FREE_HOST_FRAMES) {
      const encoded = encodeProjectStackHostFrame(frame);
      expect(encoded.ok).toBe(true);
      if (!encoded.ok) continue;
      expect(encoded.line).not.toMatch(/requestId|confirmationLabel|pairingToken|credential/u);
      expect(decodeProjectStackHostLine(encoded.line)).toEqual({ frame, ok: true });
      swept.push(frame.kind);
    }
    expect(swept).toEqual(SECRET_FREE_HOST_KINDS);
    expect(swept).toHaveLength(ROSTER_SIZE);
  });

  it("bounds UTF-8 bytes before parsing and rejects trailing frames", () => {
    const oversized = "\u00e9".repeat(MAX_PROJECT_STACK_FRAME_BYTES);
    expect(new TextEncoder().encode(oversized).byteLength)
      .toBeGreaterThan(MAX_PROJECT_STACK_FRAME_BYTES);
    expect(decodeProjectStackHostLine(oversized)).toEqual(FRAME_TOO_LARGE_REFUSAL);
    const encoded = encodeProjectStackHostFrame(SECRET_FREE_HOST_FRAMES[0] as ProjectStackHostFrame);
    if (!encoded.ok) throw new Error(encoded.code);
    expect(decodeProjectStackHostLine(encoded.line + encoded.line)).toEqual(MALFORMED_REFUSAL);
  });
});

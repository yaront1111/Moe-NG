import { describe, expect, it } from "vitest";

import {
  MAX_PROJECT_STACK_FRAME_BYTES,
  PROJECT_STACK_PROTOCOL_FRAME_TOO_LARGE,
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

describe("private project-stack approval protocol", () => {
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

  it.each([
    { confirmationLabel: "ABCD-EF01-2345", instanceId: INSTANCE, kind: "APPROVE_PAIRING", schemaVersion: PROJECT_STACK_PROTOCOL_VERSION },
    { confirmationLabel: "abcd-ef01-2345", instanceId: "foreign", kind: "APPROVE_PAIRING", schemaVersion: PROJECT_STACK_PROTOCOL_VERSION },
    { instanceId: INSTANCE, kind: "STOP", requestId: INSTANCE, schemaVersion: PROJECT_STACK_PROTOCOL_VERSION },
    { instanceId: INSTANCE, kind: "OPEN_TICKET", schemaVersion: PROJECT_STACK_PROTOCOL_VERSION },
  ])("rejects malformed or legacy control frame", (frame) => {
    expect(decodeProjectStackControlLine(JSON.stringify(frame))).toMatchObject({
      code: PROJECT_STACK_PROTOCOL_MALFORMED, ok: false,
    });
  });
});

describe("secret-free project-stack host protocol", () => {
  const frames: readonly ProjectStackHostFrame[] = [
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
  ];

  it("round-trips only secret-free host frames", () => {
    for (const frame of frames) {
      const encoded = encodeProjectStackHostFrame(frame);
      expect(encoded.ok).toBe(true);
      if (!encoded.ok) continue;
      expect(encoded.line).not.toMatch(/requestId|confirmationLabel|pairingToken|credential/u);
      expect(decodeProjectStackHostLine(encoded.line)).toEqual({ frame, ok: true });
    }
  });

  it("bounds UTF-8 bytes before parsing and rejects trailing frames", () => {
    expect(decodeProjectStackHostLine("é".repeat(MAX_PROJECT_STACK_FRAME_BYTES))).toMatchObject({
      code: PROJECT_STACK_PROTOCOL_FRAME_TOO_LARGE, ok: false,
    });
    const encoded = encodeProjectStackHostFrame(frames[0] as ProjectStackHostFrame);
    if (!encoded.ok) throw new Error(encoded.code);
    expect(decodeProjectStackHostLine(encoded.line + encoded.line)).toMatchObject({ ok: false });
  });
});

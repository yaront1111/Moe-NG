import { RUNTIME_COMMAND_KINDS, decodeBoundedJsonBytes } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import {
  BOOTSTRAP_COMMAND_KINDS,
  BOOTSTRAP_REQUEST_KEYS,
  BOOTSTRAP_SCHEMA_VERSION,
  decodeBootstrapRequestBytes,
} from "./bootstrap-contracts.js";

const encoder = new TextEncoder();

/**
 * The ten kinds this surface owns, restated as a literal rather than derived from the
 * production list: set equality against a derived list is vacuous, because an eleventh kind
 * added to production would silently appear on both sides of the comparison.
 */
const OWNED_KINDS = [
  "approval.decide",
  "goal.close",
  "goal.create",
  "plan.propose",
  "policy.install",
  "policy.validate",
  "project.activate",
  "project.bind_repository",
  "project.register",
  "provider.probe",
] as const;

function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function validEnvelope(): Record<string, unknown> {
  return {
    commandId: "cmd-1",
    correlationId: "corr-1",
    decidedAt: "2026-08-08T00:00:00.000Z",
    expectedVersion: 0,
    kind: "project.register",
    payload: { owner: "owner-1", projectId: "project-1" },
    principalId: "principal-1",
    projectId: "project-1",
    schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
  };
}

describe("bootstrap command vocabulary", () => {
  it("covers exactly the ten command kinds this surface owns", () => {
    expect(new Set<string>(BOOTSTRAP_COMMAND_KINDS)).toEqual(new Set<string>(OWNED_KINDS));
    expect(BOOTSTRAP_COMMAND_KINDS).toHaveLength(10);
    expect(OWNED_KINDS).toHaveLength(10);
  });

  it("names only kinds that exist in the runtime command vocabulary", () => {
    const vocabulary = new Set<string>(RUNTIME_COMMAND_KINDS);
    const unknown = BOOTSTRAP_COMMAND_KINDS.filter((kind) => !vocabulary.has(kind));
    expect(unknown).toEqual([]);
  });

  it("pins the envelope key list and schema version", () => {
    expect([...BOOTSTRAP_REQUEST_KEYS]).toEqual([
      "commandId",
      "correlationId",
      "decidedAt",
      "expectedVersion",
      "kind",
      "payload",
      "principalId",
      "projectId",
      "schemaVersion",
    ]);
    expect(BOOTSTRAP_SCHEMA_VERSION).toBe("moe-bootstrap-command/1");
  });
});

describe("bootstrap request ingress", () => {
  it("accepts an exact envelope", () => {
    const result = decodeBootstrapRequestBytes(bytes(validEnvelope()));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected acceptance");
    expect(result.request.kind).toBe("project.register");
    expect(result.request.expectedVersion).toBe(0);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("surfaces the decode error verbatim for unparseable input", () => {
    const raw = encoder.encode("{ not json");
    const decoded = decodeBoundedJsonBytes(raw);
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("expected a decode failure fixture");

    const result = decodeBootstrapRequestBytes(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("BOOTSTRAP_INPUT_REJECTED");
    expect(result.refusedBy).toBe("DAEMON_INGRESS");
    if (result.code !== "BOOTSTRAP_INPUT_REJECTED") throw new Error("expected decode refusal");
    expect(result.decodeError).toEqual(decoded);
    expect(result.decodeError.code).toBe(decoded.code);
    expect(result.decodeError.message).toBe(decoded.message);
  });

  it("refuses an envelope carrying an extra key", () => {
    const result = decodeBootstrapRequestBytes(
      bytes({ ...validEnvelope(), unexpected: "extra" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("BOOTSTRAP_REQUEST_INVALID");
    expect(result.refusedBy).toBe("DAEMON_INGRESS");
  });

  it("refuses an envelope missing a required key", () => {
    const envelope = validEnvelope();
    delete envelope["principalId"];
    const result = decodeBootstrapRequestBytes(bytes(envelope));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("BOOTSTRAP_REQUEST_INVALID");
    expect(result.refusedBy).toBe("DAEMON_INGRESS");
  });

  it("refuses a wrong schema version", () => {
    const result = decodeBootstrapRequestBytes(
      bytes({ ...validEnvelope(), schemaVersion: "moe-bootstrap-command/2" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("BOOTSTRAP_REQUEST_INVALID");
    expect(result.refusedBy).toBe("DAEMON_INGRESS");
  });

  it("refuses a command kind outside the owned nine", () => {
    const result = decodeBootstrapRequestBytes(
      bytes({ ...validEnvelope(), kind: "work.claim" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("BOOTSTRAP_COMMAND_UNKNOWN");
    expect(result.refusedBy).toBe("DAEMON_INGRESS");
  });

  it("refuses a non-integer expected version", () => {
    const result = decodeBootstrapRequestBytes(
      bytes({ ...validEnvelope(), expectedVersion: 1.5 }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("BOOTSTRAP_REQUEST_INVALID");
  });

  it("refuses a non-object payload", () => {
    const result = decodeBootstrapRequestBytes(bytes({ ...validEnvelope(), payload: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("BOOTSTRAP_REQUEST_INVALID");
  });
});

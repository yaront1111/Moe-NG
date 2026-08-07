import { describe, expect, it } from "vitest";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";

import {
  FAKE_REQUEST_DIGEST,
  buildCommandEnvelopeRecord,
  buildLeaseAuthority,
  createExportSurfacePort,
  createFixedClock,
  createRecordingDispatchPort,
  encodeCanonicalBytes,
  exportNames,
} from "./foundation-fakes.js";

describe("createFixedClock", () => {
  it("returns the caller's instants in order", () => {
    const clock = createFixedClock(["2026-08-07T00:00:00.000Z", "2026-08-07T00:00:01.000Z"]);
    expect(clock.next()).toBe("2026-08-07T00:00:00.000Z");
    expect(clock.next()).toBe("2026-08-07T00:00:01.000Z");
  });

  it("throws instead of recycling when a schedule reads more than it declared", () => {
    const clock = createFixedClock(["2026-08-07T00:00:00.000Z"]);
    clock.next();
    expect(() => clock.next()).toThrowError(/Fixed clock exhausted after 1 instants/u);
  });
});

describe("createRecordingDispatchPort", () => {
  it("records every dispatched command in order", () => {
    const port = createRecordingDispatchPort({ "goal.create": "ACCEPTED", "goal.cancel": "REFUSED" });
    expect(port.dispatch("goal.create")).toBe("ACCEPTED");
    expect(port.dispatch("goal.cancel")).toBe("REFUSED");
    expect(port.recorded()).toEqual([
      { commandKind: "goal.create", outcome: "ACCEPTED" },
      { commandKind: "goal.cancel", outcome: "REFUSED" },
    ]);
  });

  it("throws on an undeclared kind rather than inventing a default outcome", () => {
    const port = createRecordingDispatchPort({});
    expect(() => port.dispatch("goal.create")).toThrowError(
      /No fake outcome declared for goal.create/u,
    );
    expect(port.recorded()).toEqual([]);
  });
});

describe("createExportSurfacePort", () => {
  it("returns the supplied names sorted", () => {
    const port = createExportSurfacePort({ "@moe/core": ["reduceProject", "GOAL_TRANSITIONS"] });
    expect(port.exportNamesOf("@moe/core")).toEqual(["GOAL_TRANSITIONS", "reduceProject"]);
  });

  it("throws for a package whose surface was never supplied", () => {
    const port = createExportSurfacePort({});
    expect(() => port.exportNamesOf("@moe/store")).toThrowError(
      /No export surface supplied for @moe\/store/u,
    );
  });
});

describe("exportNames", () => {
  it("returns sorted own keys of a namespace object", () => {
    expect(exportNames({ zebra: 1, alpha: 2 })).toEqual(["alpha", "zebra"]);
  });
});

describe("buildCommandEnvelopeRecord", () => {
  it("defaults to a record with exactly the required envelope keys", () => {
    const record = buildCommandEnvelopeRecord("goal.create");
    expect(Object.keys(record).sort()).toEqual([
      "commandId", "commandKind", "correlationId", "expectedVersion", "payload",
      "requestDigest", "schemaVersion", "sessionCredential", "targetAggregateId",
    ]);
    expect(record["schemaVersion"]).toBe(RUNTIME_COMMAND_ENVELOPE_VERSION);
    expect(record["requestDigest"]).toBe(FAKE_REQUEST_DIGEST);
  });

  it("adds leaseAuthority only when the caller supplies one", () => {
    const record = buildCommandEnvelopeRecord("goal.create", {
      leaseAuthority: buildLeaseAuthority(4, 2),
    });
    expect(record["leaseAuthority"]).toEqual({
      attemptBindingVersion: 1,
      authorityHash: FAKE_REQUEST_DIGEST,
      epoch: 4,
      graphEpoch: 2,
      leaseToken: "lease-4",
    });
  });

  it("overrides exactly the field a hostile schedule names", () => {
    const record = buildCommandEnvelopeRecord("goal.create", { schemaVersion: "moe-runtime-command/0" });
    expect(record["schemaVersion"]).toBe("moe-runtime-command/0");
    expect(record["commandId"]).toBe("command-1");
  });
});

describe("encodeCanonicalBytes", () => {
  it("encodes key order canonically, so equal records give equal bytes", () => {
    const left = encodeCanonicalBytes({ b: 1, a: 2 });
    const right = encodeCanonicalBytes({ a: 2, b: 1 });
    expect(new TextDecoder().decode(left)).toBe('{"a":2,"b":1}');
    expect(left).toEqual(right);
  });
});

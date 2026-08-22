import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FOUNDATION_RECEIPT_REFUSAL_CODES,
  FOUNDATION_RECEIPT_SCHEMA_VERSION,
  buildReadinessReceipt,
  buildShutdownReceipt,
  createFoundationReceiptPublisher,
  encodeReceipt,
} from "./foundation-receipts.js";
import type {
  FoundationReadinessInput,
  FoundationReceipt,
  FoundationReceiptResult,
  FoundationShutdownInput,
} from "./foundation-receipts.js";

/**
 * The host receipts J3 reads. Two properties carry the whole module:
 *
 * 1. DETERMINISTIC MEANS NO CLOCK. Identical inputs encode to identical BYTES,
 *    and the production source reads no clock at all — every instant arrives as
 *    a validated input, so "deterministic" is a property of the type rather than
 *    a promise in a comment.
 * 2. FAIL CLOSED WITH A CODE AND A LAYER. Absent identity, an unusable instant,
 *    a shutdown before readiness was ever published, and a SECOND shutdown are
 *    each refused BY NAME rather than published with an invented value or
 *    swallowed silently.
 */

const LAYER = "FOUNDATION_RECEIPTS";
const INSTANT = "2026-08-18T19:04:05.006Z";

const READY: FoundationReadinessInput = {
  entry: "MCP_STDIO",
  instant: INSTANT,
  pid: 4321,
  projectId: "proj-receipts",
  storePath: "D:/store/receipts.db",
};

const STOPPED: FoundationShutdownInput = { ...READY, trigger: "TRANSPORT_CLOSED" };

const encoder = new TextEncoder();

function lineOf(result: FoundationReceiptResult<FoundationReceipt>): string {
  if (!result.ok) throw new Error(`expected a receipt, got ${result.code}`);
  return encodeReceipt(result.receipt);
}

describe("foundation host receipts", () => {
  it("builds a readiness receipt carrying process, project and store identity", () => {
    const built = buildReadinessReceipt(READY);
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("unreachable");
    expect(built.receipt).toEqual({
      entry: "MCP_STDIO",
      instant: INSTANT,
      kind: "READY",
      pid: 4321,
      projectId: "proj-receipts",
      schemaVersion: FOUNDATION_RECEIPT_SCHEMA_VERSION,
      storePath: "D:/store/receipts.db",
    });
  });

  it("builds a shutdown receipt naming the drain trigger", () => {
    const built = buildShutdownReceipt(STOPPED);
    if (!built.ok) throw new Error(`expected a receipt, got ${built.code}`);
    expect(built.receipt).toMatchObject({ kind: "SHUTDOWN", trigger: "TRANSPORT_CLOSED" });
  });

  it("encodes two builds over identical inputs to identical BYTES", () => {
    const first = encoder.encode(lineOf(buildReadinessReceipt(READY)));
    const second = encoder.encode(lineOf(buildReadinessReceipt({ ...READY })));
    expect([...second]).toEqual([...first]);
    expect([...encoder.encode(lineOf(buildShutdownReceipt(STOPPED)))])
      .toEqual([...encoder.encode(lineOf(buildShutdownReceipt({ ...STOPPED })))]);
    // A different instant must still be VISIBLE, or byte-identity would also be
    // satisfied by a builder that dropped the field.
    expect(lineOf(buildReadinessReceipt({ ...READY, instant: "2026-08-18T19:04:05.007Z" })))
      .not.toBe(lineOf(buildReadinessReceipt(READY)));
  });

  it("encodes one line with no embedded newline, so a receipt is one stderr record", () => {
    const line = lineOf(buildShutdownReceipt(STOPPED));
    expect(line.includes("\n")).toBe(false);
    expect(JSON.parse(line)).toMatchObject({ kind: "SHUTDOWN", projectId: "proj-receipts" });
  });

  it("reads no clock in its production source", () => {
    const source = readFileSync(join(import.meta.dirname, "foundation-receipts.ts"), "utf8");
    // Positive control: an unreadable or empty source must not pass vacuously.
    expect(source.length).toBeGreaterThan(500);
    expect(source).toContain("export function buildReadinessReceipt");
    expect(/\bDate\s*\.\s*now\s*\(/u.test(source)).toBe(false);
    expect(/\bnew\s+Date\s*\(/u.test(source)).toBe(false);
    expect(/\bperformance\s*\.\s*now\s*\(/u.test(source)).toBe(false);
  });
});

describe("foundation receipt refusals", () => {
  const CASES: readonly {
    readonly build: () => { readonly ok: boolean; readonly code?: string; readonly layer?: string };
    readonly code: string;
    readonly name: string;
  }[] = [
    {
      build: () => buildReadinessReceipt({ ...READY, storePath: "" }),
      code: "FOUNDATION_RECEIPT_STORE_IDENTITY_ABSENT",
      name: "an absent store identity",
    },
    {
      build: () => buildReadinessReceipt({ ...READY, projectId: "" }),
      code: "FOUNDATION_RECEIPT_PROJECT_IDENTITY_ABSENT",
      name: "an absent project identity",
    },
    {
      build: () => buildReadinessReceipt({ ...READY, pid: 0 }),
      code: "FOUNDATION_RECEIPT_PROCESS_IDENTITY_INVALID",
      name: "a process identity that is not a live pid",
    },
    {
      build: () => buildReadinessReceipt({ ...READY, instant: "2026-08-18 19:04:05Z" }),
      code: "FOUNDATION_RECEIPT_INSTANT_INVALID",
      name: "an instant that is not a UTC millisecond stamp",
    },
    {
      build: () => buildShutdownReceipt({ ...STOPPED, trigger: "KILLED" }),
      code: "FOUNDATION_RECEIPT_SHUTDOWN_TRIGGER_INVALID",
      name: "a drain trigger outside the closed list",
    },
    {
      build: () => buildShutdownReceipt({ ...STOPPED, storePath: "" }),
      code: "FOUNDATION_RECEIPT_STORE_IDENTITY_ABSENT",
      name: "an absent store identity on the shutdown half",
    },
  ];

  // A sweep that silently produced zero cases would pass while testing nothing.
  it("sweeps a positive number of refusal cases", () => {
    expect(CASES.length).toBe(6);
  });

  it.each(CASES)("refuses $name with its own code and layer", ({ build, code }) => {
    const outcome = build();
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe(code);
    expect(outcome.layer).toBe(LAYER);
  });

  it("publishes a closed refusal roster no case may drift from", () => {
    expect([...FOUNDATION_RECEIPT_REFUSAL_CODES]).toEqual([
      "FOUNDATION_RECEIPT_ALREADY_READY",
      "FOUNDATION_RECEIPT_ALREADY_STOPPED",
      "FOUNDATION_RECEIPT_INSTANT_INVALID",
      "FOUNDATION_RECEIPT_PROCESS_IDENTITY_INVALID",
      "FOUNDATION_RECEIPT_PROJECT_IDENTITY_ABSENT",
      "FOUNDATION_RECEIPT_SHUTDOWN_BEFORE_READY",
      "FOUNDATION_RECEIPT_SHUTDOWN_TRIGGER_INVALID",
      "FOUNDATION_RECEIPT_STORE_IDENTITY_ABSENT",
    ]);
    expect(Object.isFrozen(FOUNDATION_RECEIPT_REFUSAL_CODES)).toBe(true);
  });
});

describe("foundation receipt publisher", () => {
  function publisher(): {
    readonly lines: string[];
    readonly port: ReturnType<typeof createFoundationReceiptPublisher>;
  } {
    const lines: string[] = [];
    return { lines, port: createFoundationReceiptPublisher({ sink: (l) => lines.push(l) }) };
  }

  it("publishes readiness exactly once and refuses a second by name", () => {
    const { lines, port } = publisher();
    expect(port.publishReadiness(READY).ok).toBe(true);
    const second = port.publishReadiness(READY);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.code).toBe("FOUNDATION_RECEIPT_ALREADY_READY");
    expect(second.layer).toBe(LAYER);
    expect(lines.length).toBe(1);
  });

  it("refuses a shutdown receipt before readiness was ever published", () => {
    const { lines, port } = publisher();
    const refused = port.publishShutdown(STOPPED);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.code).toBe("FOUNDATION_RECEIPT_SHUTDOWN_BEFORE_READY");
    expect(refused.layer).toBe(LAYER);
    expect(lines).toEqual([]);
  });

  it("refuses a SECOND shutdown by refusal rather than silently", () => {
    const { lines, port } = publisher();
    port.publishReadiness(READY);
    expect(port.publishShutdown(STOPPED).ok).toBe(true);
    const again = port.publishShutdown(STOPPED);
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error("unreachable");
    expect(again.code).toBe("FOUNDATION_RECEIPT_ALREADY_STOPPED");
    expect(again.layer).toBe(LAYER);
    expect(lines.length).toBe(2);
    expect(lines.filter((line) => line.includes("\"SHUTDOWN\"")).length).toBe(1);
  });

  it("forwards a builder refusal verbatim and writes nothing", () => {
    const { lines, port } = publisher();
    const refused = port.publishReadiness({ ...READY, storePath: "" });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.code).toBe("FOUNDATION_RECEIPT_STORE_IDENTITY_ABSENT");
    expect(refused.layer).toBe(LAYER);
    expect(lines).toEqual([]);
    // A refused readiness never counts as published: the shutdown half still
    // refuses, so a broken identity cannot open the drain path.
    expect(port.publishShutdown(STOPPED)).toMatchObject({
      code: "FOUNDATION_RECEIPT_SHUTDOWN_BEFORE_READY", layer: LAYER, ok: false,
    });
  });

  it("publishes the readiness line the pure builder encodes, byte for byte", () => {
    const { lines, port } = publisher();
    const published = port.publishReadiness(READY);
    if (!published.ok) throw new Error("unreachable");
    expect(published.line).toBe(lineOf(buildReadinessReceipt(READY)));
    expect(lines[0]).toBe(published.line);
  });
});

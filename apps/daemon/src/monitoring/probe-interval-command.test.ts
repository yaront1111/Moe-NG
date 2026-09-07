import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { expect, it } from "vitest";

import { DomainRefusal } from "../daemon-command-dispatch.js";
import {
  PROBE_INTERVAL_EDGE_RESULT_CODE, runProbeIntervalCommand,
} from "./probe-interval-command.js";
import {
  MAX_PROBE_INTERVAL_MS, MIN_PROBE_INTERVAL_MS, createProbeIntervalRecord,
} from "./probe-interval-record.js";
import type { ProbeIntervalRecord, ProbeIntervalResult } from "./probe-interval-record.js";

const PROJECT = "probe-interval-command-test";
const AGGREGATE = `probe-interval/${PROJECT}`;

async function withRecord(
  body: (record: ProbeIntervalRecord, store: SqliteEventStore) => void | Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "moe-probe-interval-command-"));
  const store = SqliteEventStore.openForProject(join(root, "store.db"), PROJECT);
  try { await body(createProbeIntervalRecord({ store, projectId: PROJECT }), store); }
  finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}

/**
 * A RECORDING WRAPPER, not a fake: it forwards to the REAL record and keeps the argument list.
 * A stub answering on its own would let this file assert a contract the production port does not
 * have, which is the failure mode a port test exists to avoid.
 */
interface Recorded {
  readonly calls: (readonly [string, number])[];
  readonly record: ProbeIntervalRecord;
}
function recording(inner: ProbeIntervalRecord): Recorded {
  const calls: (readonly [string, number])[] = [];
  return {
    calls,
    record: {
      read: inner.read,
      stored: inner.stored,
      write: (environment: string, intervalMs: number): ProbeIntervalResult<number> => {
        calls.push([environment, intervalMs]);
        return inner.write(environment, intervalMs);
      },
    },
  };
}

/** Refusals are caught rather than matched on a return: this edge THROWS `DomainRefusal`. */
function refusalOf(intervals: ProbeIntervalRecord, payload: Record<string, unknown>): DomainRefusal {
  try {
    runProbeIntervalCommand({ envelope: { commandId: "cmd-probe", payload }, intervals });
  } catch (error) {
    if (error instanceof DomainRefusal) return error;
    throw error;
  }
  throw new Error("the edge accepted a request this arm expects it to refuse");
}

it("writes through the port EXACTLY ONCE with the decoded values, and nowhere else", async () => {
  await withRecord((inner, store) => {
    const spy = recording(inner);
    const decision = runProbeIntervalCommand({
      envelope: {
        commandId: "cmd-probe-happy",
        payload: { environment: "production", intervalMs: 30_000 },
      },
      intervals: spy.record,
    });

    expect(decision).toEqual({
      commandId: "cmd-probe-happy", disposition: "DECIDED", effectId: null,
      resultCode: PROBE_INTERVAL_EDGE_RESULT_CODE,
    });
    // EXACTLY ONCE and with EXACTLY the wire's values: a second call would be a retry the edge
    // invented, and a transformed value would be an interpretation the record never authorised.
    expect(spy.calls).toEqual([["production", 30_000]]);
    // AND THE DURABLE SIDE, so "called the port" cannot pass for "wrote". ONE event, not two:
    // an edge with a second write path would land the same interval twice.
    expect(store.readEvents(AGGREGATE)).toHaveLength(1);
    expect(inner.read("production")).toEqual({ ok: true, value: 30_000 });
  });
});

/**
 * DoD 3: CODE **AND** LAYER, AND WHICH LAYER ANSWERED.
 *
 * Three surfaces can refuse this call -- the edge, the record, and the store beneath it -- and
 * all three would satisfy an arm that only checked a code. `spy.calls` is what settles it: an
 * edge that had re-implemented the bound would refuse BEFORE calling the port and the recorded
 * call list would be EMPTY. Asserting the call reached the port with the caller's own values,
 * and that the answer is the port's code at the port's layer, is the pair that names the layer.
 */
it.each([
  ["an OUT-OF-RANGE interval, one millisecond under the floor",
    { environment: "production", intervalMs: MIN_PROBE_INTERVAL_MS - 1 },
    "PROBE_INTERVAL_OUT_OF_RANGE", ["production", MIN_PROBE_INTERVAL_MS - 1]],
  ["an OUT-OF-RANGE interval, one millisecond over the ceiling",
    { environment: "production", intervalMs: MAX_PROBE_INTERVAL_MS + 1 },
    "PROBE_INTERVAL_OUT_OF_RANGE", ["production", MAX_PROBE_INTERVAL_MS + 1]],
  ["an UNKNOWN environment the name rules cannot admit",
    { environment: "Production Web!", intervalMs: 30_000 },
    "PROBE_INTERVAL_ENVIRONMENT_INVALID", ["Production Web!", 30_000]],
] as const)("refuses %s with the RECORD's code and layer, after reaching it", async (
  _label, payload, code, forwarded,
) => {
  await withRecord((inner, store) => {
    const spy = recording(inner);
    const refusal = refusalOf(spy.record, { ...payload });

    expect({ code: refusal.code, layer: refusal.layer }).toEqual({ code, layer: "DAEMON_INGRESS" });
    // THE LAYER PROOF. The port was REACHED, with the caller's own values unaltered: the edge
    // did not decide this, it forwarded it. An edge holding its own copy of the bound would
    // never have made this call, and this list would be `[]`.
    expect(spy.calls).toEqual([forwarded]);
    // A refused write is not a quiet one: nothing durable, so a refusal can never be read as a
    // write that also complained.
    expect(store.readEvents(AGGREGATE)).toHaveLength(0);
  });
});

/**
 * THE ORDER IS THE RECORD'S TOO, and this is the sharpest layer discriminator available: with
 * BOTH fields invalid the record checks the ENVIRONMENT FIRST ("a caller naming an environment
 * that cannot exist is told THAT, rather than being told its interval is out of range for a
 * nonexistent target"). An edge that decoded and range-checked the number it had just read would
 * answer OUT_OF_RANGE here and stay green on every single-fault arm above.
 */
it("answers a doubly-invalid request in the RECORD's order, not the edge's", async () => {
  await withRecord((inner) => {
    const spy = recording(inner);
    const refusal = refusalOf(spy.record, { environment: "!!!", intervalMs: 1 });

    expect({ code: refusal.code, layer: refusal.layer })
      .toEqual({ code: "PROBE_INTERVAL_ENVIRONMENT_INVALID", layer: "DAEMON_INGRESS" });
    expect(refusal.code).not.toBe("PROBE_INTERVAL_OUT_OF_RANGE");
    expect(spy.calls).toEqual([["!!!", 1]]);
  });
});

/**
 * A WRONG-TYPED WIRE FIELD IS STILL THE RECORD'S ANSWER. JSON can deliver null, an object or
 * nothing at all where the record's signature says `string` or `number`, and the edge substitutes
 * a value the record's OWN admitters reject rather than minting a code of its own -- so a reader
 * chasing a refusal always lands in one module. The recorded call is what proves the
 * substitution happened at the boundary and not that the edge answered by itself.
 */
it.each([
  ["a MISSING environment", {}, "PROBE_INTERVAL_ENVIRONMENT_INVALID", ["", Number.NaN]],
  ["a NULL environment", { environment: null, intervalMs: 30_000 },
    "PROBE_INTERVAL_ENVIRONMENT_INVALID", ["", 30_000]],
  ["a NUMERIC environment", { environment: 7, intervalMs: 30_000 },
    "PROBE_INTERVAL_ENVIRONMENT_INVALID", ["", 30_000]],
  ["a STRING interval", { environment: "production", intervalMs: "30000" },
    "PROBE_INTERVAL_OUT_OF_RANGE", ["production", Number.NaN]],
  ["a MISSING interval", { environment: "production" },
    "PROBE_INTERVAL_OUT_OF_RANGE", ["production", Number.NaN]],
] as const)("refuses %s from the record's own vocabulary", async (
  _label, payload, code, forwarded,
) => {
  await withRecord((inner, store) => {
    const spy = recording(inner);
    const refusal = refusalOf(spy.record, { ...payload });

    expect({ code: refusal.code, layer: refusal.layer }).toEqual({ code, layer: "DAEMON_INGRESS" });
    expect(spy.calls).toEqual([forwarded]);
    expect(store.readEvents(AGGREGATE)).toHaveLength(0);
  });
});

/**
 * THE SUBSTITUTES MUST ACTUALLY BE REJECTED BY THE PRODUCTION RECORD, asserted against the
 * record itself rather than against the edge. If a future rule ever admitted `""` or `NaN`, the
 * arms above would keep passing while a malformed request silently WROTE -- this is the arm that
 * would red instead, and it is asserted on the production surface, never on a local copy.
 */
it("pins the two substitute values the edge relies on as rejected BY THE RECORD", async () => {
  await withRecord((record, store) => {
    expect(record.write("", 30_000))
      .toEqual({ ok: false, code: "PROBE_INTERVAL_ENVIRONMENT_INVALID", layer: "DAEMON_INGRESS" });
    expect(record.write("production", Number.NaN))
      .toEqual({ ok: false, code: "PROBE_INTERVAL_OUT_OF_RANGE", layer: "DAEMON_INGRESS" });
    // The control: the same record DOES accept a well-formed pair, so "rejects everything"
    // cannot green the two negatives above.
    expect(record.write("production", 30_000)).toEqual({ ok: true, value: 30_000 });
    expect(store.readEvents(AGGREGATE)).toHaveLength(1);
  });
});

/**
 * NO SECOND WRITE PATH, stated as a property of the edge's CONTEXT rather than as a comment: the
 * only collaborator it can reach is the port. A future edit handing it a store or a project id
 * would have to widen this object, and that is a visible change here.
 */
it("holds nothing but the port and the two envelope fields it reads", async () => {
  await withRecord((inner) => {
    const context = {
      envelope: { commandId: "cmd-probe-shape", payload: { environment: "staging", intervalMs: 5_000 } },
      intervals: inner,
    };
    expect(Object.keys(context).sort()).toEqual(["envelope", "intervals"]);
    expect(Object.keys(context.envelope).sort()).toEqual(["commandId", "payload"]);
    // `projectId` is nowhere in the request: it comes from the composition that built the port.
    expect(Object.keys(context.envelope.payload)).not.toContain("projectId");
    expect(runProbeIntervalCommand(context).resultCode).toBe(PROBE_INTERVAL_EDGE_RESULT_CODE);
  });
});

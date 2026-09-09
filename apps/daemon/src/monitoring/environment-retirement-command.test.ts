import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { RuntimeCommandEnvelope } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { expect, it } from "vitest";

import { DomainRefusal } from "../daemon-command-dispatch.js";
import { OPERATOR_CAPABILITIES } from "../daemon-command-registry.js";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { readDeployLedger, recordDeployReceipt } from "../deployment/deploy-ledger.js";
import type { ScheduleTimer } from "../orchestrator/durable-schedule.js";
import { ENVIRONMENT_RETIREMENT_COMMAND_KIND } from "./environment-retirement-command-contracts.js";
import {
  ENVIRONMENT_RETIREMENT_EDGE_RESULT_CODE, runEnvironmentRetirementCommand,
} from "./environment-retirement-command.js";
import { createEnvironmentRetirementRecord } from "./environment-retirement-record.js";
import type {
  EnvironmentRetirementRecord, EnvironmentRetirementResult,
} from "./environment-retirement-record.js";
import { HEALTH_PROBE_SIDECAR_SUFFIX, HEALTH_PROBE_VERSION } from "./health-probe-contracts.js";
import { createHealthProbeRing } from "./health-probe-ring.js";
import { DEFAULT_PROBE_INTERVAL_MS } from "./probe-interval-record.js";

const PROJECT = "environment-retirement-command-test";
const AGGREGATE = `environment-retirement/${PROJECT}`;
const CREDENTIAL = "retirement-operator-credential";
const CLOCK = (): string => "2026-09-09T12:00:00.000Z";
const PORTS: Readonly<Record<string, number>> = { production: 49202, staging: 49201 };

function deploy(store: SqliteEventStore, environment: string, decisionId?: string): void {
  const result = recordDeployReceipt(store, {
    decidedAt: CLOCK(), decisionId: decisionId ?? `deploy-${environment}`, environment,
    imageDigest: `sha256:${"b".repeat(64)}`, projectId: PROJECT, refusal: null,
    releaseDecision: null, sha: "a".repeat(40), url: `http://127.0.0.1:${PORTS[environment]}`,
  });
  if (!result.ok) throw new Error(result.code);
}

async function withRecord(
  body: (record: EnvironmentRetirementRecord, store: SqliteEventStore) => void | Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "moe-environment-retirement-command-"));
  const store = SqliteEventStore.openForProject(join(root, "store.db"), PROJECT);
  try {
    deploy(store, "staging");
    await body(createEnvironmentRetirementRecord({ store, projectId: PROJECT }), store);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}

/**
 * A RECORDING WRAPPER, not a fake: it forwards to the REAL record and keeps the argument list.
 * A stub answering on its own would let this file assert a contract the production port does not
 * have, which is the failure mode a port test exists to avoid.
 */
interface Recorded {
  readonly calls: string[];
  readonly record: EnvironmentRetirementRecord;
}
function recording(inner: EnvironmentRetirementRecord): Recorded {
  const calls: string[] = [];
  return {
    calls,
    record: {
      read: inner.read,
      stored: inner.stored,
      write: (environment: string): EnvironmentRetirementResult<true> => {
        calls.push(environment);
        return inner.write(environment);
      },
    },
  };
}

/** Refusals are caught rather than matched on a return: this edge THROWS `DomainRefusal`. */
function refusalOf(
  retirements: EnvironmentRetirementRecord, payload: Record<string, unknown>,
): DomainRefusal {
  try {
    runEnvironmentRetirementCommand({
      envelope: { commandId: "cmd-retire", payload }, retirements,
    });
  } catch (error) {
    if (error instanceof DomainRefusal) return error;
    throw error;
  }
  throw new Error("the edge accepted a request this arm expects it to refuse");
}

// (a) THE FACT CHILD 1 OWNS IS ACTUALLY WRITTEN, and written once.
it("writes through the port EXACTLY ONCE with the decoded name, and nowhere else", async () => {
  await withRecord((inner, store) => {
    const spy = recording(inner);
    const decision = runEnvironmentRetirementCommand({
      envelope: { commandId: "cmd-retire-happy", payload: { environment: "staging" } },
      retirements: spy.record,
    });

    expect(decision).toEqual({
      commandId: "cmd-retire-happy", disposition: "DECIDED", effectId: null,
      resultCode: ENVIRONMENT_RETIREMENT_EDGE_RESULT_CODE,
    });
    // EXACTLY ONCE and with EXACTLY the wire's value: a second call would be a retry the edge
    // invented, and a transformed value would be an interpretation the record never authorised.
    expect(spy.calls).toEqual(["staging"]);
    // AND THE DURABLE SIDE, so "called the port" cannot pass for "wrote". ONE event, not two.
    expect(store.readEvents(AGGREGATE)).toHaveLength(1);
    expect(inner.read("staging")).toEqual({ ok: true, value: true });
  });
});

/**
 * (c) CODE **AND** LAYER, AND WHICH LAYER ANSWERED.
 *
 * Three surfaces can refuse this call -- the edge, the record, and the store beneath it -- and
 * all three would satisfy an arm that only checked a code. `spy.calls` is what settles it: an
 * edge that had re-implemented the name grammar or the ledger lookup would refuse BEFORE calling
 * the port and the recorded call list would be EMPTY. Asserting the call reached the port with
 * the caller's own value, and that the answer is the port's code at the port's layer, is the
 * pair that names the layer rather than merely the outcome.
 */
it.each([
  ["a name the grammar cannot admit", { environment: "Production Web!" },
    "ENVIRONMENT_RETIREMENT_ENVIRONMENT_INVALID", "Production Web!"],
  ["a well-formed name no deploy receipt knows", { environment: "preview" },
    "ENVIRONMENT_RETIREMENT_ENVIRONMENT_UNKNOWN", "preview"],
  ["an ABSENT environment field, which the wire allows and the record rejects as empty", {},
    "ENVIRONMENT_RETIREMENT_ENVIRONMENT_INVALID", ""],
  ["a WRONG-TYPED environment field", { environment: { name: "staging" } },
    "ENVIRONMENT_RETIREMENT_ENVIRONMENT_INVALID", ""],
] as const)("refuses %s with the RECORD's code and layer, after reaching it", async (
  _label, payload, code, forwarded,
) => {
  await withRecord((inner, store) => {
    const spy = recording(inner);
    const refusal = refusalOf(spy.record, payload as Record<string, unknown>);
    expect({ code: refusal.code, layer: refusal.layer }).toEqual({ code, layer: "DAEMON_INGRESS" });
    // THE PORT WAS REACHED, with the caller's own value substituted only where the wire had
    // nothing a `string` could hold. This is the assertion that names DAEMON_INGRESS as the
    // RECORD's layer rather than a label the edge could have typed for itself.
    expect(spy.calls).toEqual([forwarded]);
    // AND NOTHING WAS WRITTEN. A refusal that still appended would retire on the failure path.
    expect(store.readEvents(AGGREGATE)).toEqual([]);
  });
});

/** Records every arm it hands out and every release, so "one live handle" is measured. */
class FakeTimer implements ScheduleTimer {
  time = 0;
  private nextHandle = 0;
  readonly arms: { handle: number; interval: number; tick: () => void; due: number;
    cleared: boolean }[] = [];
  set = (tick: () => void, interval: number): number => {
    const handle = ++this.nextHandle;
    this.arms.push({ cleared: false, due: this.time + interval, handle, interval, tick });
    return handle;
  };
  clear = (handle: unknown): void => {
    const arm = this.arms.find((candidate) => candidate.handle === handle);
    if (arm !== undefined) arm.cleared = true;
  };
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const due = this.arms.filter((arm) => !arm.cleared && arm.due <= end)
        .sort((a, b) => a.due - b.due)[0];
      if (due === undefined) break;
      this.time = due.due;
      due.due += due.interval;
      due.tick();
      await new Promise<void>((done) => setImmediate(done));
    }
    this.time = end;
  }
}

const envelopeOf = (payload: Readonly<Record<string, unknown>>): RuntimeCommandEnvelope => ({
  commandId: "cmd-retire-live", commandKind: ENVIRONMENT_RETIREMENT_COMMAND_KIND,
  correlationId: "corr-retire", expectedVersion: 0,
  payload: payload as RuntimeCommandEnvelope["payload"], requestDigest: "a".repeat(64),
  schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, sessionCredential: CREDENTIAL,
  targetAggregateId: AGGREGATE,
});

interface Live {
  readonly counts: Map<string, number>;
  readonly deps: ReturnType<typeof createStoreDependencies>;
  readonly dispatch: (payload: Readonly<Record<string, unknown>>, principalId?: string) => unknown;
  readonly ring: ReturnType<typeof createHealthProbeRing>;
  readonly store: SqliteEventStore;
  readonly timer: FakeTimer;
}

/**
 * THE PRODUCTION COMPOSITION, not a hand-wired pair. `createStoreDependencies` builds the command
 * registry AND the health sweep from ONE config, which is the only thing that makes the arms
 * below evidence: a retirement written through the registry's edge is visible to the sweep
 * because both records replay the SAME store under the SAME project, and nothing here is at
 * liberty to disagree about either.
 */
async function withLive(body: (live: Live) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "moe-retirement-live-"));
  const storePath = join(root, "store.db");
  const timer = new FakeTimer();
  const counts = new Map<string, number>();
  const http = async (url: string): Promise<number> => {
    const environment = Object.keys(PORTS).find((name) => url.includes(`:${PORTS[name]}`))
      ?? "unknown";
    counts.set(environment, (counts.get(environment) ?? 0) + 1);
    return 200;
  };
  // The genesis install owns the empty store; seeding before it refuses GENESIS_INSTALL_REFUSED.
  createStoreDependencies({ credential: CREDENTIAL, principalId: "operator-local",
    projectId: PROJECT, schedule: { timer }, storePath }).close();
  const store = SqliteEventStore.openForProject(storePath, PROJECT);
  let deps: ReturnType<typeof createStoreDependencies> | null = null;
  try {
    for (const environment of Object.keys(PORTS)) deploy(store, environment);
    deps = createStoreDependencies({ credential: CREDENTIAL, healthProbeHttp: http,
      principalId: "operator-local", projectId: PROJECT, schedule: { timer }, storePath });
    const live = deps;
    await body({
      counts, deps: live, ring: createHealthProbeRing(
        `${storePath}${HEALTH_PROBE_SIDECAR_SUFFIX}`, PROJECT,
      ), store, timer,
      dispatch: (payload, principalId = "operator-local"): unknown => {
        // `provide()` PER DISPATCH, exactly as the daemon's request path does it: a registry
        // captured once would not prove that a live daemon reaches the same retirement state.
        const entry = live.provide().registry.get(ENVIRONMENT_RETIREMENT_COMMAND_KIND);
        if (entry === undefined) throw new Error("RETIREMENT_ENTRY_ABSENT");
        return entry.handler({
          envelope: envelopeOf(payload),
          principal: { capabilities: OPERATOR_CAPABILITIES, principalId, projectId: PROJECT },
        });
      },
    });
  } finally {
    deps?.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
    // TEARDOWN IS ASSERTED, not assumed: every handle the timer created has been released.
    expect(timer.arms.filter((arm) => !arm.cleared)).toEqual([]);
  }
}

/**
 * (b) THE FENCE ANSWERS FIRST, AND IT IS A DIFFERENT LAYER FROM THE RECORD'S.
 *
 * The payload here is VALID and the environment EXISTS, so the record would have accepted it.
 * That is deliberate: an arm that refused an invalid name to a non-operator could not tell the
 * fence from the record, and would stay green with the fence deleted. The durable check is the
 * other half -- a fence that refused after writing would be no fence at all.
 */
it("refuses a NON-OPERATOR principal at the authorization layer, before the record", async () => {
  await withLive(async ({ dispatch, store }) => {
    let refusal: unknown;
    try { dispatch({ environment: "staging" }, "agent-imposter"); }
    catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(DomainRefusal);
    expect({
      code: (refusal as DomainRefusal).code, layer: (refusal as DomainRefusal).layer,
    }).toEqual({ code: "OPERATOR_PRINCIPAL_REQUIRED", layer: "DAEMON_AUTHORIZATION" });
    // NOT the record's DAEMON_INGRESS, and nothing durable happened.
    expect(store.readEvents(AGGREGATE)).toEqual([]);
    // THE CONTROL that keeps the arm above from passing for "this kind refuses everyone":
    // the SAME payload through the operator principal is accepted.
    expect(dispatch({ environment: "staging" })).toMatchObject({
      disposition: "DECIDED", resultCode: ENVIRONMENT_RETIREMENT_EDGE_RESULT_CODE,
    });
    expect(store.readEvents(AGGREGATE)).toHaveLength(1);
  });
});

/**
 * (d) + (e) IN ONE WINDOW, because they are one claim about one dispatch: retirement STOPS the
 * sweep for the named environment and DESTROYS nothing. Split across two arms each would need
 * its own retirement, and the pair would no longer be about the same write.
 */
it("stops the sweep for the retired environment while keeping its history readable", async () => {
  await withLive(async ({ counts, dispatch, ring, store, timer }) => {
    await timer.advance(DEFAULT_PROBE_INTERVAL_MS);
    const sample = { version: HEALTH_PROBE_VERSION, environment: "staging", sha: "a".repeat(40),
      status: "SUCCESS", latencyMs: expect.any(Number), at: expect.any(String) };
    // THE SWEEP IS ACTUALLY RUNNING before the retirement, or every "no new sample" below would
    // be vacuously true against a sweep that never sampled anything.
    const before = ring.read("staging");
    expect(before).toEqual({ ok: true, value: [sample] });
    const ledgerBefore = readDeployLedger(store, PROJECT);
    expect(ledgerBefore.get("staging")?.receipts).toHaveLength(1);

    expect(dispatch({ environment: "staging" })).toMatchObject({
      disposition: "DECIDED", resultCode: ENVIRONMENT_RETIREMENT_EDGE_RESULT_CODE,
    });

    // (e) THE WRITER REACHES THE SWEEP'S READER. Two further windows, on the SAME live deps --
    // nothing closed, nothing rebuilt from disk -- so a retirement visible only after a restart
    // fails here. Child 2 landed the reader; this is the arm that proves the command feeds it.
    await timer.advance(DEFAULT_PROBE_INTERVAL_MS * 2);
    expect(ring.read("staging")).toEqual(before);
    // AND THE SWEEP DID NOT SIMPLY STOP: production kept being probed across the same windows,
    // so "no new staging sample" is the retirement and not a dead timer.
    expect(counts.get("production")).toBeGreaterThan(1);
    expect(counts.get("staging")).toBe(1);

    // (d) RETIREMENT IS NOT DESTRUCTION -- asserted on CONTENT, because a reader that silently
    // answered empty would satisfy any shallower check.
    expect(readDeployLedger(store, PROJECT)).toEqual(ledgerBefore);
    expect(ring.read("staging")).toEqual({ ok: true, value: [sample] });
  });
});

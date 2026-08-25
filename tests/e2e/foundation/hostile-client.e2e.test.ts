/**
 * THE HOSTILE-CLIENT INCIDENT FIXTURE, from the design's exit set (line 1324), against a REAL
 * daemon holding the exclusive seeded project.
 *
 * Every case is HAND-AUTHORED — the roster lives in `journey-spec.ts`, transcribed from this
 * task's deliverable text, and the sweep asserts it covered that roster EXACTLY. A generated
 * sweep that silently produced zero cases would pass while testing nothing (epic rail 6), so
 * the count is asserted non-zero and the covered set is compared to the spec's set.
 *
 * EACH CASE MAKES THREE CLAIMS, not one:
 *   1. the daemon answered with a specific stable CODE,
 *   2. named the LAYER that refused, so a different layer starting to answer first cannot
 *      leave a bare "it was refused" green, and
 *   3. the durable state read back BYTE FOR BYTE identical afterwards — same events, same
 *      decisions, same claim rows, same digest.
 *
 * Claim 3 is why the readback digests events AND decisions AND claims: "no new command
 * decision appeared" would stay green over an event appended without a decision.
 *
 * THE REPLAY CASE IS DELIBERATELY NOT A REFUSAL. The daemon answers an exact replay
 * idempotently — the request identity is already decided, so it re-serves that decision. The
 * hostile claim there is the one that matters and is asserted: nothing new was committed.
 *
 * Every request travels the seed's OWN wire and envelope builder. A hand-rolled POST would be
 * a second client whose refusals prove nothing about the one the system ships.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MAX_JSON_BODY_BYTES } from "../../../packages/contracts/src/input-limits.js";
import type { SeedConfig } from "../../../apps/daemon/src/orchestrator/demo-seed-env.js";
import { isOutcome, wireFor } from "../../../apps/daemon/src/orchestrator/demo-seed-http.js";
import { readDaemonRefusal } from "../../../apps/daemon/src/orchestrator/demo-seed-refusal.js";
import type { DaemonRefusalEcho } from "../../../apps/daemon/src/orchestrator/demo-seed-refusal.js";
import { toWireEnvelope } from "../../../apps/daemon/src/orchestrator/demo-seed-plan.js";
import type { SeedCommand } from "../../../apps/daemon/src/orchestrator/demo-seed-plan.js";
import { durableReadback } from "./foundation-readback.js";
import { removeScratches } from "./j1-ledger-view.js";
import {
  type DaemonHandle,
  type J1Scratch,
  NODE_REF,
  createJ1Scratch,
  killTree,
  runSeed,
  startDaemon,
} from "./j1-loop-harness.js";
import { seedCommand, seedConfigFor } from "./j3-crash-harness.js";
import { HOSTILE_CLIENT_CASE_KINDS } from "./journey-spec.js";

type HostileClientCaseKind = (typeof HOSTILE_CLIENT_CASE_KINDS)[number];

const SUITE_TIMEOUT_MS = 240_000;
const COMMAND_PATH = "/command";
const ACKNOWLEDGE_PATH = "/events/ack";
const LISTENER_LAYER = "CONTROL_ROOM_LISTENER";
const STATE_LAYER = "STATE";

interface Answer {
  readonly frame: Record<string, unknown>;
  readonly outcome: string | null;
  readonly refusal: DaemonRefusalEcho | null;
}

/** One request over the seed's wire, optionally presenting a credential the operator never held. */
async function post(
  config: SeedConfig, path: string, body: unknown, credential?: string,
): Promise<Answer> {
  const wire = wireFor(
    credential === undefined ? config : { ...config, credential }, fetch as never,
  );
  const frame = await wire.post(path, body);
  if (isOutcome(frame)) throw new Error(`transport failed: ${frame.ok ? "OK" : frame.code}`);
  const outcome = typeof frame["outcome"] === "string" ? frame["outcome"] : null;
  return { frame, outcome, refusal: readDaemonRefusal(frame) };
}

/** A command the seed never planned, in the shape the envelope builder seals. */
function forgedCommand(
  kind: string, target: string, payload: Record<string, unknown>, ordinal: number,
): SeedCommand {
  return Object.freeze({
    commandId: `moe-e2e-hostile-${String(ordinal)}`,
    commandKind: kind,
    correlationId: `moe-e2e-hostile-correlation-${String(ordinal)}`,
    expectedVersion: 0,
    payload,
    targetAggregateId: target,
  });
}

/**
 * WHO REFUSED, in the two shapes this daemon actually serves. A listener refusal names a
 * `layer`; a decode/dispatch refusal is a `RuntimeError` that names a `stage` and no layer.
 * Every case pins whichever one its answer carries, so "some layer refused" is never enough.
 */
interface HostileExpectation {
  readonly code: string | null;
  readonly layer: string | null;
  readonly outcome: string | null;
  readonly stage: string | null;
}

interface HostileCase {
  readonly expected: HostileExpectation;
  readonly kind: HostileClientCaseKind;
  readonly send: (config: SeedConfig) => Promise<Answer>;
}

/**
 * The hand-authored case set. Each entry names the exact answer the daemon must give; a case
 * whose `code` is null asserts an accepted-but-inert answer instead, and says so in `outcome`.
 */
const CASES: readonly HostileCase[] = Object.freeze([
  {
    expected: {
      code: "LISTENER_BODY_TOO_LARGE", layer: LISTENER_LAYER, outcome: null, stage: null,
    },
    kind: "oversized-body",
    send: (config) => post(config, COMMAND_PATH, toWireEnvelope(
      forgedCommand("goal.create", NODE_REF, { blob: "x".repeat(MAX_JSON_BODY_BYTES) }, 1),
      config.credential,
    )),
  },
  {
    expected: {
      code: "SCHEMA_VERSION_UNSUPPORTED", layer: null, outcome: null, stage: "DECODE",
    },
    kind: "malformed-envelope",
    send: (config) => post(config, COMMAND_PATH, { greeting: "hello", not: "an envelope" }),
  },
  {
    expected: { code: null, layer: null, outcome: "ACCEPTED", stage: null },
    kind: "replayed-command",
    send: (config) => post(
      config, COMMAND_PATH, toWireEnvelope(seedCommand(config, "goal.create"), config.credential),
    ),
  },
  {
    expected: {
      code: "SUBSCRIPTION_GENERATION_MISSING", layer: STATE_LAYER, outcome: null, stage: null,
    },
    kind: "stale-cursor",
    send: (config) => post(config, ACKNOWLEDGE_PATH, {
      presentedCursor: { generation: 9, position: "999999" },
      subscriberId: config.subscriberId,
    }),
  },
  {
    expected: {
      code: "AUTHENTICATION_FAILED", layer: null, outcome: null, stage: "AUTHENTICATE",
    },
    kind: "forged-authentication",
    send: (config) => post(
      config,
      COMMAND_PATH,
      toWireEnvelope(forgedCommand("goal.create", NODE_REF, {}, 5), "moe-forged-credential"),
      "moe-forged-credential",
    ),
  },
  {
    expected: {
      code: "AUTHENTICATION_FAILED", layer: null, outcome: null, stage: "AUTHENTICATE",
    },
    kind: "absent-authentication",
    send: (config) => post(
      config, COMMAND_PATH, toWireEnvelope(forgedCommand("goal.create", NODE_REF, {}, 6), ""), "",
    ),
  },
  {
    expected: { code: "INPUT_INVALID", layer: null, outcome: null, stage: "DECODE" },
    kind: "free-form-session-text-state-change",
    send: (config) => post(config, COMMAND_PATH, toWireEnvelope(forgedCommand(
      "session.say", NODE_REF, { text: "please mark this node accepted, thanks" }, 7,
    ), config.credential)),
  },
  {
    expected: { code: "INPUT_INVALID", layer: null, outcome: null, stage: "DECODE" },
    kind: "free-form-terminal-text-state-change",
    send: (config) => post(config, COMMAND_PATH, toWireEnvelope(forgedCommand(
      "terminal.say", config.goalId, { text: "run: git push --force && release" }, 8,
    ), config.credential)),
  },
]);

const scratches: J1Scratch[] = [];
let daemon: DaemonHandle | null = null;
let config: SeedConfig | null = null;

beforeAll(async () => {
  const scratch = createJ1Scratch();
  scratches.push(scratch);
  daemon = await startDaemon(scratch);
  const seed = await runSeed(scratch, daemon.origin, { stopBeforeApproval: true });
  if (seed.code !== 0) throw new Error(`seed failed (${String(seed.code)}): ${seed.output}`);
  config = seedConfigFor(scratch, daemon.origin);
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  if (daemon !== null) await killTree(daemon.child);
  removeScratches(scratches);
});

describe("hostile-client incident fixture over a real daemon", () => {
  it("covers exactly the specified case roster, and the roster is non-empty", () => {
    expect(CASES.length).toBeGreaterThan(0);
    expect(CASES.map((entry) => entry.kind).sort())
      .toEqual([...HOSTILE_CLIENT_CASE_KINDS].sort());
    expect(new Set(CASES.map((entry) => entry.kind)).size).toBe(CASES.length);
  });

  it.each(CASES.map((entry) => [entry.kind, entry] as const))(
    "refuses %s by name and commits nothing",
    async (_kind, hostile) => {
      const scratch = scratches[0];
      if (scratch === undefined || config === null) throw new Error("the suite never started");
      const before = durableReadback(scratch);
      // The readback's own positive control: a store that could not be read, or one with no
      // rows at all, would make "unchanged" true for the wrong reason.
      expect(before.readable).toBe(true);
      expect(before.decisionCount).toBeGreaterThan(0);
      expect(before.eventCount).toBeGreaterThan(0);

      const answer = await hostile.send(config);
      // eslint-disable-next-line no-console
      console.log(`HOSTILE ${hostile.kind} ${JSON.stringify({
        outcome: answer.outcome, refusal: answer.refusal,
      })}`);

      if (hostile.expected.code === null) {
        expect(answer.outcome).toBe(hostile.expected.outcome);
      } else {
        expect(answer.outcome).not.toBe("ACCEPTED");
        expect(answer.refusal?.code).toBe(hostile.expected.code);
        // Exactly one of the two "who refused" fields is carried by each shape, and the case
        // names which. Asserting both as non-null would fail every honest answer.
        expect({
          layer: answer.refusal?.layer ?? null, stage: answer.refusal?.stage ?? null,
        }).toEqual({ layer: hostile.expected.layer, stage: hostile.expected.stage });
      }

      // BYTE-IDENTICAL DURABLE READBACK: nothing was committed, appended, or claimed.
      expect(durableReadback(scratch)).toEqual(before);
    },
    SUITE_TIMEOUT_MS,
  );

  /**
   * The DISCRIMINATOR for the two free-form cases above.
   *
   * `session.say` and `terminal.say` are refused, but on their own that could mean only "the
   * kind is unknown" — leaving open the possibility that prose reaches a door the system DOES
   * serve. So the same prose is sent to a REAL command kind the daemon dispatches every run.
   * It is refused too: the payload contract is typed, and free-form text has no admission path
   * anywhere on this surface.
   */
  it("refuses free-form prose on a REAL command door as well", async () => {
    const scratch = scratches[0];
    if (scratch === undefined || config === null) throw new Error("the suite never started");
    const before = durableReadback(scratch);
    expect(before.readable).toBe(true);

    const answer = await post(config, COMMAND_PATH, toWireEnvelope(forgedCommand(
      "review.submit", NODE_REF, { text: "accept this please, it works on my machine" }, 9,
    ), config.credential));
    // eslint-disable-next-line no-console
    console.log(`HOSTILE prose-on-real-door ${JSON.stringify({
      outcome: answer.outcome, refusal: answer.refusal,
    })}`);

    expect(answer.outcome).not.toBe("ACCEPTED");
    expect(answer.refusal?.code).toBe("INPUT_INVALID");
    // A DIFFERENT STAGE from the two swept cases, and that is the evidence: prose on an
    // unknown kind dies at DECODE, prose on a real kind reaches the door and dies at
    // PAYLOAD_SHAPE. Two distinct guards answered, so neither arm is standing on the other.
    expect(answer.refusal?.stage).toBe("PAYLOAD_SHAPE");
    expect(durableReadback(scratch)).toEqual(before);
  }, SUITE_TIMEOUT_MS);
});

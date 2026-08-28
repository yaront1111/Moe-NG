/**
 * Actor arms for the LIVE legacy quiesce (task-e60b874b).
 *
 * Every port here is a fake. Nothing in this file stops anything on the host.
 * What is graded is the one property the whole row turns on: A RESULT IS
 * DERIVED FROM AN OBSERVATION TAKEN AFTER THE STOP, NEVER FROM THE STOP
 * COMMAND'S EXIT CODE.
 *
 * WHAT THE DIVERGENCE ARM CROSSES, and why nothing else can answer first.
 * In "trusts the exit code while the item is still live" the item is
 * well-formed, its kind is on the roster, `discoveredBy` and `observedBefore`
 * are both present, and the stop port neither throws nor refuses. So the
 * inventory's five refusals cannot fire, `LIVE_QUIESCE_ITEM_UNDENIABLE` cannot
 * fire (the stop was accepted), and `LIVE_QUIESCE_OBSERVATION_UNAVAILABLE`
 * cannot fire (the observe port answers cleanly). The post-stop observation is
 * the ONLY mechanism left that can refuse. An implementation that returns
 * `ok: true` on `exitCode === 0` passes every other arm in this file and reds
 * exactly there.
 */

import { describe, expect, it } from "vitest";

import {
  LIVE_QUIESCE_ACTOR_LAYER,
  LIVE_QUIESCE_ACTOR_REFUSAL_CODES,
  OBSERVATION_POLL_BUDGET,
  quiesceAll,
  quiesceItem,
  type LiveQuiescePorts,
  type StopAttempt,
} from "./live-quiesce-actor.js";
import { LIVE_QUIESCE_KINDS, type LiveQuiesceItem, type LiveQuiesceKind } from "./live-quiesce-inventory.js";

const itemOf = (kind: LiveQuiesceKind, id: string): LiveQuiesceItem => ({
  kind,
  id,
  discoveredBy: `probe --kind ${kind} --id ${id}`,
  observedBefore: `${id} answered a live probe`,
});

const PROC = itemOf("PROCESS", "25536");

const accepted: StopAttempt = { accepted: true, command: "taskkill /PID 25536 /T /F", exitCode: 0 };

/**
 * Ports whose observe answers `live` for the first `liveForPolls` calls and
 * dead afterwards. `liveForPolls: 0` is the ordinary success shape; a value at
 * or above the budget is the divergence shape.
 */
const portsThatDieAfter = (liveForPolls: number): LiveQuiescePorts => {
  let polls = 0;
  return {
    stop: () => accepted,
    observe: () => {
      polls += 1;
      return polls <= liveForPolls
        ? { live: true, detail: `poll ${polls}: pid still in tasklist` }
        : { live: false, detail: `poll ${polls}: pid absent from tasklist` };
    },
  };
};

/**
 * Codes actually OBSERVED firing by the arms below, recorded at runtime.
 * The roster test asserts this set equals the exported roster, which turns
 * "every code has an arm" from a hand-maintained claim into evidence: a code
 * whose arm is deleted or never written leaves this set and reds, even though
 * a literal mirror list would still agree with the roster.
 */
const observedCodes = new Set<string>();

describe("task-e60b874b: the actor derives its result from the post-stop observation", () => {
  it("returns ok only when the post-stop observation shows the item gone", () => {
    const result = quiesceItem(PROC, portsThatDieAfter(0));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`expected a stop, refused ${result.code}`);
    }
    expect(result.item.id).toBe("25536");
    expect(result.observedAfter.live).toBe(false);
    expect(result.observedAfter.detail).toContain("absent from tasklist");
    expect(result.stopCommand).toBe("taskkill /PID 25536 /T /F");
  });

  it("DIVERGENCE: a stop that exits 0 while the item stays live refuses STILL_LIVE", () => {
    // The port never reports the item gone, however many times it is polled.
    const alwaysLive: LiveQuiescePorts = {
      stop: () => accepted,
      observe: () => ({ live: true, detail: "pid still in tasklist" }),
    };

    const result = quiesceItem(PROC, alwaysLive);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("exit code 0 must never be upgraded to a stop");
    }
    expect(result.code).toBe("LIVE_QUIESCE_ITEM_STILL_LIVE");
    expect(result.layer).toBe(LIVE_QUIESCE_ACTOR_LAYER);
    observedCodes.add(result.code);
    expect(result.item.id).toBe("25536");
    // The refusal states how hard it looked, so a reader can tell an exhausted
    // budget apart from a single unlucky sample.
    expect(result.detail).toContain(String(OBSERVATION_POLL_BUDGET));
  });

  it("tolerates the measured Windows reap delay instead of false-reporting STILL_LIVE", () => {
    // taskkill returns ~78ms BEFORE the pid leaves tasklist (measured on this
    // host, 8/8 samples). A single post-stop sample would refuse every real
    // process stop, so the observation polls to a budget.
    const result = quiesceItem(PROC, portsThatDieAfter(3));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`a reap delay must not refuse; refused ${result.code}`);
    }
    expect(result.pollsUsed).toBe(4);
    expect(result.pollsUsed).toBeLessThan(OBSERVATION_POLL_BUDGET);
  });

  it("refuses UNDENIABLE, naming the layer, when the stop itself is not accepted", () => {
    const refusing: LiveQuiescePorts = {
      stop: () => ({
        accepted: false,
        command: "taskkill /PID 25536 /T /F",
        refusedByLayer: "windows-scm",
        detail: "ERROR: Access is denied.",
      }),
      observe: () => ({ live: true, detail: "pid still in tasklist" }),
    };

    const result = quiesceItem(PROC, refusing);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("an unaccepted stop must never be reported as success");
    }
    expect(result.code).toBe("LIVE_QUIESCE_ITEM_UNDENIABLE");
    expect(result.layer).toBe(LIVE_QUIESCE_ACTOR_LAYER);
    observedCodes.add(result.code);
    expect(result.refusedByLayer).toBe("windows-scm");
    expect(result.detail).toContain("Access is denied");
  });

  it("refuses OBSERVATION_UNAVAILABLE rather than guessing when the probe throws", () => {
    const blindProbe: LiveQuiescePorts = {
      stop: () => accepted,
      observe: () => {
        throw new Error("tasklist: The RPC server is unavailable.");
      },
    };

    const result = quiesceItem(PROC, blindProbe);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("an unobservable item must never be reported as stopped");
    }
    expect(result.code).toBe("LIVE_QUIESCE_OBSERVATION_UNAVAILABLE");
    expect(result.layer).toBe(LIVE_QUIESCE_ACTOR_LAYER);
    observedCodes.add(result.code);
    expect(result.detail).toContain("RPC server is unavailable");
  });
});

describe("task-e60b874b: the sweep cannot summarize a class", () => {
  it("returns exactly one result per input item across all five kinds", () => {
    const items = LIVE_QUIESCE_KINDS.map((kind) => itemOf(kind, `${kind.toLowerCase()}-1`));
    // Denominator stated: the sweep must execute one case per roster kind.
    expect(items).toHaveLength(LIVE_QUIESCE_KINDS.length);
    expect(items).toHaveLength(5);

    const sweep = quiesceAll(items, portsThatDieAfter(0));

    expect(sweep.inputCount).toBe(5);
    expect(sweep.resultCount).toBe(sweep.inputCount);
    expect(sweep.results).toHaveLength(sweep.inputCount);
    expect(sweep.outcome).toBe("COMPLETE");
    // Every input id appears in the output; none was collapsed into a summary.
    for (const item of items) {
      expect(sweep.results.some((result) => result.item.id === item.id)).toBe(true);
    }
  });

  it("marks the run PARTIAL and keeps the refused item rather than dropping it", () => {
    const stubborn = itemOf("WATCHER", "watcher-stuck");
    const items = [PROC, stubborn];
    const ports: LiveQuiescePorts = {
      stop: () => accepted,
      observe: (item) =>
        item.id === "watcher-stuck"
          ? { live: true, detail: "watcher registration still present" }
          : { live: false, detail: "pid absent from tasklist" },
    };

    const sweep = quiesceAll(items, ports);

    expect(sweep.inputCount).toBe(2);
    expect(sweep.resultCount).toBe(2);
    expect(sweep.outcome).toBe("PARTIAL");
    const refused = sweep.results.filter((result) => !result.ok);
    expect(refused).toHaveLength(1);
    const [only] = refused;
    if (only === undefined || only.ok) {
      throw new Error("the refused item must survive into the sweep");
    }
    expect(only.item.id).toBe("watcher-stuck");
    expect(only.code).toBe("LIVE_QUIESCE_ITEM_STILL_LIVE");
  });

  it("refuses an empty sweep rather than reporting a vacuous COMPLETE", () => {
    const sweep = quiesceAll([], portsThatDieAfter(0));

    expect(sweep.inputCount).toBe(0);
    expect(sweep.resultCount).toBe(0);
    expect(sweep.outcome).toBe("EMPTY");
    // An empty sweep is never COMPLETE: nothing was stopped, so nothing is proven.
    expect(sweep.outcome).not.toBe("COMPLETE");
  });
});

describe("task-e60b874b: actor roster", () => {
  it("the refusal-code roster is frozen at exactly three, set-equal both directions", () => {
    const asserted = [
      "LIVE_QUIESCE_ITEM_STILL_LIVE",
      "LIVE_QUIESCE_ITEM_UNDENIABLE",
      "LIVE_QUIESCE_OBSERVATION_UNAVAILABLE",
    ];

    expect(LIVE_QUIESCE_ACTOR_REFUSAL_CODES).toHaveLength(3);
    expect(asserted).toHaveLength(LIVE_QUIESCE_ACTOR_REFUSAL_CODES.length);
    expect(Object.isFrozen(LIVE_QUIESCE_ACTOR_REFUSAL_CODES)).toBe(true);
    for (const code of LIVE_QUIESCE_ACTOR_REFUSAL_CODES) {
      expect(asserted).toContain(code);
    }
    for (const code of asserted) {
      expect(LIVE_QUIESCE_ACTOR_REFUSAL_CODES).toContain(code);
    }
  });

  it("every roster code was OBSERVED firing above, not merely listed", () => {
    expect(observedCodes.size).toBe(LIVE_QUIESCE_ACTOR_REFUSAL_CODES.length);
    expect(observedCodes.size).toBeGreaterThan(0);
    for (const code of LIVE_QUIESCE_ACTOR_REFUSAL_CODES) {
      expect([...observedCodes]).toContain(code);
    }
    for (const code of observedCodes) {
      expect(LIVE_QUIESCE_ACTOR_REFUSAL_CODES).toContain(code);
    }
  });
});

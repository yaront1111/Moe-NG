/**
 * THE CONCURRENCY WITNESS, PINNED IN BOTH DIRECTIONS.
 *
 * `concurrentStaffing` is the whole evidentiary weight of DoD 1's "at least 2 staffed
 * concurrently": the live drive asserts what it answers about a REAL wrapper transcript. A
 * detector that answered `true` for everything would make that arm vacuous, and the live drive
 * cannot show otherwise -- it only ever sees one transcript, the passing one. So the negative
 * direction is pinned here, on transcripts whose shapes are the ones a sequential wrapper and a
 * single-node board actually produce.
 *
 * THE LINES ARE VERBATIM from the run of 2026-09-09 (refs shortened), not invented formats: a
 * fixture that guessed the wrapper's wording would pass while the production line drifted.
 */
import { describe, expect, it } from "vitest";

import { concurrentStaffing } from "./live-proof-landing.js";

const A = "node:v1:aaa1";
const B = "node:v1:bbb2";

const spawned = (ref: string): string => `[wrapper] node.deliver@${ref}: SPAWNED`;
const exited = (ref: string): string => `[wrapper] node.deliver@${ref} agent exited 0`;
const busy = (ref: string): string =>
  `[wrapper] node.deliver@${ref}: REPOSITORY_EXECUTION_BUSY (REPOSITORY_DELIVERY)`;

describe("concurrentStaffing", () => {
  it("reports the pair when B is refused BUSY inside A's delivery window", () => {
    const witness = concurrentStaffing([
      "[wrapper] reclaim pass: 0 reclaimed, 0 kept",
      `[lander] ${A}: BASELINE_RECORDED (0 dirty path(s) before the seat)`,
      spawned(A), busy(B), exited(A),
    ].join("\n"), [A, B]);

    expect(witness.concurrent).toBe(true);
    expect(witness.holder).toBe(A);
    expect(witness.waiter).toBe(B);
    // THE CODE, not merely "something matched": the refusal is what explains why only one node
    // proceeds, and a witness that dropped it would report concurrency with no reason attached.
    expect(witness.evidence).toContain("REPOSITORY_EXECUTION_BUSY");
  });

  it("reports NOT concurrent when the two deliveries are strictly sequential", () => {
    const witness = concurrentStaffing([
      spawned(A), exited(A), spawned(B), exited(B),
    ].join("\n"), [A, B]);

    expect(witness).toEqual({ concurrent: false, evidence: null, holder: null, waiter: null });
  });

  it("reports NOT concurrent when B's BUSY line falls AFTER A has exited", () => {
    // The window is what carries the claim. A BUSY refusal that arrives once the checkout is
    // already free says nothing about two nodes being staffed at one moment.
    const witness = concurrentStaffing([
      spawned(A), exited(A), busy(B),
    ].join("\n"), [A, B]);

    expect(witness.concurrent).toBe(false);
  });

  it("reports NOT concurrent for a board that only ever staffed one node", () => {
    const witness = concurrentStaffing([spawned(A), exited(A)].join("\n"), [A, B]);

    expect(witness.concurrent).toBe(false);
    expect(witness.evidence).toBeNull();
  });

  it("ignores a BUSY line belonging to a node outside the pair it was asked about", () => {
    const other = "node:v1:ccc3";
    const witness = concurrentStaffing([spawned(A), busy(other), exited(A)].join("\n"), [A, B]);

    expect(witness.concurrent).toBe(false);
  });

  it("still answers when the holder never printed an exit line", () => {
    // A wrapper killed mid-delivery leaves no `agent exited`; the window then runs to the end of
    // the transcript rather than collapsing to empty, which would lose a real observation.
    const witness = concurrentStaffing([spawned(A), busy(B)].join("\n"), [A, B]);

    expect(witness.concurrent).toBe(true);
    expect(witness.holder).toBe(A);
  });
});

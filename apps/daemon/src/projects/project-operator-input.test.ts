import { describe, expect, it, vi } from "vitest";

import {
  CONFIRMATION_LABEL,
  PROJECT_INSTANCE_LABEL,
  attachOperatorInput,
  normalizeOperatorLine,
} from "./project-operator-input.js";
import type { CancellablePairingOperatorInput } from "../http/pairing-operator-channel.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

/** A console stdin: never typed into and closed by nobody, so only destroy() ends the read. */
function heldOpenInput(): CancellablePairingOperatorInput & { destroys(): number } {
  let destroys = 0;
  let settleNext: ((value: IteratorResult<string>) => void) | undefined;
  return {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<string>> =>
        await new Promise<IteratorResult<string>>((resolve) => { settleNext = resolve; }),
    }),
    destroy: (): void => {
      destroys += 1;
      settleNext?.({ done: true, value: undefined });
    },
    destroys: () => destroys,
  };
}

async function* chunks(...values: readonly string[]): AsyncIterable<string> {
  for (const value of values) yield value;
}

describe("normalizeOperatorLine", () => {
  it("trims, folds case and collapses inner whitespace so a shouted or padded label matches", () => {
    for (const spelling of ["DEAD-BEEF-1234", "  dead-beef-1234 ", "\tDead-Beef-1234\t"]) {
      expect(CONFIRMATION_LABEL.test(normalizeOperatorLine(spelling)), spelling).toBe(true);
    }
    const project = PROJECT_INSTANCE_LABEL.exec(
      normalizeOperatorLine(` ${INSTANCE_ID.toUpperCase()}   DEAD-BEEF-1234 `),
    )?.groups;
    expect(project).toEqual({ instanceId: INSTANCE_ID, label: "dead-beef-1234" });
  });

  it("does not turn a non-label into one", () => {
    for (const line of ["wrong", "dead-beef-12345", "dead beef 1234", "", "   "]) {
      expect(CONFIRMATION_LABEL.test(normalizeOperatorLine(line)), JSON.stringify(line)).toBe(false);
    }
  });
});

describe("attachOperatorInput", () => {
  it("delivers each line, then release() destroys the handle and settles once the consumer ends", async () => {
    const stdin = heldOpenInput();
    const accept = vi.fn();
    const attached = attachOperatorInput(stdin, accept);
    expect(stdin.destroys()).toBe(0);
    const outcome = await Promise.race([
      attached.release().then(() => "RELEASED" as const),
      new Promise<"STILL_READING">((resolve) => { setTimeout(() => { resolve("STILL_READING"); }, 50); }),
    ]);
    expect(outcome).toBe("RELEASED");
    expect(stdin.destroys()).toBe(1);
    expect(accept).not.toHaveBeenCalled();
  });

  it("hands finite input to the handler and release() is then a settled no-op", async () => {
    const accept = vi.fn();
    const attached = attachOperatorInput(chunks("abcd-ef01-2345\n"), accept);
    await vi.waitFor(() => { expect(accept).toHaveBeenCalledWith("abcd-ef01-2345"); });
    await attached.release();
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it("attaches nothing for an absent input and release() resolves immediately", async () => {
    await expect(attachOperatorInput(undefined, vi.fn()).release()).resolves.toBeUndefined();
  });
});

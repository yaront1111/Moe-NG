import { consumePairingOperatorLines } from "../http/pairing-operator-channel.js";
import type {
  PairingOperatorInput,
  PairingOperatorLineHandler,
} from "../http/pairing-operator-channel.js";

/**
 * The foreground operator input of `moe start` and `moe projects`, attached under
 * one AbortController the way `moe up` and the dev daemon attach theirs.
 *
 * Both mains used to fire `consumePairingOperatorLines` and forget it: no signal, no
 * `destroy()`, so a console stdin (never typed into, closed by nobody) kept the event
 * loop alive after the runtime was proven down. The main returned 0, `process.exitCode`
 * was set, and the process stayed up until the window was closed (measured 2026-09-13,
 * Node v24.16.0: attached stdin still alive 4 s after the main returned; the same run
 * with `process.stdin.destroy()` exited in 567 ms).
 */
export interface AttachedOperatorInput {
  /**
   * Settles once the consumer has ended for any reason: the input hit EOF, the stream
   * failed, or release() destroyed it. Never rejects. `moe projects` reports its live
   * operator channel off this: a console that already ended cannot take a typed label.
   */
  readonly ended: Promise<void>;
  /** Fences further approvals, destroys a live stdin handle, and waits for the consumer. */
  release(): Promise<void>;
}

const NOTHING_ATTACHED: AttachedOperatorInput = Object.freeze({
  ended: Promise.resolve(),
  release: async (): Promise<void> => undefined,
});

export function attachOperatorInput(
  input: PairingOperatorInput | undefined,
  accept: PairingOperatorLineHandler,
): AttachedOperatorInput {
  if (input === undefined) return NOTHING_ATTACHED;
  const controller = new AbortController();
  const consumption = consumePairingOperatorLines(input, async (line) => {
    // A line that raced the release is dropped: nothing is approved during teardown.
    if (controller.signal.aborted) return;
    await accept(line);
  }, { signal: controller.signal });
  return Object.freeze({
    ended: consumption,
    release: async (): Promise<void> => {
      controller.abort();
      await consumption;
    },
  });
}

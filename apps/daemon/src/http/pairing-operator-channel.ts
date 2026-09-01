/** Maximum private operator command length, excluding CRLF. */
export const PAIRING_OPERATOR_MAX_LINE_BYTES = 96;

export interface PairingOperatorInput extends AsyncIterable<string | Uint8Array> {
  /**
   * Active release for a long-lived source. Node stdin supplies this; finite
   * in-memory iterables may omit it. Without it, cancellation deliberately
   * remains pending instead of pretending the underlying handle was closed.
   */
  readonly destroy?: () => unknown;
}
export interface CancellablePairingOperatorInput extends PairingOperatorInput {
  readonly destroy: () => unknown;
}
export type PairingOperatorLineHandler = (line: string) => void | Promise<void>;

export interface PairingOperatorConsumptionOptions {
  /** Cancels the owned iterator and releases a live stdin handle during launcher teardown. */
  readonly signal?: AbortSignal;
}

/**
 * Consumes a private foreground stream without ever buffering an unbounded
 * line. Only printable ASCII terminated by LF is delivered; malformed,
 * overlong, and unterminated data is discarded without echoing it.
 */
export async function consumePairingOperatorLines(
  input: PairingOperatorInput,
  accept: PairingOperatorLineHandler,
  options: PairingOperatorConsumptionOptions = {},
): Promise<void> {
  let line = "";
  let discarded = false;

  const finish = async (): Promise<void> => {
    const candidate = line.endsWith("\r") ? line.slice(0, -1) : line;
    const accepted = !discarded && candidate.length > 0;
    line = "";
    discarded = false;
    if (!accepted) return;
    try { await accept(candidate); } catch { /* an operator typo cannot crash the host */ }
  };

  const consumeCode = async (code: number): Promise<void> => {
    if (code === 0x0a) {
      await finish();
      return;
    }
    if (discarded) return;
    if ((code < 0x20 && code !== 0x0d) || code > 0x7e
      || line.length >= PAIRING_OPERATOR_MAX_LINE_BYTES) {
      line = "";
      discarded = true;
      return;
    }
    line += String.fromCharCode(code);
  };

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    try {
      input.destroy?.();
    } catch { /* active cancellation is best-effort; admission is already stopped */ }
  };
  if (options.signal?.aborted === true) stop();
  else options.signal?.addEventListener("abort", stop, { once: true });

  try {
    for await (const chunk of input) {
      if (stopped) break;
      if (typeof chunk === "string") {
        for (let index = 0; index < chunk.length; index += 1) {
          if (stopped) break;
          await consumeCode(chunk.charCodeAt(index));
        }
      } else {
        for (const byte of chunk) {
          if (stopped) break;
          await consumeCode(byte);
        }
      }
    }
  } catch {
    // Stream failure closes the approval channel. Nothing is approved by EOF.
  } finally {
    options.signal?.removeEventListener("abort", stop);
  }
}

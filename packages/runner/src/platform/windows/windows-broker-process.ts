import { spawn } from "node:child_process";
import { type Readable, type Writable } from "node:stream";

/**
 * The process seam: six real pipes to the broker, and nothing else.
 *
 * WHY THIS IS A SEAM AND NOT AN INLINE `spawn` CALL. DoD 5 requires proving
 * that a non-Windows invocation makes ZERO process calls, and DoD 3 requires
 * proving that a refused request creates no process. Neither is provable by
 * reading the source; both are provable by injecting a recorder here and
 * asserting the call log is EMPTY.
 *
 * THE SIX DESCRIPTORS, fixed by the broker's own contract (native/broker/src/
 * main.rs wires them in this order):
 *
 * ```text
 * fd0  control in     bounded launch/CANCEL frames; EOF means cancel
 * fd1  status out     bounded STARTED / COMPLETED / REFUSED frames
 * fd2  diagnostics    bounded, NON-AUTHORITATIVE
 * fd3  provider stdin
 * fd4  provider stdout
 * fd5  provider stderr
 * ```
 *
 * On Windows those reach the non-libuv broker through the CRT `lpReserved2`
 * block; Node's whole side of that is `stdio: ['pipe' x 6]`.
 */

/** Exactly six. The broker refuses any other count at descriptor acquisition. */
const PIPE_COUNT = 6;

export interface BrokerPipes {
  /** The broker's own pid. Undefined only if the spawn never got that far. */
  readonly pid: number | undefined;
  readonly providerStdin: Writable;
  readonly providerStdout: Readable;
  readonly providerStderr: Readable;
  /** Writes the one launch frame to fd0. */
  writeControl(bytes: Uint8Array): void;
  /** Closes fd0. EOF on the control channel is how the broker is told to stop. */
  endControl(): void;
  /** Closes Node's three provider endpoints so the broker can observe EOF. */
  closeProviderChannels(): void;
  onStatus(listener: (chunk: Uint8Array) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  onError(listener: (error: Error) => void): void;
  /**
   * Last resort. Killing the BROKER is what closes its last Job handle, and
   * kill-on-job-close is what reaches the provider and its descendants — this
   * is not, and cannot be, a kill of the provider itself.
   */
  kill(): void;
  /** Drops every stream reference so the event loop can drain. */
  dispose(): void;
}

export type BrokerSpawn = (executable: string) => BrokerPipes;

/**
 * Spawns the broker with `shell: false` and six pipes.
 *
 * NO ARGUMENTS AND NO ENVIRONMENT ARE PASSED. Everything the provider needs
 * travels as one bounded control frame on fd0, so the broker's own command line
 * carries no attacker-influenced text at all.
 */
export const spawnBroker: BrokerSpawn = (executable: string): BrokerPipes => {
  const child = spawn(executable, [], {
    shell: false,
    windowsHide: true,
    stdio: Array.from({ length: PIPE_COUNT }, () => "pipe" as const),
  });

  const control = child.stdio[0] as Writable | null;
  const status = child.stdio[1] as Readable | null;
  // @types/node models only the common five-descriptor tuple even though Node
  // accepts an arbitrary stdio array. The runtime check keeps the cast honest.
  const allPipes = child.stdio as unknown as readonly (Readable | Writable | null | undefined)[];
  const providerStdin = requirePipe(allPipes, 3, child.kill.bind(child)) as Writable;
  const providerStdout = requirePipe(allPipes, 4, child.kill.bind(child)) as Readable;
  const providerStderr = requirePipe(allPipes, 5, child.kill.bind(child)) as Readable;

  return {
    get pid(): number | undefined {
      return child.pid;
    },
    providerStdin,
    providerStdout,
    providerStderr,
    writeControl(bytes: Uint8Array): void {
      // A write error surfaces through `onError`; swallowing it here would let
      // a launch that never reached the broker look like one that did.
      control?.write(bytes, (error) => {
        if (error) child.emit("error", error);
      });
    },
    endControl(): void {
      control?.end();
    },
    closeProviderChannels(): void {
      providerStdin.end();
      providerStdout.destroy();
      providerStderr.destroy();
    },
    onStatus(listener: (chunk: Uint8Array) => void): void {
      // Attached BEFORE anything is resumed, or the first frame is lost.
      status?.on("data", (chunk: Buffer) => {
        listener(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      });
      drainBrokerDiagnostics(child.stdio);
    },
    onExit(listener: (code: number | null, signal: string | null) => void): void {
      // `close` means the process ended AND every stdio handle closed. An
      // `exit` listener alone can run while data and OS handles are still live.
      child.on("close", listener);
    },
    onError(listener: (error: Error) => void): void {
      child.on("error", listener);
    },
    kill(): void {
      child.kill();
    },
    dispose(): void {
      for (const stream of child.stdio) {
        stream?.removeAllListeners();
        (stream as Readable | null)?.destroy?.();
      }
      child.removeAllListeners();
      child.unref();
    },
  };
};

function requirePipe(
  pipes: readonly (Readable | Writable | null | undefined)[],
  index: number,
  kill: () => boolean,
): Readable | Writable {
  const pipe = pipes[index];
  if (pipe !== null && pipe !== undefined) return pipe;
  kill();
  throw new Error(`the broker did not expose required pipe fd${index}`);
}

/**
 * Drains only fd2, the broker's non-authoritative diagnostics.
 *
 * fd3/4/5 belong to the caller. Resuming those before the boundary is returned
 * silently discards provider bytes before a consumer can observe them. Leaving
 * them paused applies Node's bounded stream backpressure until the consumer
 * attaches. fd0 is written to and fd1 already has its listener.
 */
export function drainBrokerDiagnostics(
  stdio: readonly (Readable | Writable | null | undefined)[],
): void {
  const diagnostics = stdio[2] as Readable | undefined;
  if (diagnostics !== undefined && diagnostics !== null) {
    diagnostics.resume();
  }
}

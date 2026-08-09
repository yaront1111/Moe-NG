import { observedExecutionRejection, type ObservedVerifierExecution } from "./verifier-execution.js";
import { createStreamCollector } from "./verifier-process-capture.js";
import {
  MAX_VERIFIER_RUN_MS,
  VERIFIER_REAP_GRACE_MS,
  evidenceRefusal,
  hermeticVerifierEnvironment,
  processRefusal,
  type RunVerifierProcessInput,
  type RunVerifierProcessResult,
  type VerifierCapture,
  type VerifierProcessErrorCode,
} from "./verifier-process-contract.js";
import type { LaunchedProcess, VerifierExitObservation } from "./verifier-process-launcher.js";

type Interruption = Extract<
  VerifierProcessErrorCode,
  "VERIFIER_PROCESS_TIMED_OUT" | "VERIFIER_PROCESS_CANCELLED" | "VERIFIER_PROCESS_OUTPUT_OVERFLOW"
>;

const INTERRUPTION_MESSAGE: Readonly<Record<Interruption, string>> = Object.freeze({
  VERIFIER_PROCESS_TIMED_OUT: "the verifier outlived its deadline and its tree was killed",
  VERIFIER_PROCESS_CANCELLED: "the caller cancelled the run and its tree was killed",
  VERIFIER_PROCESS_OUTPUT_OVERFLOW: "the verifier exceeded the per-stream output bound",
});

interface RunObservation {
  readonly capture: VerifierCapture;
  readonly exit: VerifierExitObservation | null;
  readonly error: unknown;
  readonly interruption: Interruption | null;
  readonly reaped: boolean;
}

/**
 * Copied ONCE, by INDEX, and both spawned and reported from that one copy.
 *
 * `Array.isArray` is true for a subclass, and a subclass can override
 * `Symbol.iterator` to yield values its indices never held — so destructuring
 * the recipe would spawn one command while the seal and the evidence layer both
 * inspected another. This is the same index-only discipline verifier-execution.ts
 * documents, applied on the side that actually starts a process.
 */
function readArgv(source: readonly string[]): readonly string[] | null {
  if (!Array.isArray(source) || source.length === 0) {
    return null;
  }
  const argv: string[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const entry = source[index];
    if (typeof entry !== "string") {
      return null;
    }
    argv.push(entry);
  }
  return Object.freeze(argv);
}

/** Never echoes the executable path or any environment value, only the OS code. */
function spawnMessage(error: unknown): string {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === "string"
    ? `the verifier executable could not be started (${code})`
    : "the verifier executable could not be started";
}

/** A kill is a request; only a close inside the grace window proves the tree is gone. */
async function awaitReap(closed: Promise<void>, graceMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), graceMs);
  });
  try {
    return await Promise.race([closed.then(() => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function observeProcess(
  input: RunVerifierProcessInput,
  launched: LaunchedProcess,
  startedAt: string,
  startedMs: number,
): Promise<RunObservation> {
  const stdout = createStreamCollector();
  const stderr = createStreamCollector();
  const state: { interruption: Interruption | null; sealed: boolean } = {
    interruption: null,
    sealed: false,
  };
  let releaseInterrupt: () => void = () => undefined;
  const interrupted = new Promise<void>((resolve) => {
    releaseInterrupt = resolve;
  });
  const interrupt = (kind: Interruption): void => {
    if (state.interruption !== null) {
      return;
    }
    state.interruption = kind;
    launched.kill();
    releaseInterrupt();
  };
  // An unreaped tree keeps writing after this run has already answered. Dropping
  // post-seal chunks stops a process nobody can kill from growing a buffer the
  // sealed capture will never contain.
  const onChunk = (append: (chunk: Uint8Array) => boolean) => (chunk: Uint8Array) => {
    if (!state.sealed && append(chunk)) {
      interrupt("VERIFIER_PROCESS_OUTPUT_OVERFLOW");
    }
  };
  launched.onStdout(onChunk(stdout.append));
  launched.onStderr(onChunk(stderr.append));

  const observed: { exit: VerifierExitObservation | null; error: unknown } = {
    exit: null,
    error: null,
  };
  const closed = launched.closed.then(
    (value) => {
      observed.exit = value;
    },
    (error: unknown) => {
      observed.error = error;
    },
  );
  const deadline = setTimeout(
    () => interrupt("VERIFIER_PROCESS_TIMED_OUT"),
    input.timeoutMs ?? MAX_VERIFIER_RUN_MS,
  );
  const onAbort = (): void => interrupt("VERIFIER_PROCESS_CANCELLED");
  input.signal?.addEventListener("abort", onAbort, { once: true });

  let reaped = true;
  try {
    await Promise.race([closed, interrupted]);
    if (state.interruption !== null) {
      reaped = await awaitReap(closed, input.reapGraceMs ?? VERIFIER_REAP_GRACE_MS);
    }
  } finally {
    // Cleared on the refusal paths too: a retained deadline or abort listener
    // outlives the run and leaks once per launch.
    clearTimeout(deadline);
    input.signal?.removeEventListener("abort", onAbort);
    state.sealed = true;
  }
  return {
    capture: Object.freeze({
      stdout: stdout.seal(),
      stderr: stderr.seal(),
      exitCode: observed.exit?.exitCode ?? null,
      signal: observed.exit?.signal ?? null,
      startedAt,
      completedAt: input.clock.now(),
      durationMs: Math.max(0, input.clock.monotonicMs() - startedMs),
    }),
    exit: observed.exit,
    error: observed.error,
    interruption: state.interruption,
    reaped,
  };
}

function classify(
  input: RunVerifierProcessInput,
  argv: readonly string[],
  observation: RunObservation,
): RunVerifierProcessResult {
  const { capture, exit } = observation;
  if (!observation.reaped) {
    const message = "the killed process tree did not close inside the reap grace window";
    return processRefusal("VERIFIER_PROCESS_TREE_UNREAPED", "REAP", message, capture);
  }
  if (observation.error !== null) {
    const message = spawnMessage(observation.error);
    return processRefusal("VERIFIER_PROCESS_SPAWN_FAILED", "SPAWN", message, capture);
  }
  if (observation.interruption !== null) {
    const code = observation.interruption;
    return processRefusal(code, "CAPTURE", INTERRUPTION_MESSAGE[code], capture);
  }
  // An absent exit code and a signal this wrapper never sent are both the
  // ABSENCE of a fact, not a failed run: neither may become an execution.
  if (exit === null || exit.exitCode === null) {
    const signal = exit?.signal ?? null;
    const message =
      signal === null
        ? "the child closed reporting neither an exit code nor a signal"
        : `the child was terminated by ${signal}, which this wrapper did not send`;
    return processRefusal("VERIFIER_PROCESS_EXIT_AMBIGUOUS", "CAPTURE", message, capture);
  }
  const execution: ObservedVerifierExecution = Object.freeze({
    argv,
    disposition: exit.exitCode === 0 ? "COMPLETED" : "FAILED",
    exitCode: exit.exitCode,
    outputs: input.outputs,
    runtimeObservation: input.runtimeObservation,
    startedAt: capture.startedAt,
    completedAt: capture.completedAt,
  });
  const rejection = observedExecutionRejection(execution, input.recipe);
  return rejection === null
    ? Object.freeze({ ok: true as const, execution, capture })
    : evidenceRefusal(rejection, capture);
}

/**
 * SPAWN and CAPTURE. Reached only after the launch gate accepted and the run
 * registry admitted this grant, so by here an external effect is authorised.
 */
export async function executeVerifierRun(
  input: RunVerifierProcessInput,
): Promise<RunVerifierProcessResult> {
  const argv = readArgv(input.recipe.argv);
  const file = argv?.[0];
  if (argv === null || file === undefined) {
    const message = "the recipe names no executable";
    return processRefusal("VERIFIER_PROCESS_EXECUTABLE_UNSUPPORTED", "LAUNCH_GATE", message);
  }
  const args = argv.slice(1);
  const startedAt = input.clock.now();
  const startedMs = input.clock.monotonicMs();
  let launched: LaunchedProcess;
  try {
    launched = input.launcher.launch({
      file,
      args,
      cwd: input.candidateRoot,
      env: hermeticVerifierEnvironment(input.baseEnvironment),
    });
  } catch (error) {
    return processRefusal("VERIFIER_PROCESS_SPAWN_FAILED", "SPAWN", spawnMessage(error));
  }
  return classify(input, argv, await observeProcess(input, launched, startedAt, startedMs));
}

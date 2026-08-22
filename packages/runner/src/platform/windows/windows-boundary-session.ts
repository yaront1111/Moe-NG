import { type Readable, type Writable } from "node:stream";

import { type BrokerPipes } from "./windows-broker-process.js";
import { exitWithoutFrame, transportFailure } from "./windows-boundary-failure.js";
import { createFrameReader } from "./windows-frames.js";
import { decodeStatus, type BrokerStatus } from "./windows-status.js";
import {
  provenRun,
  unknownOutcome,
  type WindowsProcessIdentity,
  type WindowsProcessOutcome,
  type WindowsProcessUnknown,
} from "./windows-process-contract.js";

/** One live broker session. Completion means its process and pipes are closed. */
export interface WindowsProcessBoundary {
  readonly started: Promise<WindowsProcessIdentity | WindowsProcessUnknown>;
  readonly completed: Promise<WindowsProcessOutcome>;
  readonly providerStdin: Writable;
  readonly providerStdout: Readable;
  readonly providerStderr: Readable;
  cancel(): void;
  close(): Promise<WindowsProcessOutcome>;
}

type Cancellation = "NONE" | "REQUESTED" | "TIMEOUT";

export class BrokerSession implements WindowsProcessBoundary {
  readonly started: Promise<WindowsProcessIdentity | WindowsProcessUnknown>;
  readonly completed: Promise<WindowsProcessOutcome>;
  readonly providerStdin: Writable;
  readonly providerStdout: Readable;
  readonly providerStderr: Readable;

  private readonly reader = createFrameReader("STATUS");
  private identity: WindowsProcessIdentity | null = null;
  private terminal: WindowsProcessOutcome | null = null;
  private cancellation: Cancellation = "NONE";
  private settled = false;
  private launchTimer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pipes: BrokerPipes;
  private readonly cancelGraceMs: number;
  private announceStart: (value: WindowsProcessIdentity | WindowsProcessUnknown) => void = () => {};
  private announceEnd: (value: WindowsProcessOutcome) => void = () => {};

  constructor(
    pipes: BrokerPipes,
    launch: Uint8Array,
    timeoutMs: number,
    cancelGraceMs: number,
  ) {
    this.pipes = pipes;
    this.cancelGraceMs = cancelGraceMs;
    this.providerStdin = pipes.providerStdin;
    this.providerStdout = pipes.providerStdout;
    this.providerStderr = pipes.providerStderr;
    this.started = new Promise((resolve) => { this.announceStart = resolve; });
    this.completed = new Promise((resolve) => { this.announceEnd = resolve; });
    this.attach();
    this.launchTimer = setTimeout(() => this.requestCancel("TIMEOUT"), timeoutMs);
    this.launchTimer.unref?.();
    try {
      pipes.writeControl(launch);
    } catch (error) {
      this.onChannelError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  cancel(): void {
    this.requestCancel("REQUESTED");
  }

  async close(): Promise<WindowsProcessOutcome> {
    this.cancel();
    return this.completed;
  }

  private attach(): void {
    this.pipes.onStatus((chunk) => this.onStatusChunk(chunk));
    this.pipes.onError((error) => this.onChannelError(error));
    this.pipes.onExit((code, signal) => this.onBrokerClosed(code, signal));
  }

  private onStatusChunk(chunk: Uint8Array): void {
    if (this.settled) return;
    this.reader.push(chunk);
    for (;;) {
      const read = this.reader.next();
      if (read.kind === "PENDING") return;
      if (read.kind === "REFUSED") {
        this.recordTerminal(read.failure);
        return;
      }
      this.onStatus(decodeStatus(read.frame));
    }
  }

  private onStatus(status: BrokerStatus | WindowsProcessUnknown): void {
    if (this.terminal !== null) {
      this.recordTerminal(transportFailure(
        "PROCESS_BOUNDARY_FRAME_TRAILING_BYTES",
        "a status frame arrived after a terminal status",
        this.identity,
      ), true);
      return;
    }
    if ("truthClass" in status) return this.recordTerminal(status);
    if (status.kind === "STARTED") return this.onStarted(status.identity);
    if (status.kind === "REFUSED") return this.recordBrokerRefusal(status);
    this.onCompleted(status);
  }

  private onStarted(identity: WindowsProcessIdentity): void {
    if (this.identity !== null) {
      this.recordTerminal(transportFailure(
        "PROCESS_BOUNDARY_STATUS_OUT_OF_ORDER",
        "the broker emitted more than one started frame",
        this.identity,
      ));
      return;
    }
    const proof = provenRun(identity, 0);
    if (proof.truthClass === "UNKNOWN") {
      this.recordTerminal(proof);
      return;
    }
    this.identity = identity;
    this.announceStart(identity);
  }

  private onCompleted(status: Extract<BrokerStatus, { kind: "COMPLETED" }>): void {
    if (this.identity === null) {
      this.recordTerminal(transportFailure(
        "PROCESS_BOUNDARY_STATUS_OUT_OF_ORDER",
        "a completed frame arrived before any started frame",
        null,
      ));
      return;
    }
    this.recordTerminal(status.exit.kind === "EXITED"
      ? provenRun(this.identity, status.exit.code)
      : transportFailure(
          "PROCESS_BOUNDARY_EXIT_UNOBSERVED",
          "the broker could not observe the provider's exit exactly",
          this.identity,
        ), false, false);
  }

  private recordBrokerRefusal(status: Extract<BrokerStatus, { kind: "REFUSED" }>): void {
    this.recordTerminal(unknownOutcome(
      "PROCESS_BOUNDARY_BROKER_REFUSED",
      status.refusal.layer,
      "the broker refused; its layer-local reason and Win32 code travel with it",
      { identity: this.identity, brokerReason: status.refusal },
    ));
  }

  private recordTerminal(
    outcome: WindowsProcessOutcome,
    replace = false,
    closeChannels = true,
  ): void {
    if (this.terminal === null || replace) this.terminal = outcome;
    if (closeChannels) this.endControlAndArmKill();
    else this.armKill();
  }

  private onChannelError(error: Error): void {
    this.recordTerminal(transportFailure(
      "PROCESS_BOUNDARY_CHANNEL_FAILED",
      `the broker channel failed: ${error.message}`,
      this.identity,
    ), true);
  }

  private requestCancel(kind: Exclude<Cancellation, "NONE">): void {
    if (this.settled || this.terminal !== null || this.cancellation !== "NONE") return;
    this.cancellation = kind;
    this.endControlAndArmKill();
  }

  private endControlAndArmKill(): void {
    try {
      this.pipes.endControl();
      // The broker observes provider stdout/stderr EOF as part of its terminal
      // proof. Keeping Node's peer endpoints open while asking it to settle
      // makes that observation impossible and forces the outer kill timer.
      this.pipes.closeProviderChannels();
    } catch (error) {
      this.terminal = transportFailure(
        "PROCESS_BOUNDARY_CHANNEL_FAILED",
        `the broker control channel could not close: ${String(error)}`,
        this.identity,
      );
    }
    this.armKill();
  }

  private armKill(): void {
    if (this.killTimer !== null) return;
    this.killTimer = setTimeout(() => this.killBroker(), this.cancelGraceMs);
    this.killTimer.unref?.();
  }

  private killBroker(): void {
    try {
      this.pipes.kill();
    } catch (error) {
      this.terminal = transportFailure(
        "PROCESS_BOUNDARY_CHANNEL_FAILED",
        `the broker process could not be terminated: ${String(error)}`,
        this.identity,
      );
    }
  }

  private onBrokerClosed(code: number | null, signal: string | null): void {
    const truncation = this.reader.finish();
    // The exit code speaks ONLY when no terminal frame did: a frame that arrived
    // is never overridden by the code the broker exited with afterwards.
    const fallback = this.cancellation === "TIMEOUT"
      ? transportFailure(
          "PROCESS_BOUNDARY_LAUNCH_TIMED_OUT",
          "the broker exited without a terminal status frame",
          this.identity,
        )
      : exitWithoutFrame(code, signal, this.identity);
    this.settle(truncation ?? this.terminal ?? fallback);
  }

  private settle(outcome: WindowsProcessOutcome): void {
    if (this.settled) return;
    this.settled = true;
    if (this.launchTimer !== null) clearTimeout(this.launchTimer);
    if (this.killTimer !== null) clearTimeout(this.killTimer);
    if (outcome.truthClass === "UNKNOWN") this.announceStart(this.identity ?? outcome);
    try {
      this.pipes.dispose();
    } catch (error) {
      outcome = transportFailure(
        "PROCESS_BOUNDARY_CHANNEL_FAILED",
        `the broker handles could not be released: ${String(error)}`,
        this.identity,
      );
    }
    this.announceEnd(outcome);
  }
}

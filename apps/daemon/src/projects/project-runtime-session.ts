import { win32 } from "node:path";
import type { Readable, Writable } from "node:stream";

import { MAX_PROJECT_STACK_FRAME_BYTES, PROJECT_STACK_PROTOCOL_FRAME_TOO_LARGE,
  PROJECT_STACK_PROTOCOL_LAYER, PROJECT_STACK_PROTOCOL_VERSION,
  decodeProjectStackHostLine, encodeProjectStackControlFrame,
} from "./project-stack-protocol.js";
import type { ProjectStackHostFrame } from "./project-stack-protocol.js";
export const PROJECT_RUNTIME_SUPERVISOR_LAYER = "PROJECT_RUNTIME_SUPERVISOR" as const;
export const PROJECT_RUNTIME_PROTOCOL_VIOLATION = "PROJECT_RUNTIME_PROTOCOL_VIOLATION" as const;
export const PROJECT_RUNTIME_READY_MISMATCH = "PROJECT_RUNTIME_READY_MISMATCH" as const;
export const PROJECT_RUNTIME_CONTROL_WRITE_FAILED = "PROJECT_RUNTIME_CONTROL_WRITE_FAILED" as const;
export interface RuntimeSessionRefused {
  readonly code: string; readonly layer: string; readonly ok: false;
}
export interface RuntimeSessionReady {
  readonly incarnationId: string; readonly ok: true; readonly origin: string;
}
export type RuntimeSessionReadyResult = RuntimeSessionReady | RuntimeSessionRefused;
export type RuntimeSessionApprovalResult = RuntimeSessionRefused | Readonly<{
  readonly ok: true; readonly state: "APPROVED";
}>;
interface Deferred<T> {
  readonly promise: Promise<T>; readonly resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve = (_value: T): void => {};
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
const managerRefusal = (code: string): RuntimeSessionRefused => Object.freeze({
  code, layer: PROJECT_RUNTIME_SUPERVISOR_LAYER, ok: false as const,
});
export const canonicalWindowsStoreKey = (path: string): string =>
  win32.normalize(path).toLowerCase();
export async function boundedRuntimePromise<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expiry = new Promise<Readonly<{ kind: "TIMEOUT" }>>((resolve) => {
    timer = setTimeout(() => resolve(Object.freeze({ kind: "TIMEOUT" as const })), timeoutMs); timer.unref?.(); });
  const value = promise.then((result) => Object.freeze({ kind: "VALUE" as const, value: result }),
    () => Object.freeze({ kind: "REJECTED" as const }));
  const outcome = await Promise.race([value, expiry]); if (timer !== null) clearTimeout(timer); return outcome;
}
function protocolRefusal(code: string, layer: string): RuntimeSessionRefused {
  return Object.freeze({ code, layer, ok: false });
}
async function writeControl(
  output: Writable,
  frame: Parameters<typeof encodeProjectStackControlFrame>[0],
): Promise<RuntimeSessionRefused | null> {
  const encoded = encodeProjectStackControlFrame(frame);
  if (!encoded.ok) return protocolRefusal(encoded.code, encoded.layer);
  return await new Promise((resolve) => {
    try {
      output.write(encoded.line, (error: Error | null | undefined) => {
        resolve(error === null || error === undefined
          ? null : managerRefusal(PROJECT_RUNTIME_CONTROL_WRITE_FAILED));
      });
    } catch { resolve(managerRefusal(PROJECT_RUNTIME_CONTROL_WRITE_FAILED)); }
  });
}
type Phase = "AWAITING_READY" | "READY" | "TERMINAL" | "FAILED";
export interface ProjectRuntimeSessionOptions {
  readonly instanceId: string; readonly onTerminal: (exitCode: number) => void;
  readonly onViolation: (failure: RuntimeSessionRefused) => void; readonly projectId: string;
  readonly stdin: Writable; readonly stdout: Readable; readonly storePath: string;
}

/** Strict, bounded state machine for one stack host's private JSON-line channel. */
export class ProjectRuntimeSession {
  readonly closed: Promise<void>;
  readonly ready: Promise<RuntimeSessionReadyResult>;
  private phase: Phase = "AWAITING_READY";
  private incarnationId: string | null = null;
  private pending = Buffer.alloc(0);
  private approval: Deferred<RuntimeSessionApprovalResult> | null = null;
  private readonly closedDeferred = deferred<void>();
  private readonly readyDeferred = deferred<RuntimeSessionReadyResult>();
  private readonly options: ProjectRuntimeSessionOptions;

  constructor(options: ProjectRuntimeSessionOptions) {
    this.options = options;
    this.closed = this.closedDeferred.promise;
    this.ready = this.readyDeferred.promise;
    void this.pump().finally(() => { this.closedDeferred.resolve(); });
  }

  hasPendingApproval(): boolean { return this.approval !== null; }

  async approvePairing(confirmationLabel: string): Promise<RuntimeSessionApprovalResult> {
    if (this.phase !== "READY" || this.approval !== null) {
      return managerRefusal(PROJECT_RUNTIME_PROTOCOL_VIOLATION);
    }
    const approval = deferred<RuntimeSessionApprovalResult>();
    this.approval = approval;
    const failure = await writeControl(this.options.stdin, {
      confirmationLabel,
      instanceId: this.options.instanceId,
      kind: "APPROVE_PAIRING",
      schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    });
    if (failure !== null && this.approval === approval) {
      this.approval = null;
      return failure;
    }
    return await approval.promise;
  }

  async stop(): Promise<RuntimeSessionRefused | null> {
    if (this.phase !== "READY" || this.approval !== null) {
      return managerRefusal(PROJECT_RUNTIME_PROTOCOL_VIOLATION);
    }
    return await writeControl(this.options.stdin, {
      instanceId: this.options.instanceId,
      kind: "STOP",
      schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    });
  }

  abort(failure: RuntimeSessionRefused): void { this.violate(failure); }

  private async pump(): Promise<void> {
    try {
      for await (const value of this.options.stdout) {
        const chunk = Buffer.isBuffer(value) ? value
          : value instanceof Uint8Array ? Buffer.from(value)
          : typeof value === "string" ? Buffer.from(value, "utf8") : null;
        if (chunk === null || !this.consume(chunk)) return;
      }
      if (this.phase === "FAILED") return;
      if (this.pending.byteLength > 0) {
        const last = this.pending;
        this.pending = Buffer.alloc(0);
        if (!this.decode(last)) return;
      }
      if (this.phase === "AWAITING_READY") this.violate(managerRefusal(PROJECT_RUNTIME_PROTOCOL_VIOLATION));
      else if (this.approval !== null) this.violate(managerRefusal(PROJECT_RUNTIME_PROTOCOL_VIOLATION));
    } catch {
      this.violate(managerRefusal(PROJECT_RUNTIME_PROTOCOL_VIOLATION));
    }
  }

  private consume(chunk: Buffer): boolean {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.byteLength : newline + 1;
      const segment = chunk.subarray(offset, end);
      if (this.pending.byteLength + segment.byteLength > MAX_PROJECT_STACK_FRAME_BYTES) {
        this.violate(protocolRefusal(
          PROJECT_STACK_PROTOCOL_FRAME_TOO_LARGE, PROJECT_STACK_PROTOCOL_LAYER,
        ));
        return false;
      }
      const line = this.pending.byteLength === 0
        ? segment
        : Buffer.concat([this.pending, segment]);
      this.pending = Buffer.alloc(0);
      if (newline < 0) {
        this.pending = Buffer.from(line);
        return true;
      }
      if (!this.decode(line)) return false;
      offset = end;
    }
    return true;
  }

  private decode(line: Uint8Array): boolean {
    const decoded = decodeProjectStackHostLine(line);
    if (!decoded.ok) {
      this.violate(protocolRefusal(decoded.code, decoded.layer));
      return false;
    }
    return this.accept(decoded.frame);
  }

  private accept(frame: ProjectStackHostFrame): boolean {
    if (this.phase === "AWAITING_READY" && frame.kind === "START_REFUSED") {
      this.phase = "TERMINAL";
      this.readyDeferred.resolve(protocolRefusal(frame.code, frame.layer));
      return true;
    }
    if (this.phase === "AWAITING_READY" && frame.kind === "READY") return this.acceptReady(frame);
    if (this.phase === "READY" && frame.kind === "PAIRING_APPROVED") {
      return this.acceptPairingApproved(frame);
    }
    if (this.phase === "READY" && frame.kind === "PAIRING_REFUSED") {
      return this.acceptPairingRefused(frame);
    }
    if (this.phase === "READY" && frame.kind === "TERMINAL" && this.approval === null
      && frame.incarnationId === this.incarnationId
      && frame.instanceId === this.options.instanceId) {
      this.phase = "TERMINAL";
      this.options.onTerminal(frame.exitCode);
      return true;
    }
    this.violate(managerRefusal(PROJECT_RUNTIME_PROTOCOL_VIOLATION));
    return false;
  }

  private acceptReady(frame: Extract<ProjectStackHostFrame, { kind: "READY" }>): boolean {
    if (frame.instanceId !== this.options.instanceId || frame.projectId !== this.options.projectId
      || canonicalWindowsStoreKey(frame.storePath)
        !== canonicalWindowsStoreKey(this.options.storePath)) {
      this.violate(managerRefusal(PROJECT_RUNTIME_READY_MISMATCH));
      return false;
    }
    this.phase = "READY";
    this.incarnationId = frame.incarnationId;
    this.readyDeferred.resolve(Object.freeze({
      incarnationId: frame.incarnationId, ok: true as const, origin: frame.origin,
    }));
    return true;
  }

  private acceptPairingApproved(
    frame: Extract<ProjectStackHostFrame, { kind: "PAIRING_APPROVED" }>,
  ): boolean {
    const approval = this.approval;
    if (approval === null || frame.incarnationId !== this.incarnationId
      || frame.instanceId !== this.options.instanceId) {
      this.violate(managerRefusal(PROJECT_RUNTIME_PROTOCOL_VIOLATION));
      return false;
    }
    this.approval = null;
    approval.resolve(Object.freeze({ ok: true as const, state: "APPROVED" as const }));
    return true;
  }

  private acceptPairingRefused(
    frame: Extract<ProjectStackHostFrame, { kind: "PAIRING_REFUSED" }>,
  ): boolean {
    const approval = this.approval;
    if (approval === null || frame.incarnationId !== this.incarnationId
      || frame.instanceId !== this.options.instanceId) {
      this.violate(managerRefusal(PROJECT_RUNTIME_PROTOCOL_VIOLATION));
      return false;
    }
    this.approval = null;
    approval.resolve(protocolRefusal(frame.code, frame.layer));
    return true;
  }

  private violate(failure: RuntimeSessionRefused): void {
    if (this.phase === "FAILED") return;
    this.phase = "FAILED";
    this.pending = Buffer.alloc(0);
    this.readyDeferred.resolve(failure);
    const approval = this.approval;
    this.approval = null;
    approval?.resolve(failure);
    this.options.onViolation(failure);
  }
}

/** Consumes stderr to prevent child backpressure; bytes are deliberately discarded. */
export async function drainProjectRuntimeStderr(stderr: Readable): Promise<void> {
  try { for await (const _chunk of stderr) { /* discard */ } } catch { /* discard */ }
}

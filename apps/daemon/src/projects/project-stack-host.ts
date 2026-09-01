import {
  PROJECT_STACK_PROTOCOL_LAYER,
  PROJECT_STACK_PROTOCOL_VERSION,
  decodeProjectStackControlLine,
  encodeProjectStackHostFrame,
} from "./project-stack-protocol.js";
import type { ProjectStackHostFrame } from "./project-stack-protocol.js";

export const PROJECT_STACK_HOST_LAYER = "PROJECT_STACK_HOST" as const;
export const PROJECT_STACK_CONTROL_REFUSED = "PROJECT_STACK_CONTROL_REFUSED" as const;
export const PROJECT_STACK_DAEMON_START_FAILED = "PROJECT_STACK_DAEMON_START_FAILED" as const;
export const PROJECT_STACK_WRAPPER_START_FAILED = "PROJECT_STACK_WRAPPER_START_FAILED" as const;
export const PROJECT_STACK_PAIRING_APPROVAL_UNAVAILABLE =
  "PROJECT_STACK_PAIRING_APPROVAL_UNAVAILABLE" as const;

export interface ProjectStackRefused {
  readonly code: string;
  readonly layer: string;
  readonly ok: false;
}

export type ProjectStackPairingApprovalResult = ProjectStackRefused | Readonly<{
  readonly ok: true;
  readonly state: "APPROVED";
}>;

export interface ProjectStackDaemonHandle {
  approvePairing(confirmationLabel: string): ProjectStackPairingApprovalResult;
  readonly origin: string;
  shutdown(): Promise<Readonly<{ readonly ok: boolean }>>;
}

export interface ProjectStackWrapperHandle {
  readonly completed: Promise<Readonly<{ readonly code: number | null }>>;
  kill(): void;
}

export interface ProjectStackHostOptions {
  readonly controls: AsyncIterable<string | Uint8Array>;
  readonly incarnationId: string;
  readonly instanceId: string;
  readonly log: (line: string) => void;
  readonly projectId: string;
  readonly startDaemon: () => Promise<ProjectStackDaemonHandle | ProjectStackRefused>;
  readonly startWrapper: () => ProjectStackWrapperHandle;
  readonly storePath: string;
  readonly write: (line: string) => void;
}

const REASON = /^[A-Z][A-Z0-9_]{0,127}$/u;

function safeReason(value: unknown, fallback: string): string {
  return typeof value === "string" && REASON.test(value) ? value : fallback;
}

function isRefused(
  value: ProjectStackDaemonHandle | ProjectStackRefused,
): value is ProjectStackRefused {
  return "ok" in value && value.ok === false;
}

function emit(options: ProjectStackHostOptions, frame: ProjectStackHostFrame): boolean {
  const encoded = encodeProjectStackHostFrame(frame);
  if (!encoded.ok) {
    options.log(`${PROJECT_STACK_CONTROL_REFUSED} ${PROJECT_STACK_PROTOCOL_LAYER}`);
    return false;
  }
  options.write(encoded.line);
  return true;
}

function startRefusal(
  options: ProjectStackHostOptions,
  code: unknown,
  layer: unknown,
): void {
  emit(options, {
    code: safeReason(code, PROJECT_STACK_DAEMON_START_FAILED),
    incarnationId: options.incarnationId,
    kind: "START_REFUSED",
    layer: safeReason(layer, PROJECT_STACK_HOST_LAYER),
    schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
  });
}

async function stopHandles(
  daemon: ProjectStackDaemonHandle,
  wrapper: ProjectStackWrapperHandle,
  killWrapper: boolean,
): Promise<boolean> {
  let stopped = false;
  try { stopped = (await daemon.shutdown()).ok; } catch { stopped = false; }
  if (killWrapper) {
    try { wrapper.kill(); } catch { stopped = false; }
    try { await wrapper.completed; } catch { stopped = false; }
  }
  return stopped;
}

function terminal(options: ProjectStackHostOptions, exitCode: number): void {
  emit(options, {
    exitCode,
    incarnationId: options.incarnationId,
    instanceId: options.instanceId,
    kind: "TERMINAL",
    schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
  });
}

function approvePairing(
  options: ProjectStackHostOptions,
  daemon: ProjectStackDaemonHandle,
  confirmationLabel: string,
): void {
  let approval: ProjectStackPairingApprovalResult;
  try { approval = daemon.approvePairing(confirmationLabel); }
  catch {
    approval = {
      code: PROJECT_STACK_PAIRING_APPROVAL_UNAVAILABLE,
      layer: PROJECT_STACK_HOST_LAYER,
      ok: false,
    };
  }
  if (!approval.ok) {
    emit(options, {
      code: safeReason(approval.code, PROJECT_STACK_PAIRING_APPROVAL_UNAVAILABLE),
      incarnationId: options.incarnationId,
      instanceId: options.instanceId,
      kind: "PAIRING_REFUSED",
      layer: safeReason(approval.layer, PROJECT_STACK_HOST_LAYER),
      schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    });
    return;
  }
  emit(options, {
    incarnationId: options.incarnationId,
    instanceId: options.instanceId,
    kind: "PAIRING_APPROVED",
    schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
  });
}

/** Owns one daemon and wrapper for exactly one project inside a Windows Job. */
export async function runProjectStackHost(options: ProjectStackHostOptions): Promise<number> {
  let started: ProjectStackDaemonHandle | ProjectStackRefused;
  try { started = await options.startDaemon(); }
  catch {
    startRefusal(options, PROJECT_STACK_DAEMON_START_FAILED, PROJECT_STACK_HOST_LAYER);
    return 1;
  }
  if (isRefused(started)) {
    startRefusal(options, started.code, started.layer);
    return 1;
  }
  const daemon = started;

  let wrapper: ProjectStackWrapperHandle;
  try { wrapper = options.startWrapper(); }
  catch {
    await daemon.shutdown().catch(() => ({ ok: false }));
    startRefusal(options, PROJECT_STACK_WRAPPER_START_FAILED, PROJECT_STACK_HOST_LAYER);
    return 1;
  }

  if (!emit(options, {
    incarnationId: options.incarnationId,
    instanceId: options.instanceId,
    kind: "READY",
    origin: daemon.origin,
    projectId: options.projectId,
    schemaVersion: PROJECT_STACK_PROTOCOL_VERSION,
    storePath: options.storePath,
  })) {
    await stopHandles(daemon, wrapper, true);
    return 1;
  }

  const controls = options.controls[Symbol.asyncIterator]();
  let next = controls.next();
  for (;;) {
    const event = await Promise.race([
      next.then((value) => ({ kind: "CONTROL" as const, value })),
      wrapper.completed.then((value) => ({ kind: "WRAPPER" as const, value })),
    ]);
    if (event.kind === "WRAPPER") {
      const code = event.value.code ?? 1;
      const stopped = await stopHandles(daemon, wrapper, false);
      const exitCode = stopped ? code : 1;
      terminal(options, exitCode);
      return exitCode;
    }
    if (event.value.done === true) {
      options.log(`${PROJECT_STACK_CONTROL_REFUSED} ${PROJECT_STACK_PROTOCOL_LAYER}`);
      await stopHandles(daemon, wrapper, true);
      terminal(options, 1);
      return 1;
    }
    const decoded = decodeProjectStackControlLine(event.value.value);
    if (!decoded.ok) {
      options.log(`${PROJECT_STACK_CONTROL_REFUSED} ${decoded.layer}`);
      await stopHandles(daemon, wrapper, true);
      terminal(options, 1);
      return 1;
    }
    if (decoded.frame.instanceId !== options.instanceId) {
      options.log(`${PROJECT_STACK_CONTROL_REFUSED} ${PROJECT_STACK_PROTOCOL_LAYER}`);
      await stopHandles(daemon, wrapper, true);
      terminal(options, 1);
      return 1;
    }
    if (decoded.frame.kind === "APPROVE_PAIRING") {
      approvePairing(options, daemon, decoded.frame.confirmationLabel);
      next = controls.next();
      continue;
    }
    const stopped = await stopHandles(daemon, wrapper, true);
    const exitCode = stopped ? 0 : 1;
    terminal(options, exitCode);
    return exitCode;
  }
}

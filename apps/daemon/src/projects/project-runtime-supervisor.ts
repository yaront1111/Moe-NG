import type { Readable, Writable } from "node:stream";
import type { ProjectCatalogEntry } from "./project-catalog.js";
import { PROJECT_RUNTIME_CONTROL_WRITE_FAILED, PROJECT_RUNTIME_PROTOCOL_VIOLATION,
  PROJECT_RUNTIME_SUPERVISOR_LAYER,
  ProjectRuntimeSession, boundedRuntimePromise, canonicalWindowsStoreKey, drainProjectRuntimeStderr } from "./project-runtime-session.js";
export { PROJECT_RUNTIME_CONTROL_WRITE_FAILED, PROJECT_RUNTIME_PROTOCOL_VIOLATION,
  PROJECT_RUNTIME_READY_MISMATCH, PROJECT_RUNTIME_SUPERVISOR_LAYER } from "./project-runtime-session.js";
export const PROJECT_RUNTIME_LIFECYCLES = Object.freeze([
  "STARTING", "RUNNING", "STOPPING", "STOPPED", "FAILED", "UNKNOWN"] as const);
export type ProjectRuntimeLifecycle = (typeof PROJECT_RUNTIME_LIFECYCLES)[number];
export interface ProjectRuntimeBoundaryUnknown { readonly code: string; readonly layer: string; readonly truthClass: "UNKNOWN" }
export interface ProjectRuntimeBoundaryIdentity { readonly creationTime: bigint; readonly pid: number }
export interface ProjectRuntimeBoundaryProven { readonly exitCode: number; readonly identity: ProjectRuntimeBoundaryIdentity; readonly truthClass: "PROVEN" }
export type ProjectRuntimeBoundaryOutcome = ProjectRuntimeBoundaryProven | ProjectRuntimeBoundaryUnknown;
export interface ProjectRuntimeBoundary {
  readonly completed: Promise<ProjectRuntimeBoundaryOutcome>; readonly providerStderr: Readable; readonly providerStdin: Writable;
  readonly providerStdout: Readable; readonly started: Promise<ProjectRuntimeBoundaryIdentity | ProjectRuntimeBoundaryUnknown>;
  cancel(): void; close(): Promise<ProjectRuntimeBoundaryOutcome> }
export interface ProjectRuntimeView { readonly instanceId: string; readonly lifecycle: ProjectRuntimeLifecycle; readonly projectId: string; readonly root: string; readonly title: string }
export interface ProjectRuntimeRefused { readonly code: string; readonly layer: string; readonly ok: false }
export interface ProjectRuntimeAccepted { readonly code: string; readonly layer: string; readonly ok: true }
export type ProjectRuntimeActionResult = ProjectRuntimeAccepted | ProjectRuntimeRefused;
export type ProjectRuntimeCompletionResult = ProjectRuntimeRefused | Readonly<{ readonly code: "PROJECT_RUNTIME_COMPLETED"; readonly exitCode: number; readonly layer: typeof PROJECT_RUNTIME_SUPERVISOR_LAYER; readonly ok: true }>;
export type ProjectRuntimeOpenResult = ProjectRuntimeActionResult | Readonly<{ readonly code: "PROJECT_RUNTIME_OPENED"; readonly layer: typeof PROJECT_RUNTIME_SUPERVISOR_LAYER; readonly ok: true; readonly origin: string }>;
export interface ProjectRuntimeSupervisorOptions { readonly timeoutMs?: number;
  readonly openBoundary: (entry: ProjectCatalogEntry) => ProjectRuntimeBoundary | ProjectRuntimeBoundaryUnknown }
export interface ProjectRuntimeSupervisor {
  approvePairing(instanceId: string, confirmationLabel: string): Promise<ProjectRuntimeActionResult>;
  list(entries: readonly ProjectCatalogEntry[]): readonly ProjectRuntimeView[];
  open(instanceId: string): Promise<ProjectRuntimeOpenResult>; shutdown(): Promise<ProjectRuntimeActionResult>;
  start(entry: ProjectCatalogEntry): Promise<ProjectRuntimeActionResult>; stop(instanceId: string): Promise<ProjectRuntimeActionResult>;
  wait(instanceId: string): Promise<ProjectRuntimeCompletionResult> }
type Operation = "APPROVE" | "START" | "STOP" | null;
interface RuntimeRecord {
  active: boolean; boundary: ProjectRuntimeBoundary | null; completion: ProjectRuntimeBoundaryOutcome | null;
  compromised: boolean; readonly entry: ProjectCatalogEntry; hostExitCode: number | null;
  lifecycle: ProjectRuntimeLifecycle; operation: Operation; origin: string | null;
  session: ProjectRuntimeSession | null;
  readonly storeKey: string; stopRequested: boolean; teardownRequested: boolean }
const STABLE_NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;
const CONFIRMATION_LABEL = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u;
const DEFAULT_TIMEOUT_MS = 10_000;
const refused = (code: string, layer: string = PROJECT_RUNTIME_SUPERVISOR_LAYER): ProjectRuntimeRefused => Object.freeze({ code, layer, ok: false });
const accepted = (code: string): ProjectRuntimeAccepted => Object.freeze({ code, layer: PROJECT_RUNTIME_SUPERVISOR_LAYER, ok: true });
function boundaryRefusal(value: ProjectRuntimeBoundaryUnknown): ProjectRuntimeRefused {
  return STABLE_NAME.test(value.code) && STABLE_NAME.test(value.layer)
    ? refused(value.code, value.layer) : refused("PROJECT_RUNTIME_BOUNDARY_REFUSED"); }
function isUnknown(value: unknown): value is ProjectRuntimeBoundaryUnknown {
  return typeof value === "object" && value !== null && Reflect.get(value, "truthClass") === "UNKNOWN"; }
function validIdentity(value: unknown): value is ProjectRuntimeBoundaryIdentity {
  return typeof value === "object" && value !== null
    && Number.isSafeInteger(Reflect.get(value, "pid")) && Number(Reflect.get(value, "pid")) > 0
    && typeof Reflect.get(value, "creationTime") === "bigint" && (Reflect.get(value, "creationTime") as bigint) > 0n; }
function isProven(value: unknown): value is ProjectRuntimeBoundaryProven {
  return typeof value === "object" && value !== null && Reflect.get(value, "truthClass") === "PROVEN"
    && Number.isSafeInteger(Reflect.get(value, "exitCode")) && Number(Reflect.get(value, "exitCode")) >= 0
    && validIdentity(Reflect.get(value, "identity")); }
export function createProjectRuntimeSupervisor(options: ProjectRuntimeSupervisorOptions): ProjectRuntimeSupervisor {
  const records = new Map<string, RuntimeRecord>();
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
    ? options.timeoutMs as number : DEFAULT_TIMEOUT_MS;
  let shutdownInProgress = false;
  function requestClose(record: RuntimeRecord): void {
    try { record.boundary?.cancel(); } catch { /* completion remains unproven */ }
    try { void record.boundary?.close().catch(() => undefined); } catch { /* unproven */ } }
  function compromise(record: RuntimeRecord): void {
    if (record.compromised) return;
    record.compromised = true;
    if (!record.teardownRequested || record.active) record.lifecycle = "UNKNOWN";
    if (record.active) requestClose(record);
  }
  function classifyCompletion(record: RuntimeRecord, outcome: ProjectRuntimeBoundaryOutcome): void {
    record.completion = outcome;
    if (isUnknown(outcome)) { record.lifecycle = "UNKNOWN"; return; }
    record.active = false;
    if (record.hostExitCode !== null && record.hostExitCode !== outcome.exitCode) record.compromised = true;
    record.lifecycle = record.teardownRequested ? "STOPPED"
      : record.compromised ? "UNKNOWN" : record.stopRequested ? "STOPPED" : "FAILED";
  }
  async function settleCompletion(record: RuntimeRecord, outcome: ProjectRuntimeBoundaryOutcome): Promise<boolean> {
    record.completion = outcome;
    if (!isUnknown(outcome) && !isProven(outcome)) { record.lifecycle = "UNKNOWN"; return false; }
    if (!isUnknown(outcome) && record.session !== null &&
      (await boundedRuntimePromise(record.session.closed, timeoutMs)).kind !== "VALUE") {
      record.compromised = true; record.lifecycle = "UNKNOWN"; return false; }
    classifyCompletion(record, outcome);
    return !isUnknown(outcome) && (!record.compromised || record.teardownRequested);
  }
  function observeCompletion(record: RuntimeRecord): void {
    const boundary = record.boundary;
    if (boundary === null) return;
    void boundary.completed.then(
      async (outcome) => { if (records.get(record.entry.instanceId) === record) await settleCompletion(record, outcome); },
      () => { if (records.get(record.entry.instanceId) === record) record.lifecycle = "UNKNOWN"; },
    );
  }
  function startSession(record: RuntimeRecord, boundary: ProjectRuntimeBoundary): ProjectRuntimeSession {
    void drainProjectRuntimeStderr(boundary.providerStderr);
    return new ProjectRuntimeSession({
      instanceId: record.entry.instanceId, projectId: record.entry.projectId,
      onTerminal: (exitCode) => {
        record.hostExitCode = exitCode;
        if (record.completion !== null && !isUnknown(record.completion)
          && record.completion.exitCode !== exitCode) compromise(record);
      },
      onViolation: () => { compromise(record); },
      stdin: boundary.providerStdin, stdout: boundary.providerStdout, storePath: record.entry.storePath,
    });
  }
  async function start(entry: ProjectCatalogEntry): Promise<ProjectRuntimeActionResult> {
    const prior = records.get(entry.instanceId);
    if (prior?.active === true) return refused("PROJECT_RUNTIME_INSTANCE_ACTIVE");
    const storeKey = canonicalWindowsStoreKey(entry.storePath);
    if ([...records.values()].some((record) => record.active && record.storeKey === storeKey))
      return refused("PROJECT_RUNTIME_STORE_ACTIVE");
    const record: RuntimeRecord = { active: true, boundary: null, completion: null,
      compromised: false, entry: Object.freeze({ ...entry }), hostExitCode: null,
      lifecycle: "STARTING", operation: "START", origin: null, session: null, storeKey, stopRequested: false,
      teardownRequested: false };
    records.set(entry.instanceId, record);
    let opened: ProjectRuntimeBoundary | ProjectRuntimeBoundaryUnknown;
    try { opened = options.openBoundary(record.entry); }
    catch { record.active = false; record.lifecycle = "UNKNOWN"; record.operation = null;
      return refused("PROJECT_RUNTIME_BOUNDARY_REFUSED"); }
    if (isUnknown(opened)) {
      record.active = false; record.lifecycle = "UNKNOWN"; record.operation = null;
      return boundaryRefusal(opened); }
    record.boundary = opened;
    record.session = startSession(record, opened);
    observeCompletion(record);
    const brokerStarted = await boundedRuntimePromise(opened.started, timeoutMs);
    if (brokerStarted.kind === "REJECTED") { record.lifecycle = "UNKNOWN"; record.operation = null;
      requestClose(record); return refused("PROJECT_RUNTIME_BOUNDARY_REFUSED"); }
    if (brokerStarted.kind === "TIMEOUT") { record.lifecycle = "UNKNOWN"; record.operation = null;
      requestClose(record); return refused("PROJECT_RUNTIME_START_TIMEOUT"); }
    if (isUnknown(brokerStarted.value)) { record.lifecycle = "UNKNOWN"; record.operation = null;
      requestClose(record); return boundaryRefusal(brokerStarted.value); }
    if (!validIdentity(brokerStarted.value)) { record.lifecycle = "UNKNOWN"; record.operation = null;
      requestClose(record); return refused("PROJECT_RUNTIME_BOUNDARY_REFUSED"); }
    const ready = await boundedRuntimePromise(record.session.ready, timeoutMs);
    record.operation = null;
    if (ready.kind === "REJECTED") { record.lifecycle = "UNKNOWN"; requestClose(record);
      return refused("PROJECT_RUNTIME_BOUNDARY_REFUSED"); }
    if (ready.kind === "TIMEOUT") { record.lifecycle = "UNKNOWN"; requestClose(record);
      return refused("PROJECT_RUNTIME_START_TIMEOUT"); }
    if (!ready.value.ok) {
      if (!record.compromised) record.lifecycle = "FAILED"; return ready.value; }
    if (record.completion !== null || record.teardownRequested)
      return refused("PROJECT_RUNTIME_EXITED_BEFORE_READY");
    record.origin = ready.value.origin;
    record.lifecycle = "RUNNING";
    return accepted("PROJECT_RUNTIME_STARTED");
  }
  async function stop(instanceId: string): Promise<ProjectRuntimeActionResult> {
    const record = records.get(instanceId);
    if (record?.operation !== null && record?.operation !== undefined)
      return refused("PROJECT_RUNTIME_OPERATION_ACTIVE");
    if (record === undefined || record.lifecycle !== "RUNNING" || record.session === null
      || record.boundary === null) return refused("PROJECT_RUNTIME_NOT_RUNNING");
    if (record.session.hasPendingApproval()) return refused("PROJECT_RUNTIME_OPERATION_ACTIVE");
    record.lifecycle = "STOPPING"; record.operation = "STOP"; record.stopRequested = true;
    const write = await boundedRuntimePromise(record.session.stop(), timeoutMs);
    if (write.kind === "REJECTED") {
      record.operation = null;
      const failure = refused(PROJECT_RUNTIME_CONTROL_WRITE_FAILED);
      record.session.abort(failure);
      return failure;
    }
    if (write.kind === "TIMEOUT") {
      record.operation = null;
      record.session.abort(refused(PROJECT_RUNTIME_PROTOCOL_VIOLATION));
      return refused("PROJECT_RUNTIME_STOP_TIMEOUT");
    }
    const writeFailure = write.value;
    if (writeFailure !== null) { record.operation = null; compromise(record); return writeFailure; }
    const completion = await boundedRuntimePromise(record.boundary.completed, timeoutMs);
    record.operation = null;
    if (completion.kind === "REJECTED") { record.lifecycle = "UNKNOWN"; requestClose(record); return refused("PROJECT_RUNTIME_BOUNDARY_REFUSED"); }
    if (completion.kind === "TIMEOUT") { record.lifecycle = "UNKNOWN"; requestClose(record); return refused("PROJECT_RUNTIME_STOP_TIMEOUT"); }
    const settled = await settleCompletion(record, completion.value);
    return isUnknown(completion.value) ? boundaryRefusal(completion.value)
      : !settled ? refused(PROJECT_RUNTIME_PROTOCOL_VIOLATION)
      : accepted("PROJECT_RUNTIME_STOPPED");
  }
  async function open(instanceId: string): Promise<ProjectRuntimeOpenResult> {
    const record = records.get(instanceId);
    if (record === undefined || record.lifecycle !== "RUNNING" || record.origin === null)
      return refused("PROJECT_RUNTIME_NOT_RUNNING");
    return Object.freeze({ code: "PROJECT_RUNTIME_OPENED", layer: PROJECT_RUNTIME_SUPERVISOR_LAYER,
      ok: true as const, origin: record.origin });
  }
  async function approvePairing(
    instanceId: string,
    confirmationLabel: string,
  ): Promise<ProjectRuntimeActionResult> {
    const record = records.get(instanceId);
    if (record === undefined || record.lifecycle !== "RUNNING" || record.session === null)
      return refused("PROJECT_RUNTIME_NOT_RUNNING");
    if (!CONFIRMATION_LABEL.test(confirmationLabel))
      return refused("PROJECT_RUNTIME_PAIRING_LABEL_INVALID");
    if (record.operation !== null || record.session.hasPendingApproval())
      return refused("PROJECT_RUNTIME_OPERATION_ACTIVE");
    record.operation = "APPROVE";
    const approval = await boundedRuntimePromise(
      record.session.approvePairing(confirmationLabel), timeoutMs,
    );
    record.operation = null;
    if (approval.kind === "REJECTED") {
      compromise(record);
      return refused("PROJECT_RUNTIME_BOUNDARY_REFUSED");
    }
    if (approval.kind === "TIMEOUT") {
      const failure = refused(PROJECT_RUNTIME_PROTOCOL_VIOLATION);
      record.session.abort(failure);
      return refused("PROJECT_RUNTIME_PAIRING_TIMEOUT");
    }
    return approval.value.ok ? accepted("PROJECT_RUNTIME_PAIRING_APPROVED") : approval.value;
  }
  async function shutdown(): Promise<ProjectRuntimeActionResult> {
    if (shutdownInProgress) return refused("PROJECT_RUNTIME_OPERATION_ACTIVE");
    shutdownInProgress = true;
    const targets = [...records.values()].filter((record) => record.active && record.boundary !== null);
    const closures = targets.map((record) => {
      record.lifecycle = "STOPPING"; record.operation = "STOP";
      record.stopRequested = true; record.teardownRequested = true;
      const boundary = record.boundary as ProjectRuntimeBoundary;
      try { boundary.cancel(); } catch { /* outcome stays unproven */ }
      try { return { promise: boundary.close(), record }; }
      catch { return { promise: Promise.resolve<ProjectRuntimeBoundaryOutcome>({ code:
        "PROJECT_RUNTIME_SHUTDOWN_UNPROVEN", layer: PROJECT_RUNTIME_SUPERVISOR_LAYER,
        truthClass: "UNKNOWN" }), record }; }
    });
    let allProven = true;
    await Promise.all(closures.map(async ({ promise, record }) => {
      const completion = await boundedRuntimePromise(promise.catch(() => ({
        code: "PROJECT_RUNTIME_SHUTDOWN_UNPROVEN", layer: PROJECT_RUNTIME_SUPERVISOR_LAYER,
        truthClass: "UNKNOWN" as const,
      })), timeoutMs);
      record.operation = null;
      if (completion.kind !== "VALUE") { record.lifecycle = "UNKNOWN"; allProven = false; return; }
      if (!await settleCompletion(record, completion.value)) allProven = false;
    }));
    shutdownInProgress = false;
    return allProven ? accepted("PROJECT_RUNTIME_SHUTDOWN") : refused("PROJECT_RUNTIME_SHUTDOWN_UNPROVEN");
  }
  async function wait(instanceId: string): Promise<ProjectRuntimeCompletionResult> {
    const record = records.get(instanceId);
    if (record === undefined) return refused("PROJECT_RUNTIME_INSTANCE_UNKNOWN");
    if (record.boundary === null) return refused("PROJECT_RUNTIME_NOT_RUNNING");
    let outcome: ProjectRuntimeBoundaryOutcome;
    try { outcome = await record.boundary.completed; }
    catch { return refused("PROJECT_RUNTIME_BOUNDARY_REFUSED"); }
    if (isUnknown(outcome)) return boundaryRefusal(outcome);
    return isProven(outcome) ? Object.freeze({ code: "PROJECT_RUNTIME_COMPLETED", exitCode: outcome.exitCode,
      layer: PROJECT_RUNTIME_SUPERVISOR_LAYER, ok: true as const }) : refused("PROJECT_RUNTIME_BOUNDARY_REFUSED");
  }
  function listedLifecycle(entry: ProjectCatalogEntry): ProjectRuntimeLifecycle {
    const record = records.get(entry.instanceId);
    return record === undefined ? "STOPPED" : record.entry.projectId === entry.projectId
      && record.storeKey === canonicalWindowsStoreKey(entry.storePath) ? record.lifecycle : "UNKNOWN";
  }
  return Object.freeze({
    list: (entries: readonly ProjectCatalogEntry[]): readonly ProjectRuntimeView[] => Object.freeze(
      entries.map((entry) => Object.freeze({ instanceId: entry.instanceId,
        lifecycle: listedLifecycle(entry), projectId: entry.projectId,
        root: entry.root, title: entry.title })),
    ),
    approvePairing, open, shutdown, start, stop, wait });
}

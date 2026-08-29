/**
 * Executable registration capture for runtime-provider hostile cases.
 *
 * In the security lane these wrappers are transparent aliases for Vitest's `describe` and
 * `it`. The completeness suite can instead load a slice in capture mode: reachable suite
 * declarations execute and yield their real callback as an inventory row, while no test is
 * registered or run. Comments, string literals and declarations inside functions that are
 * never called have no way to enter the inventory.
 */

import { describe as vitestDescribe, it as vitestIt } from "vitest";

export type RuntimeProviderArm = "AFTER" | "BEFORE" | "RACE";
export type RuntimeProviderCaseRun = () => void | Promise<void>;

export interface RuntimeProviderExecutableCase {
  readonly arm: RuntimeProviderArm;
  readonly boundary: string;
  readonly name: string;
  readonly run: RuntimeProviderCaseRun;
}

let captureActive = false;
let captured: RuntimeProviderExecutableCase[] = [];
const suiteStack: string[] = [];

const BOUNDARY_NAME = /^[A-Z][A-Z0-9_]+$/u;
const ARM_PREFIX = /^(AFTER|BEFORE|RACE)\b/u;

export function runtimeProviderInventoryCaptureActive(): boolean {
  return captureActive;
}

export function describeRuntimeProviderCases(name: string, body: () => void): void {
  if (!captureActive) {
    vitestDescribe(name, body);
    return;
  }
  suiteStack.push(name);
  try {
    body();
  } finally {
    suiteStack.pop();
  }
}

export function itRuntimeProviderCase(name: string, run: RuntimeProviderCaseRun): void {
  if (!captureActive) {
    vitestIt(name, run);
    return;
  }
  const boundary = [...suiteStack].reverse().find((entry) => BOUNDARY_NAME.test(entry));
  const arm = ARM_PREFIX.exec(name)?.[1] as RuntimeProviderArm | undefined;
  if (boundary === undefined || arm === undefined) return;
  captured.push(Object.freeze({ arm, boundary, name, run }));
}

/** Load modules once in inventory mode and return only registrations their top level reached. */
export async function captureRuntimeProviderCases(
  loaders: readonly (() => Promise<unknown>)[],
): Promise<readonly RuntimeProviderExecutableCase[]> {
  if (captureActive) throw new Error("runtime-provider inventory capture is not reentrant");
  captureActive = true;
  captured = [];
  suiteStack.length = 0;
  try {
    for (const load of loaders) await load();
    return Object.freeze(captured.map((entry) => Object.freeze({ ...entry })));
  } finally {
    captureActive = false;
    captured = [];
    suiteStack.length = 0;
  }
}

import type { JsonObject } from "@moe/contracts";

import type { BootstrapCommandKind, BootstrapRequest } from "./bootstrap-contracts.js";

/**
 * The durable command sequence and the payload accessors every service shares.
 *
 * Split out of `bootstrap-ledger.ts` to keep both files near the per-file target; this module
 * holds only data and total functions, and touches no store.
 */

/**
 * Each kind names the kinds that must already hold a committed decision for this project
 * before it may run. This table is what DoD 1 rests on: a project reaches READY only when
 * register, bind and probe are themselves durably recorded, so no hand-edited state can
 * activate one.
 */
export const COMMAND_PREREQUISITES = Object.freeze({
  "approval.decide": Object.freeze(["plan.propose"]),
  "goal.create": Object.freeze(["project.activate"]),
  "plan.propose": Object.freeze(["goal.create"]),
  "policy.install": Object.freeze([]),
  "policy.validate": Object.freeze(["policy.install"]),
  "project.activate": Object.freeze([
    "project.register",
    "project.bind_repository",
    "provider.probe",
  ]),
  "project.bind_repository": Object.freeze(["project.register"]),
  "project.register": Object.freeze([]),
  "provider.probe": Object.freeze(["project.register"]),
} as const satisfies Readonly<Record<BootstrapCommandKind, readonly BootstrapCommandKind[]>>);

/**
 * Aggregate stream per kind.
 *
 * Probe and policy get streams of their own so their events never bump the project's version
 * out from under `reduceProject`'s expected-version check.
 */
export function aggregateIdFor(request: BootstrapRequest, subject: string | null): string {
  switch (request.kind) {
    case "project.register":
    case "project.bind_repository":
    case "project.activate":
      return request.projectId;
    case "provider.probe":
      return `${request.projectId}-provider`;
    case "policy.install":
    case "policy.validate":
      return `${request.projectId}-policy`;
    default:
      return subject ?? request.projectId;
  }
}

export function payloadRef(payload: JsonObject, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function payloadObject(payload: JsonObject, key: string): JsonObject | null {
  const value = payload[key];
  if (value === null || value === undefined || typeof value !== "object") return null;
  if (Array.isArray(value)) return null;
  return value as JsonObject;
}

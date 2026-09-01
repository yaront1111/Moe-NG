/**
 * Produces the launcher's three runtime fields without reading a dispatch request.
 *
 * `quotedObservation` is the strict durable reader's answer. `installedRoot` is the parent of
 * the unique canonical EXECUTABLE path in that answer, using the runner's own unconditional
 * `win32.dirname` rule. `win32` accepts both slash styles, so switching on the observed platform
 * would be a second, drifting derivation. The closure path came from `entry.canonicalPath`, while
 * discovery originally computed its root before realpath; this module intentionally answers the
 * canonical root, which may not be byte-identical to the originally discovered spelling.
 *
 * `pinRoot` is daemon-process configuration. It is passed in, never derived from cwd, a
 * repository root, or a literal default. It must be absolute: accepting a relative configured
 * value would still bind it to the daemon's cwd at use time and recreate the forbidden default
 * indirectly. Missing or relative configuration refuses rather than acquiring weaker authority.
 */

import { win32 } from "node:path";

import type { ProjectConfigurationStore } from
  "../configuration/project-configuration-selection.js";
import { readCurrentRuntimeObservation, type ProviderRuntimeObservationUnknown } from
  "../provider-profile/provider-runtime-observation-reader.js";
import type { ProviderRuntimeObservation } from
  "../provider-profile/provider-runtime-observation.js";

/** The process-level configuration key this host-scoped runtime artifact reads. */
export const LAUNCH_RUNTIME_PIN_ROOT_ENV_KEY = "MOE_RUNTIME_PIN_ROOT";

export const LAUNCH_RUNTIME_SECTION_CODES = Object.freeze([
  "LAUNCH_RUNTIME_INPUT_INEXACT",
  "LAUNCH_RUNTIME_INSTALLED_ROOT_ABSENT",
  "LAUNCH_RUNTIME_INSTALLED_ROOT_AMBIGUOUS",
  "LAUNCH_RUNTIME_INSTALLED_ROOT_INVALID",
  "LAUNCH_RUNTIME_PIN_ROOT_UNCONFIGURED",
  "LAUNCH_RUNTIME_PIN_ROOT_INVALID",
] as const);

/** Module-private by design; exported boundary rosters key off column-zero layer constants. */
const SECTION_LAYER = "LAUNCH_RUNTIME_SECTION";

export type LaunchRuntimeSectionCode = (typeof LAUNCH_RUNTIME_SECTION_CODES)[number];
export type LaunchRuntimeSectionLayer = typeof SECTION_LAYER;

export interface LaunchRuntimeSection {
  readonly installedRoot: string; readonly pinRoot: string;
  readonly quotedObservation: ProviderRuntimeObservation;
}

export interface LaunchRuntimeSectionAccepted {
  readonly ok: true; readonly runtime: LaunchRuntimeSection;
}

export interface LaunchRuntimeSectionRefused {
  readonly authority: "NONE"; readonly code: LaunchRuntimeSectionCode;
  readonly detail: string; readonly layer: LaunchRuntimeSectionLayer; readonly ok: false;
  readonly outcome: "UNKNOWN"; readonly upstream: null;
}

export type LaunchRuntimeSectionResult =
  | LaunchRuntimeSectionAccepted
  | LaunchRuntimeSectionRefused
  | ProviderRuntimeObservationUnknown;

const INPUT_KEYS = Object.freeze([
  "pinRoot", "profileRevisionId", "projectId", "store",
] as const);
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/u;
const UNC_ABSOLUTE = /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u;
const FORWARD_UNC_ABSOLUTE = /^\/\/[^/]+\/[^/]+(?:\/|$)/u;

interface InputSnapshot {
  readonly pinRoot: unknown; readonly profileRevisionId: unknown;
  readonly projectId: unknown; readonly store: unknown;
}

function refuse(
  code: LaunchRuntimeSectionCode,
  detail: string,
): LaunchRuntimeSectionRefused {
  return Object.freeze({
    authority: "NONE" as const, code, detail, layer: SECTION_LAYER,
    ok: false as const, outcome: "UNKNOWN" as const, upstream: null,
  });
}

/** Exact means every own key and data descriptor, including symbols and hidden properties. */
function snapshotInput(value: unknown): InputSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== INPUT_KEYS.length
      || keys.some((key) => typeof key !== "string"
        || !(INPUT_KEYS as readonly string[]).includes(key))) return null;
    const slots: Record<string, unknown> = {};
    for (const key of INPUT_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
        return null;
      }
      slots[key] = descriptor.value;
    }
    return { pinRoot: slots["pinRoot"], profileRevisionId: slots["profileRevisionId"],
      projectId: slots["projectId"], store: slots["store"] };
  } catch {
    return null;
  }
}

function isQualifiedAbsolutePath(value: string): boolean {
  if (value.includes("\u0000") || !win32.isAbsolute(value)) return false;
  if (DRIVE_ABSOLUTE.test(value) || UNC_ABSOLUTE.test(value)) return true;
  if (FORWARD_UNC_ABSOLUTE.test(value)) return true;
  return value.startsWith("/") && !value.startsWith("//");
}

function snapshotObservation(
  observation: ProviderRuntimeObservation,
): ProviderRuntimeObservation {
  const resolvedRuntimeClosure = Object.freeze(observation.resolvedRuntimeClosure.map(
    (entry) => Object.freeze({ ...entry }),
  ));
  return Object.freeze({
    ...observation,
    freshness: Object.freeze({ ...observation.freshness }),
    platformIdentity: Object.freeze({ ...observation.platformIdentity }),
    resolvedRuntimeClosure,
  });
}

function compose(input: unknown): LaunchRuntimeSectionResult {
  const snapshot = snapshotInput(input);
  if (snapshot === null) {
    return refuse("LAUNCH_RUNTIME_INPUT_INEXACT", "producer input is not the exact config read");
  }
  const { profileRevisionId, projectId, store } = snapshot;
  if (typeof projectId !== "string" || projectId.length === 0
    || typeof profileRevisionId !== "string" || profileRevisionId.length === 0
    || typeof store !== "object" || store === null || Array.isArray(store)) {
    return refuse("LAUNCH_RUNTIME_INPUT_INEXACT", "producer input carries no readable identity");
  }
  const read = readCurrentRuntimeObservation(store as unknown as ProjectConfigurationStore,
    projectId, profileRevisionId);
  if (!read.ok) return read;
  const executables = read.observation.resolvedRuntimeClosure.filter(
    (entry) => entry.kind === "EXECUTABLE",
  );
  if (executables.length === 0) {
    return refuse("LAUNCH_RUNTIME_INSTALLED_ROOT_ABSENT", "no executable is observed");
  }
  if (executables.length !== 1) {
    return refuse("LAUNCH_RUNTIME_INSTALLED_ROOT_AMBIGUOUS", "observation names many executables");
  }
  const installedRoot = win32.dirname(executables[0]!.path);
  if (!isQualifiedAbsolutePath(installedRoot)) {
    return refuse("LAUNCH_RUNTIME_INSTALLED_ROOT_INVALID", "executable has no absolute parent");
  }
  const pinRoot = snapshot.pinRoot;
  if (typeof pinRoot !== "string" || pinRoot.length === 0) {
    return refuse("LAUNCH_RUNTIME_PIN_ROOT_UNCONFIGURED", "runtime pin root is not configured");
  }
  if (!isQualifiedAbsolutePath(pinRoot)) {
    return refuse("LAUNCH_RUNTIME_PIN_ROOT_INVALID", "runtime pin root is not absolute");
  }
  const runtime = Object.freeze({
    installedRoot,
    pinRoot,
    quotedObservation: snapshotObservation(read.observation),
  });
  return Object.freeze({ ok: true as const, runtime });
}

export function produceLaunchRuntimeSection(input: unknown): LaunchRuntimeSectionResult {
  try {
    return compose(input);
  } catch {
    return refuse("LAUNCH_RUNTIME_INPUT_INEXACT", "producer input could not be read safely");
  }
}

import { join } from "node:path";

import { isDiagnosticLevel } from "@moe/contracts";
import type { DiagnosticLevel } from "@moe/contracts";

/**
 * THE DIAGNOSTIC KNOBS, parsed strictly and refused BY NAME.
 *
 * Same discipline as `wrapper-knobs.ts`, for the same reason: a typo that silently falls back to
 * a default is how an operator ends up believing they raised the log level while the daemon kept
 * writing nothing. A knob this file cannot understand is a start-time refusal naming the
 * variable, not a guess.
 *
 * The one asymmetry is deliberate. `MOE_LOG=off` disables the FILE plane only; the console plane
 * keeps its own knob. Turning off the durable half must never also turn off the half the
 * operator is watching in their terminal.
 */

export const DIAGNOSTIC_ENV_INVALID = "DIAGNOSTIC_ENV_INVALID" as const;

export interface DiagnosticSettings {
  /** Null silences the console plane entirely. */
  readonly consoleLevel: DiagnosticLevel | null;
  readonly directory: string;
  /** False writes no file; the console plane is independent. */
  readonly enabled: boolean;
  readonly generations: number;
  readonly level: DiagnosticLevel;
  readonly maxBytes: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULT_MAX_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_GENERATIONS = 5;
/** Below this a rotation happens more often than a record is written. */
const MIN_MAX_BYTES = 1_024;
const OFF = new Set(["0", "off", "false", "no"]);

function integer(env: Environment, name: string, fallback: number, minimum: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || !/^\d+$/u.test(raw.trim())) {
    throw new Error(`${DIAGNOSTIC_ENV_INVALID}: ${name} must be an integer >= ${String(minimum)}`);
  }
  return parsed;
}

function level(env: Environment, name: string, fallback: DiagnosticLevel): DiagnosticLevel {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const candidate = raw.trim().toLowerCase();
  if (!isDiagnosticLevel(candidate)) {
    throw new Error(`${DIAGNOSTIC_ENV_INVALID}: ${name} must be debug, info, warn, or error`);
  }
  return candidate;
}

export function readDiagnosticSettings(env: Environment, projectRoot: string): DiagnosticSettings {
  const consoleRaw = (env["MOE_LOG_CONSOLE"] ?? "").trim().toLowerCase();
  const enabledRaw = (env["MOE_LOG"] ?? "").trim().toLowerCase();
  const directory = env["MOE_LOG_DIR"];
  return Object.freeze({
    consoleLevel: OFF.has(consoleRaw) ? null : level(env, "MOE_LOG_CONSOLE", "warn"),
    // Beside the durable state the daemon already owns, not in a temp directory: an operator
    // asked for the logs of THIS project finds them where the project's own state lives.
    directory: directory === undefined || directory === ""
      ? join(projectRoot, ".moe", "logs")
      : directory,
    enabled: !OFF.has(enabledRaw),
    generations: integer(env, "MOE_LOG_GENERATIONS", DEFAULT_GENERATIONS, 0),
    level: level(env, "MOE_LOG_LEVEL", "info"),
    maxBytes: integer(env, "MOE_LOG_MAX_BYTES", DEFAULT_MAX_BYTES, MIN_MAX_BYTES),
  });
}

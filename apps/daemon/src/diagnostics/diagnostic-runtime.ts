import {
  NULL_DIAGNOSTIC_SINK, createDiagnosticEmitter, fanOutDiagnostics, filterDiagnostics,
} from "@moe/contracts";
import type { DiagnosticEmitter, DiagnosticSink, DiagnosticThrown } from "@moe/contracts";

import { createDiagnosticConsoleSink } from "./diagnostic-console-sink.js";
import { createDiagnosticFileSink } from "./diagnostic-file-sink.js";
import { readDiagnosticSettings } from "./diagnostic-settings.js";

/**
 * THE ONE PLACE A PROCESS BUILDS ITS DIAGNOSTIC PLANE, so every entry — the daemon, the wrapper,
 * the MCP hosts, the CLI — observes the same knobs and writes the same two planes.
 *
 * TWO PLANES, INDEPENDENTLY GATED. The file plane keeps everything at the configured level for
 * the operator who comes back after the failure; the console plane keeps only what is worth
 * interrupting someone who is watching. They fan out from one emit so a call site never chooses.
 *
 * The knobs are read HERE, at construction, so a malformed one refuses by name before the
 * process starts doing work — the same contract `readWrapperKnobs` holds.
 *
 * WHEN THE FILE PLANE DIES, THE OPERATOR HEARS ABOUT IT. A sink that cannot write reports itself
 * once, through the console plane, with the errno code that says whether the disk is full, the
 * path is not a directory, or the volume went read-only. Silence about silence is the defect
 * this module exists to end.
 */

export interface DiagnosticRuntime {
  close(): void;
  emitterFor(component: string): DiagnosticEmitter;
  /** The raw sink, for a boundary that already holds its own emitter. */
  readonly sink: DiagnosticSink;
}

export interface DiagnosticRuntimeOptions {
  /** INJECTED instant source; defaults to wall time. */
  readonly clock?: () => string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly projectRoot: string;
  /** Literal secret values scrubbed from both planes. */
  readonly secrets?: readonly string[];
  /** The console stream; defaults to stderr, which stays readable when stdout is piped. */
  readonly write?: (line: string) => void;
}

/** A runtime that keeps nothing: the default wherever a caller composes no diagnostics. */
export function nullDiagnosticRuntime(): DiagnosticRuntime {
  const emitter = createDiagnosticEmitter({
    clock: () => "", component: "null", sink: NULL_DIAGNOSTIC_SINK,
  });
  return Object.freeze({
    close: (): void => undefined,
    emitterFor: (): DiagnosticEmitter => emitter,
    sink: NULL_DIAGNOSTIC_SINK,
  });
}

export function createDiagnosticRuntime(options: DiagnosticRuntimeOptions): DiagnosticRuntime {
  const settings = readDiagnosticSettings(options.env, options.projectRoot);
  const clock = options.clock ?? ((): string => new Date().toISOString());
  const secrets = options.secrets ?? [];
  const write = options.write ?? ((line: string): void => { process.stderr.write(line); });

  const console = settings.consoleLevel === null
    ? null
    : createDiagnosticConsoleSink({ secrets, write });

  /** The sink's own death, announced on the plane that is still alive. */
  const announce = (reason: string, thrown: DiagnosticThrown): void => {
    console?.emit({
      at: clock(), component: "diagnostics", event: reason, level: "error", thrown,
    });
  };

  const file = settings.enabled
    ? createDiagnosticFileSink({
      directory: settings.directory,
      generations: settings.generations,
      maxBytes: settings.maxBytes,
      onFailure: announce,
      secrets,
    })
    : null;

  const planes: DiagnosticSink[] = [];
  if (file !== null) planes.push(filterDiagnostics(settings.level, file));
  if (console !== null && settings.consoleLevel !== null) {
    planes.push(filterDiagnostics(settings.consoleLevel, console));
  }
  const sink = fanOutDiagnostics(planes);

  return Object.freeze({
    close: (): void => { file?.close(); },
    emitterFor: (component: string): DiagnosticEmitter =>
      createDiagnosticEmitter({ clock, component, sink }),
    sink,
  });
}

const shared = new Map<string, DiagnosticRuntime>();

/**
 * ONE runtime per project root per process. The daemon bin builds a runtime to tee its console,
 * and the shipped dependency provider — loaded by module path, handed no arguments — needs an
 * emitter for the command ports it composes. Two runtimes over the same `.moe/logs` would be two
 * file sinks rotating one file, so both ask here and the second gets the first's instance. Never
 * evicted: a composition root closes it on the way out of the process and nothing else.
 */
export function sharedDiagnosticRuntime(options: DiagnosticRuntimeOptions): DiagnosticRuntime {
  const existing = shared.get(options.projectRoot);
  if (existing !== undefined) return existing;
  const created = createDiagnosticRuntime(options);
  shared.set(options.projectRoot, created);
  return created;
}

import { admitsDiagnosticLevel } from "./diagnostic-level.js";
import type { DiagnosticLevel } from "./diagnostic-level.js";
import { describeThrown } from "./diagnostic-error.js";
import type { DiagnosticFields, DiagnosticRecord } from "./diagnostic-record.js";

/**
 * THE DIAGNOSTIC PORT, and the ergonomics every call site sees.
 *
 * A sink is one method. That is the whole contract, so a package can accept one without gaining
 * a dependency on a file, a clock, a format, or this repository's process model — which is what
 * lets `store`, `runner` and `contracts` emit at all under the rule that dependencies flow
 * toward contracts.
 *
 * THE LOGGER NEVER TAKES DOWN THE CALLER. Every boundary below is total: a sink that throws, a
 * clock that throws, a fan-out member that throws. This is not defensive habit — an emit sits
 * inside a catch block on a failure path, and a throwing logger there would replace a handled
 * fault with an unhandled one, which is precisely the shape that tree-killed a live fleet on
 * 2026-09-13. A diagnostic carries no authority, so losing one is a lost line and nothing more.
 */

export interface DiagnosticSink {
  emit(record: DiagnosticRecord): void;
}

/** Accepts everything, keeps nothing. The default wherever no sink was supplied. */
export const NULL_DIAGNOSTIC_SINK: DiagnosticSink = Object.freeze({
  emit: (): void => undefined,
});

export function filterDiagnostics(threshold: string, sink: DiagnosticSink): DiagnosticSink {
  return Object.freeze({
    emit: (record: DiagnosticRecord): void => {
      if (admitsDiagnosticLevel(threshold, record.level)) sink.emit(record);
    },
  });
}

/**
 * One record to several sinks — the file and the operator's console, typically.
 *
 * A member that throws is skipped and the rest still receive the record: a full disk must not
 * cost the operator the line on their terminal.
 */
export function fanOutDiagnostics(sinks: readonly DiagnosticSink[]): DiagnosticSink {
  const members = Object.freeze([...sinks]);
  return Object.freeze({
    emit: (record: DiagnosticRecord): void => {
      for (const sink of members) {
        try {
          sink.emit(record);
        } catch {
          // A broken sink is not the caller's problem and has no second place to be reported:
          // reporting it through the fan-out would be the same broken sink again.
        }
      }
    },
  });
}

export interface DiagnosticDetail {
  readonly correlation?: string;
  /** The raw caught value. Described by `describeThrown`; call sites never unwrap it. */
  readonly error?: unknown;
  readonly fields?: DiagnosticFields;
}

export interface DiagnosticEmitter {
  debug(event: string, detail?: DiagnosticDetail): void;
  error(event: string, detail?: DiagnosticDetail): void;
  info(event: string, detail?: DiagnosticDetail): void;
  warn(event: string, detail?: DiagnosticDetail): void;
  /** A view that stamps `correlation` on every record, for one session, run, or request. */
  forCorrelation(correlation: string): DiagnosticEmitter;
}

export interface DiagnosticEmitterOptions {
  /** INJECTED. This module holds no clock, so a test never depends on wall time. */
  readonly clock: () => string;
  readonly component: string;
  readonly correlation?: string;
  readonly sink: DiagnosticSink;
}

export function createDiagnosticEmitter(options: DiagnosticEmitterOptions): DiagnosticEmitter {
  const { clock, component, sink } = options;

  const emit = (level: DiagnosticLevel, event: string, detail?: DiagnosticDetail): void => {
    try {
      const correlation = detail?.correlation ?? options.correlation;
      sink.emit(Object.freeze({
        at: clock(),
        component,
        event,
        level,
        ...(correlation === undefined ? {} : { correlation }),
        ...(detail?.fields === undefined ? {} : { fields: detail.fields }),
        ...(detail === undefined || !("error" in detail)
          ? {}
          : { thrown: describeThrown(detail.error) }),
      }));
    } catch {
      // The emit path is total by contract. There is nowhere left to report a failure of the
      // reporting itself, and a throw here would escape into a caller's catch block.
    }
  };

  const at = (level: DiagnosticLevel) =>
    (event: string, detail?: DiagnosticDetail): void => { emit(level, event, detail); };

  return Object.freeze<DiagnosticEmitter>({
    debug: at("debug"),
    error: at("error"),
    forCorrelation: (correlation: string): DiagnosticEmitter =>
      createDiagnosticEmitter({ ...options, correlation }),
    info: at("info"),
    warn: at("warn"),
  });
}

import { DIAGNOSTIC_REDACTED } from "@moe/contracts";
import type { DiagnosticRecord, DiagnosticSink } from "@moe/contracts";

/**
 * THE HUMAN HALF OF THE DIAGNOSTIC PLANE: one compact line, on the stream the operator is
 * already watching.
 *
 * Not JSON. The file plane is for `grep` and for a program; this plane is for the person who
 * started `moe up` and is looking at a terminal, and a 400-column JSON object there hides the
 * one word that matters. The shape is the wrapper's own existing convention — a bracketed tag,
 * then the fact — so these lines sit beside `[wrapper] ...` without looking foreign.
 *
 * ONE LINE, ALWAYS. Every value is flattened, so a field carrying an embedded newline cannot
 * forge a second line on a console an operator is reading as a sequence of events.
 */

export interface DiagnosticConsoleSinkOptions {
  readonly secrets?: readonly string[];
  readonly write: (line: string) => void;
}

/** Longest first: a secret contained in a longer one must not leave the longer one's tail. */
function ordered(secrets: readonly string[]): readonly string[] {
  return [...new Set(secrets.filter((secret) => secret !== ""))]
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function flatten(text: string): string {
  // Every control character, not just \n: \r alone rewrites the line in place on a terminal.
  return text.replaceAll(/[\p{Cc}\p{Cf}]/gu, " ").trim();
}

/** The wall-clock part of an ISO instant. The date is in the file; the console is for now. */
function timeOf(at: string): string {
  const time = /T(?<time>\d{2}:\d{2}:\d{2}\.\d{3})/u.exec(at)?.groups?.["time"];
  return time ?? at;
}

export function createDiagnosticConsoleSink(
  options: DiagnosticConsoleSinkOptions,
): DiagnosticSink {
  const secrets = ordered(options.secrets ?? []);
  const scrub = (text: string): string =>
    secrets.reduce((carry, secret) => carry.replaceAll(secret, DIAGNOSTIC_REDACTED), text);

  return Object.freeze({
    emit: (record: DiagnosticRecord): void => {
      try {
        const parts = [
          `[${timeOf(record.at)}]`,
          record.level.toUpperCase(),
          record.component,
          record.event,
        ];
        if (record.correlation !== undefined) parts.push(scrub(flatten(record.correlation)));
        for (const [name, value] of Object.entries(record.fields ?? {})) {
          parts.push(`${name}=${scrub(flatten(String(value)))}`);
        }
        if (record.thrown !== undefined) {
          const { code, message, name } = record.thrown;
          parts.push(code === null ? `${name}:` : `${scrub(code)}:`);
          parts.push(scrub(flatten(message)));
        }
        options.write(`${parts.filter((part) => part !== "").join(" ")}\n`);
      } catch {
        // A console that refuses its own write (EPIPE on a closed pipe is the ordinary case)
        // cannot be told about it through that same console.
      }
    },
  });
}

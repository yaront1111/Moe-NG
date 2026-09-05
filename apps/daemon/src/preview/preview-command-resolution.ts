import { previewRefusal } from "./preview-contracts.js";
import type { PreviewRefusal } from "./preview-contracts.js";

/**
 * WHAT COMMAND STARTS THIS PRODUCT, and where its journeys live.
 *
 * Pure: it reads no file and spawns nothing. The caller hands it the contract's requirement
 * statements and the workspace's `package.json` scripts; it answers with a command, a port and
 * one entry path per journey, or a refusal.
 *
 * THE FALLBACK ORDER IS `preview` -> `dev` -> `start`, and the order is the point. All three
 * usually exist in a real product, and they mean different things: `preview` serves a BUILT
 * artifact, `dev` serves a hot-reloading one, `start` may serve production and may block on
 * configuration the operator does not have. Picking the wrong one shows the operator a picture
 * of something other than what was built. A test that only checked "a command was spawned"
 * would pass on any of the six orderings, so `preview-runner.test.ts` gives a fixture workspace
 * TWO of the three and asserts WHICH ran, for all three pairings.
 *
 * WHY THE CONTRACT WINS OVER THE SCRIPTS. The scripts are a convention; the approved contract is
 * the product's own statement of how it is served. A product that says so explicitly is taken at
 * its word, and the script scan is only what happens when it does not.
 *
 * HOW A CONTRACT SAYS IT. `ProductContractV2Requirement.statement` is free prose — the shape
 * carries no port field and no command field (product-contract-v2-contract.ts:95-100), and
 * `ProductContractV2Journey` carries no URL either (:89-93). So a contract states preview facts
 * with an explicit one-line DIRECTIVE inside a statement, and anything else in the prose is
 * ignored:
 *
 *     preview command: pnpm run serve:built
 *     preview port: 4173
 *     preview path: /checkout            (in a JOURNEY's statement, defaulting to "/")
 *
 * The directive is deliberately narrow. Guessing a command out of English prose would let a
 * sentence like "must not be previewed with the dev server" start the dev server, so an
 * unrecognised statement contributes NOTHING rather than a best guess.
 */

/** The scripts a workspace may serve a preview with, in the order they are preferred. */
export const PREVIEW_SCRIPT_ORDER = Object.freeze(["preview", "dev", "start"] as const);

/** A directive line inside a requirement or journey statement. Anchored per line, not global. */
const DIRECTIVE = /^[ \t]*preview[ \t]+(command|path|port)[ \t]*:[ \t]*(\S.*?)[ \t]*$/imu;

/** Ports an operator's machine will actually bind. 0 is "pick one" and cannot be navigated to. */
const MIN_PORT = 1;
const MAX_PORT = 65_535;

export interface PreviewJourneyEntry {
  readonly journeyRef: string;
  /** Always begins with "/" — the path the browser opens against the detected origin. */
  readonly path: string;
}

export interface PreviewContractFacts {
  /** Every deployment requirement's statement, in contract order. */
  readonly deploymentStatements: readonly string[];
  /** One entry per journey: its id and its own statement. */
  readonly journeys: readonly { readonly journeyId: string; readonly statement: string }[];
}

export interface PreviewCommandPlan {
  /** The shell command line that serves the product. */
  readonly command: string;
  readonly journeys: readonly PreviewJourneyEntry[];
  /** Stated by the contract; null means "detect it from the child's stdout". */
  readonly port: number | null;
  /** Where the command came from, so a run can say why it chose what it chose. */
  readonly source: "CONTRACT" | `SCRIPT:${string}`;
}

export type PreviewCommandResolution =
  | Readonly<{ readonly ok: true; readonly plan: PreviewCommandPlan }>
  | PreviewRefusal;

function directive(statement: string, key: "command" | "path" | "port"): string | null {
  for (const line of statement.split(/\r?\n/u)) {
    const found = DIRECTIVE.exec(line);
    if (found !== null && found[1]?.toLowerCase() === key && found[2] !== undefined) {
      return found[2];
    }
  }
  return null;
}

/** The FIRST stated value across the statements, so contract order decides a disagreement. */
function firstDirective(
  statements: readonly string[], key: "command" | "path" | "port",
): string | null {
  for (const statement of statements) {
    const value = directive(statement, key);
    if (value !== null) return value;
  }
  return null;
}

/** A stated port only counts when it is a port. Anything else falls back to stdout detection. */
function statedPort(statements: readonly string[]): number | null {
  const raw = firstDirective(statements, "port");
  if (raw === null || !/^\d{1,5}$/u.test(raw)) return null;
  const port = Number(raw);
  return port >= MIN_PORT && port <= MAX_PORT ? port : null;
}

/**
 * One entry per journey. A journey that states no path opens the root, because a product with a
 * single screen should not have to say so, and a missing directive is not an error.
 */
function journeyEntries(facts: PreviewContractFacts): readonly PreviewJourneyEntry[] {
  return facts.journeys.map((journey) => {
    const stated = directive(journey.statement, "path");
    const path = stated !== null && stated.startsWith("/") && !stated.includes("..")
      ? stated
      : "/";
    return { journeyRef: journey.journeyId, path };
  });
}

/**
 * The command that serves this product, or PREVIEW_COMMAND_MISSING @ RUNNER when neither the
 * contract nor the workspace names one.
 *
 * `scripts` is the workspace `package.json`'s own `scripts` record. A script present but EMPTY
 * is treated as absent: `"dev": ""` runs nothing, and silently spawning an empty command line
 * would surface as a start timeout twenty-nine minutes later instead of a refusal now.
 */
export function resolvePreviewCommand(
  facts: PreviewContractFacts | null,
  scripts: Readonly<Record<string, unknown>> | null,
  runScript: (script: string) => string,
): PreviewCommandResolution {
  const journeys = facts === null ? [] : journeyEntries(facts);
  const statements = facts?.deploymentStatements ?? [];
  const stated = firstDirective(statements, "command");
  if (stated !== null) {
    return { ok: true, plan: { command: stated, journeys, port: statedPort(statements), source: "CONTRACT" } };
  }
  for (const name of PREVIEW_SCRIPT_ORDER) {
    const script = scripts?.[name];
    if (typeof script !== "string" || script.trim() === "") continue;
    return {
      ok: true,
      plan: { command: runScript(name), journeys, port: statedPort(statements), source: `SCRIPT:${name}` },
    };
  }
  return previewRefusal("PREVIEW_COMMAND_MISSING");
}

/**
 * The port a dev server announced on stdout, or null while it has announced nothing.
 *
 * Matched against the ORIGIN a server prints rather than any number in its output: a build tool
 * printing "compiled 42 modules in 1200ms" must not be read as port 42, and reading a wrong port
 * would drive the browser at whatever else is listening there. So the pattern demands an
 * http(s) origin with an explicit port, which is what Vite, Next, Astro and `http-server` all
 * print.
 */
export function detectPreviewPort(output: string): { origin: string; port: number } | null {
  const found = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{1,5})\b/giu.exec(output);
  const raw = found?.[1];
  if (found === undefined || found === null || raw === undefined) return null;
  const port = Number(raw);
  if (port < MIN_PORT || port > MAX_PORT) return null;
  // 0.0.0.0 is a BIND address, never a connect address: navigating to it fails on Windows.
  return { origin: `http://127.0.0.1:${String(port)}`, port };
}

/** The origin a stated port is served on. Same loopback rule as the detected one. */
export function previewOrigin(port: number): string {
  return `http://127.0.0.1:${String(port)}`;
}

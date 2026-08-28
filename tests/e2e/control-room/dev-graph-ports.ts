import { join } from "node:path";

import { freePort, killTree, spawnNode } from "./daemon-children.js";
import { repoRoot, serverEnv } from "./daemon-scratch.js";

const READY_BUDGET_MS = 60_000;
const TRANSCRIPT_TAIL_CHARS = 4_000;
const VITE_ORIGIN = /Local:\s+(http:\/\/localhost:\d+)/u;

export const DEV_GRAPH_ERROR_CODES = Object.freeze([
  "E2E_REPO_ROOT_UNRESOLVED",
  "E2E_DEV_SERVER_PORT_UNAVAILABLE",
  "E2E_DEV_SERVER_SPAWN_FAILED",
  "E2E_DEV_SERVER_READY_TIMEOUT",
  "E2E_DEV_SERVER_ORIGIN_MISMATCH",
] as const);

export type DevGraphErrorCode = (typeof DEV_GRAPH_ERROR_CODES)[number];

interface LaneSucceeded<T> {
  readonly ok: true;
  readonly value: T;
}

interface LaneRefused {
  readonly code: DevGraphErrorCode;
  readonly detail: string;
  readonly ok: false;
}

export type LaneOutcome<T> = LaneSucceeded<T> | LaneRefused;

function refused(code: DevGraphErrorCode, detail: string): LaneRefused {
  return Object.freeze({ code, detail, ok: false as const });
}

function transcriptTail(transcript: string): string {
  return transcript.slice(-TRANSCRIPT_TAIL_CHARS);
}

/**
 * Runs `body` against a live Vite dev server for the control room.
 *
 * `serverTranscript` surfaces the output this lane already accumulates for the
 * two refusal details. A Node builtin leaking into the client graph reaches the
 * browser only as `Cannot access "node:crypto.createHash"`, which names the
 * builtin but not the module that imported it. Vite relays that same error back
 * over its client channel and logs it WITH the source frame, so the server
 * transcript is the only place the offending file is named.
 * Read-only accessor over existing state; it does not change the lifecycle.
 */
export async function withDevGraphControlRoom<T>(
  body: (baseUrl: string, serverTranscript: () => string) => Promise<T>,
): Promise<LaneOutcome<T>> {
  const root = repoRoot();
  if (root === null) {
    return refused("E2E_REPO_ROOT_UNRESOLVED", "package.json and pnpm-workspace.yaml not found");
  }

  let port: number;
  try {
    port = await freePort();
  } catch (error: unknown) {
    return refused("E2E_DEV_SERVER_PORT_UNAVAILABLE", String(error));
  }

  const expectedOrigin = `http://localhost:${String(port)}`;
  let server: ReturnType<typeof spawnNode>;
  try {
    server = spawnNode([
      join(root, "apps", "control-room", "node_modules", "vite", "bin", "vite.js"),
      "--port",
      String(port),
      "--strictPort",
    ], join(root, "apps", "control-room"), serverEnv("http://127.0.0.1:1", "ABSENT"));
  } catch (error: unknown) {
    return refused("E2E_DEV_SERVER_SPAWN_FAILED", String(error));
  }

  try {
    const announcedOrigin = await server.waitFor(VITE_ORIGIN, READY_BUDGET_MS);
    if (announcedOrigin === null) {
      return refused(
        "E2E_DEV_SERVER_READY_TIMEOUT",
        transcriptTail(server.transcript()),
      );
    }
    if (announcedOrigin !== expectedOrigin) {
      return refused(
        "E2E_DEV_SERVER_ORIGIN_MISMATCH",
        `expected ${expectedOrigin}, announced ${announcedOrigin}\n${transcriptTail(server.transcript())}`,
      );
    }
    return Object.freeze({
      ok: true as const,
      value: await body(expectedOrigin, server.transcript),
    });
  } finally {
    await killTree(server.child);
  }
}

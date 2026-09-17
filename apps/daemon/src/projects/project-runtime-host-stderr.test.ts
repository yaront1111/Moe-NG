import { PassThrough, Readable, Writable } from "node:stream";
import { expect, it } from "vitest";

import { createProjectRuntimeSupervisor } from "./project-runtime-supervisor.js";
import type {
  ProjectRuntimeBoundary, ProjectRuntimeBoundaryOutcome,
} from "./project-runtime-supervisor.js";
import type { ProjectCatalogEntry } from "./project-catalog.js";

/**
 * THE OBSERVER MUST ACTUALLY BE CALLED.
 *
 * `drainProjectRuntimeStderr` grew an observer and the supervisor grew an option, but a
 * capability with no reachable caller is indistinguishable from one that was never added. This
 * drives the composed supervisor and proves the host's stderr lines arrive with the entry they
 * belong to — and that with no observer the stream is still fully consumed, which is the drain's
 * original and load-bearing duty.
 */

const ENTRY: ProjectCatalogEntry = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  projectId: "project-1",
  root: "D:\\projexts\\demo",
  storePath: "D:\\projexts\\demo\\store.sqlite",
  title: "Demo",
} as unknown as ProjectCatalogEntry;

function boundary(stderr: Readable): ProjectRuntimeBoundary {
  const outcome = { exitCode: 0 } as unknown as ProjectRuntimeBoundaryOutcome;
  return {
    cancel: () => undefined,
    close: async () => outcome,
    completed: new Promise<ProjectRuntimeBoundaryOutcome>(() => undefined),
    providerStderr: stderr,
    providerStdin: new Writable({ write(_chunk, _encoding, done) { done(); } }),
    providerStdout: new PassThrough(),
    started: new Promise(() => undefined),
  };
}

const settle = (): Promise<void> =>
  new Promise<void>((resolve) => { setImmediate(resolve); });

it("delivers each host stderr line to the observer, with the entry it came from", async () => {
  const seen: { projectId: string; line: string }[] = [];
  const stderr = Readable.from([
    Buffer.from("STORE_DEPENDENCIES_ENV_MISSING: MOE_STORE_PATH, MOE_PROJECT_ID\n"),
    Buffer.from("    at readStoreDependencyEnv\n"),
  ]);
  const supervisor = createProjectRuntimeSupervisor({
    observeHostStderr: (entry, line) => { seen.push({ line, projectId: entry.projectId }); },
    openBoundary: () => boundary(stderr),
  });

  void supervisor.start(ENTRY);
  await settle();
  await settle();

  expect(seen.map((row) => row.line)).toEqual([
    "STORE_DEPENDENCIES_ENV_MISSING: MOE_STORE_PATH, MOE_PROJECT_ID",
    "    at readStoreDependencyEnv",
  ]);
  expect(seen.every((row) => row.projectId === "project-1")).toBe(true);
});

it("still consumes the stream whole when no observer is supplied", async () => {
  const stderr = Readable.from([Buffer.from("noise\n"), Buffer.from("more noise\n")]);
  const supervisor = createProjectRuntimeSupervisor({ openBoundary: () => boundary(stderr) });

  void supervisor.start(ENTRY);
  await settle();
  await settle();

  // Back-pressure on this pipe hangs the stack host, so full consumption is the drain's first
  // duty and the reason it existed at all.
  expect(stderr.readableEnded || stderr.destroyed).toBe(true);
});

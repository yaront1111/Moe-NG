import { expect, it } from "vitest";

import { resolveOptionalDaemonPorts } from "./daemon-entry-port-resolution.js";
import type { OptionalDaemonPortProvider } from "./daemon-entry-port-resolution.js";

/**
 * A refusal NAMES ITS SEAM. `{ failure: "INVALID" }` was one shape for thirty-four optional
 * factories and `{ failure: "THREW" }` one shape for as many calls; the daemon entry folded both
 * into a code, so an operator whose daemon refused to start read "dependencies invalid" and then
 * the whole provider module. Each refusal now carries the provider key it is about, and a throw
 * carries the throw.
 */

it("names the factory that is not callable, and the port that lacks a required method", () => {
  expect(resolveOptionalDaemonPorts({ subscriptions: 7 } as unknown as OptionalDaemonPortProvider))
    .toEqual({ failure: "INVALID", ok: false, port: "subscriptions" });
  expect(resolveOptionalDaemonPorts({ graph: () => ({}) as never }))
    .toEqual({ failure: "INVALID", ok: false, port: "graph" });
  expect(resolveOptionalDaemonPorts({ reconciliation: () => ({ sweep: "not a function" }) as never }))
    .toEqual({ failure: "INVALID", ok: false, port: "reconciliation" });
});

it("names the seam under a nested check too, where no factory identifier is in the condition", () => {
  // `sessionHandshake` is validated in two steps; the second reads a derived local.
  expect(resolveOptionalDaemonPorts({
    sessionHandshake: () => ({ boundProjectId: " ", mint: () => ({ code: "unused", ok: false }) }) as never,
  })).toEqual({ failure: "INVALID", ok: false, port: "sessionHandshake" });
});

it("names the factory that THREW and carries the throw itself, for the entry's log line", () => {
  const thrown = Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
  const result = resolveOptionalDaemonPorts({
    // A well-formed earlier seam resolves first, so the name below is the thrower, not "the first".
    affordances: () => ({ readSurface: () => ({}) }) as never,
    goalCatalog: () => { throw thrown; },
  });
  expect(result).toEqual({ failure: "THREW", ok: false, port: "goalCatalog", thrown });
});

it("still resolves a well-formed provider to the same ports, so naming changed no admission", () => {
  const graph = { boundProjectId: "project-bound", readCurrentActiveGraph: () => ({}) };
  expect(resolveOptionalDaemonPorts({ graph: () => graph as never }))
    .toEqual({ ok: true, ports: { graph } });
});

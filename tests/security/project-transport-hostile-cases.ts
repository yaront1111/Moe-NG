/** Hostile cases for the project-manager browser, HTTP and private IPC transports. */

import {
  PROJECT_MANAGER_LOCAL_LAYER,
  captureManagerPairingTicket,
} from "../../apps/control-room/src/v2/projects/project-manager-client.js";
import {
  PROJECT_MANAGER_HTTP_LAYER,
  decodeManagerResult,
  managerRefusal,
} from "../../apps/daemon/src/projects/project-manager-http-contract.js";
import {
  MAX_PROJECT_STACK_FRAME_BYTES,
  PROJECT_STACK_PROTOCOL_FRAME_TOO_LARGE,
  PROJECT_STACK_PROTOCOL_LAYER,
  PROJECT_STACK_PROTOCOL_MALFORMED,
  decodeProjectStackControlLine,
  decodeProjectStackHostLine,
} from "../../apps/daemon/src/projects/project-stack-protocol.js";
import { probeAfter, probeBefore, probeRacing } from "./hostile-harness.js";
import type { HostileCase, RaceCase } from "./transport-hostile-cases.js";

const BOUND = Object.freeze({ label: "project-transport", timeoutMs: 2_000 });

const localInvalid = Object.freeze({
  code: "PROJECT_MANAGER_PAIRING_FRAGMENT_INVALID",
  layer: PROJECT_MANAGER_LOCAL_LAYER,
});
const httpInvalid = Object.freeze({
  code: "PROJECT_MANAGER_REQUEST_INVALID",
  layer: PROJECT_MANAGER_HTTP_LAYER,
});
const protocolMalformed = Object.freeze({
  code: PROJECT_STACK_PROTOCOL_MALFORMED,
  layer: PROJECT_STACK_PROTOCOL_LAYER,
});
const protocolOversized = Object.freeze({
  code: PROJECT_STACK_PROTOCOL_FRAME_TOO_LARGE,
  layer: PROJECT_STACK_PROTOCOL_LAYER,
});

const both = (
  left: RaceCase["expected"]["left"],
  right: RaceCase["expected"]["right"],
): RaceCase["expected"] => Object.freeze({ left, right });

const capture = (href: string, pathname = "/", search = ""): unknown =>
  captureManagerPairingTicket({ href, pathname, search }, () => undefined);

/**
 * The decoder deliberately returns null rather than inventing a refusal. The route's own
 * production refusal constructor turns that exact null into the stable HTTP tuple; if the
 * decoder starts accepting a hostile shape this helper returns the admitted value unchanged.
 */
const decodeHttp = (value: unknown): unknown =>
  decodeManagerResult(value, false) ?? managerRefusal("PROJECT_MANAGER_REQUEST_INVALID");

export const PROJECT_TRANSPORT_HOSTILE_CASES: readonly HostileCase[] = Object.freeze([
  {
    arm: "BEFORE",
    boundary: "PROJECT_MANAGER_LOCAL_LAYER",
    expected: localInvalid,
    name: "an unparsable manager location cannot mint a browser pairing ticket",
    run: async () => (await probeBefore(
      BOUND,
      async () => capture("not a url"),
      async () => capture("http://[::1"),
    )).probe,
  },
  {
    arm: "AFTER",
    boundary: "PROJECT_MANAGER_LOCAL_LAYER",
    expected: localInvalid,
    name: "a manager secret replayed in the query is scrubbed and refused",
    run: async () => (await probeAfter(
      BOUND,
      async () => capture("http://127.0.0.1:39122/?manager=caller-secret", "/", "?manager=caller-secret"),
      async () => capture("http://127.0.0.1:39122/#manager=short"),
    )).probe,
  },
  {
    arm: "RACE",
    boundary: "PROJECT_MANAGER_LOCAL_LAYER",
    expected: both(localInvalid, localInvalid),
    name: "query and fragment forgeries contend and neither becomes a ticket",
    run: async () => await probeRacing(
      BOUND,
      async () => capture("http://127.0.0.1:39122/?manager=caller-secret", "/", "?manager=caller-secret"),
      async () => capture("http://127.0.0.1:39122/#manager=short"),
    ),
  },
  {
    arm: "BEFORE",
    boundary: "PROJECT_MANAGER_HTTP_LAYER",
    expected: httpInvalid,
    name: "a non-record manager result is refused at the HTTP contract",
    run: async () => (await probeBefore(
      BOUND,
      async () => decodeHttp(null),
      async () => decodeHttp([]),
    )).probe,
  },
  {
    arm: "AFTER",
    boundary: "PROJECT_MANAGER_HTTP_LAYER",
    expected: httpInvalid,
    name: "a response replayed with an extra authority field remains invalid",
    run: async () => (await probeAfter(
      BOUND,
      async () => decodeHttp({ code: "PROJECT_MANAGER_BUSY", layer: "PROJECT_MANAGER", ok: false, token: "secret" }),
      async () => decodeHttp({ code: "lowercase", layer: "PROJECT_MANAGER", ok: false }),
    )).probe,
  },
  {
    arm: "RACE",
    boundary: "PROJECT_MANAGER_HTTP_LAYER",
    expected: both(httpInvalid, httpInvalid),
    name: "two malformed manager responses contend and neither crosses the route codec",
    run: async () => await probeRacing(
      BOUND,
      async () => decodeHttp({ code: "PROJECT_MANAGER_BUSY", layer: "PROJECT_MANAGER", ok: "false" }),
      async () => decodeHttp({ code: "PROJECT_MANAGER_BUSY", layer: "PROJECT_MANAGER" }),
    ),
  },
  {
    arm: "BEFORE",
    boundary: "PROJECT_STACK_PROTOCOL_LAYER",
    expected: protocolMalformed,
    name: "a private control line with a forged schema is refused before dispatch",
    run: async () => (await probeBefore(
      BOUND,
      async () => decodeProjectStackControlLine('{"kind":"STOP"}\n'),
      async () => decodeProjectStackHostLine("not-json\n"),
    )).probe,
  },
  {
    arm: "AFTER",
    boundary: "PROJECT_STACK_PROTOCOL_LAYER",
    expected: protocolOversized,
    name: "an oversized frame replay cannot be truncated into a command",
    run: async () => (await probeAfter(
      BOUND,
      async () => decodeProjectStackControlLine("x".repeat(MAX_PROJECT_STACK_FRAME_BYTES + 1)),
      async () => decodeProjectStackHostLine("y".repeat(MAX_PROJECT_STACK_FRAME_BYTES + 2)),
    )).probe,
  },
  {
    arm: "RACE",
    boundary: "PROJECT_STACK_PROTOCOL_LAYER",
    expected: both(protocolMalformed, protocolOversized),
    name: "a malformed and an oversized frame contend without producing IPC authority",
    run: async () => await probeRacing(
      BOUND,
      async () => decodeProjectStackControlLine("{}\n"),
      async () => decodeProjectStackHostLine("z".repeat(MAX_PROJECT_STACK_FRAME_BYTES + 1)),
    ),
  },
]);

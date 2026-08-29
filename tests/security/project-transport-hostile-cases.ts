/** Hostile cases for the project-manager browser, HTTP and private IPC transports. */

import {
  PROJECT_MANAGER_LOCAL_LAYER,
  PROJECT_MANAGER_SCHEMA_VERSION,
  connectProjectManager,
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
  code: "PROJECT_MANAGER_PAIRING_REFUSED",
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

const REQUEST_ID = "ab".repeat(32);

function json(value: unknown, status = 200): Response {
  return {
    json: async () => value,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

type ManagerPairingFault = "CLAIM_EXTRA_SECRET" | "CLAIM_WRONG_LAYER"
  | "REQUEST_ID_INVALID" | "REQUEST_LABEL_INVALID";

/**
 * Drive the shipped request/claim protocol. The request identity stays inside
 * `connectProjectManager`; hostile cases can shape server answers but never receive the id.
 */
async function hostileManagerPairing(fault: ManagerPairingFault): Promise<unknown> {
  const connected = await connectProjectManager({
    fetchImpl: async (path) => {
      if (path === "/manager/bootstrap") {
        return json({
          authenticated: false,
          csrfToken: "security-manager-csrf",
          schemaVersion: PROJECT_MANAGER_SCHEMA_VERSION,
        });
      }
      if (path === "/manager/session/pair/request") {
        return json({
          confirmationLabel: fault === "REQUEST_LABEL_INVALID" ? "UPPER-ef01-2345" : "abcd-ef01-2345",
          ok: true,
          requestId: fault === "REQUEST_ID_INVALID" ? "short" : REQUEST_ID,
        });
      }
      if (path === "/manager/session/pair/claim") {
        return fault === "CLAIM_EXTRA_SECRET"
          ? json({
            code: "PROJECT_MANAGER_PAIRED",
            layer: "PROJECT_MANAGER_HTTP",
            ok: true,
            pairingToken: "caller-secret",
          })
          : json({
            code: "PROJECT_MANAGER_PAIRED",
            layer: "CONTROL_ROOM_PAIRING_APPROVAL",
            ok: true,
          });
      }
      throw new Error(`unexpected manager path ${path}`);
    },
  });
  return "status" in connected && connected.status === "AWAITING_OPERATOR"
    ? await connected.claim()
    : connected;
}

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
    name: "malformed request metadata cannot create browser pairing authority",
    run: async () => (await probeBefore(
      BOUND,
      async () => await hostileManagerPairing("REQUEST_LABEL_INVALID"),
      async () => await hostileManagerPairing("REQUEST_ID_INVALID"),
    )).probe,
  },
  {
    arm: "AFTER",
    boundary: "PROJECT_MANAGER_LOCAL_LAYER",
    expected: localInvalid,
    name: "a bearer secret replayed in an approved claim is refused",
    run: async () => (await probeAfter(
      BOUND,
      async () => await hostileManagerPairing("CLAIM_EXTRA_SECRET"),
      async () => await hostileManagerPairing("CLAIM_WRONG_LAYER"),
    )).probe,
  },
  {
    arm: "RACE",
    boundary: "PROJECT_MANAGER_LOCAL_LAYER",
    expected: both(localInvalid, localInvalid),
    name: "request and claim forgeries contend and neither becomes a connection",
    run: async () => await probeRacing(
      BOUND,
      async () => await hostileManagerPairing("REQUEST_ID_INVALID"),
      async () => await hostileManagerPairing("CLAIM_EXTRA_SECRET"),
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

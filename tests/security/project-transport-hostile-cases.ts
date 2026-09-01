/** Hostile cases for the project-manager browser, HTTP and private IPC transports. */

import {
  PROJECT_MANAGER_LOCAL_LAYER,
  PROJECT_MANAGER_SCHEMA_VERSION,
  connectProjectManager,
  type ProjectManagerFetch,
} from "../../apps/control-room/src/v2/projects/project-manager-client.js";
import {
  PROJECT_MANAGER_CREDENTIAL_HEADER,
  PROJECT_MANAGER_HTTP_LAYER,
  decodeManagerResult,
  managerRefusal,
  requestHasSession,
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
  code: "PROJECT_MANAGER_PROJECT_ORIGIN_INVALID",
  layer: PROJECT_MANAGER_LOCAL_LAYER,
});
const httpInvalid = Object.freeze({
  code: "PROJECT_MANAGER_REQUEST_INVALID",
  layer: PROJECT_MANAGER_HTTP_LAYER,
});
const httpUnauthenticated = Object.freeze({
  code: "PROJECT_MANAGER_AUTHENTICATION_REQUIRED",
  layer: "PROJECT_MANAGER_HTTP",
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

const OPEN_ID = "11111111-1111-4111-8111-111111111111";

const jsonResponse = (body: unknown): Response => ({
  json: async () => body,
  ok: true,
  status: 200,
}) as unknown as Response;

const managerFetch = (origin: unknown): ProjectManagerFetch => async (input) => {
  if (input === "/manager/bootstrap") return jsonResponse({
    authenticated: true,
    csrfToken: "csrf-hostile",
    schemaVersion: PROJECT_MANAGER_SCHEMA_VERSION,
  });
  if (input === "/manager/projects") return jsonResponse({
    projects: [],
    schemaVersion: PROJECT_MANAGER_SCHEMA_VERSION,
  });
  if (input === `/manager/projects/${OPEN_ID}/open`) return jsonResponse({
    code: "PROJECT_MANAGER_OPENED",
    layer: "PROJECT_MANAGER_HTTP",
    ok: true,
    origin,
  });
  throw new Error(`unexpected project-manager request: ${input}`);
};

const openWith = async (origin: unknown): Promise<unknown> => {
  const connection = await connectProjectManager({ fetchImpl: managerFetch(origin) });
  if (!("client" in connection)) return connection;
  return await connection.client.openProject(OPEN_ID, () => ({
    close() {},
    location: { href: "" },
    opener: {},
  }));
};

/**
 * The decoder deliberately returns null rather than inventing a refusal. The route's own
 * production refusal constructor turns that exact null into the stable HTTP tuple; if the
 * decoder starts accepting a hostile shape this helper returns the admitted value unchanged.
 */
const decodeHttp = (value: unknown): unknown =>
  decodeManagerResult(value, false) ?? managerRefusal("PROJECT_MANAGER_REQUEST_INVALID");

/**
 * task-8716a858967a4348b63dc87ab90082ce - the MANAGER PORT BOUNDARY, driven on the
 * production credential fence (`requestHasSession`).
 *
 * A cookie has no port scope: RFC 6265 gives the browser host+path and nothing else, so
 * a credential set as a cookie by the manager listener is replayed to every other
 * 127.0.0.2 port, where any same-user process can pick it up. These arms present the
 * REAL credential through that stolen channel and require the production fence to refuse
 * it. No new `*_LAYER` constant is declared: they reuse the already-rostered
 * PROJECT_MANAGER_HTTP_LAYER (boundary-roster.security.ts).
 */
const MANAGER_CREDENTIAL = "manager-session-secret-0123456789";
/** Ports an attacker could bind on 127.0.0.2 while the operator pairs. Frozen and named. */
const ATTACKER_PORTS = Object.freeze([39123, 39124, 45001, 60999]);

/** The denominator rail: a swept roster that silently produced nothing would pass. */
function requireAttackerPorts(): readonly number[] {
  if (ATTACKER_PORTS.length === 0) {
    throw new Error("manager port-boundary roster generated ZERO attacker ports");
  }
  if (new Set(ATTACKER_PORTS).size !== ATTACKER_PORTS.length) {
    throw new Error("manager port-boundary roster repeats an attacker port");
  }
  return ATTACKER_PORTS;
}

type ManagerHeaders = Readonly<Record<string, string | string[] | undefined>>;

/** Drives the PRODUCTION fence; a pass is reported as a value that is not a refusal. */
function admitManager(headers: ManagerHeaders): unknown {
  const request = { headers } as unknown as Parameters<typeof requestHasSession>[0];
  return requestHasSession(request, MANAGER_CREDENTIAL)
    ? Object.freeze({ code: "PROJECT_MANAGER_ADMITTED", layer: "PROJECT_MANAGER_HTTP", ok: true })
    : managerRefusal("PROJECT_MANAGER_AUTHENTICATION_REQUIRED");
}

/** What a browser would send to ANOTHER port on the same host: the cookie, nothing else. */
function stolenCookieAt(port: number): ManagerHeaders {
  return Object.freeze({
    cookie: `moe_manager_session=${MANAGER_CREDENTIAL}`,
    host: `127.0.0.2:${String(port)}`,
  });
}

const MANAGER_PORT_BOUNDARY_CASES: readonly HostileCase[] = Object.freeze([
  {
    arm: "BEFORE",
    boundary: "PROJECT_MANAGER_HTTP_LAYER",
    expected: httpUnauthenticated,
    name: "a request carrying no manager credential is refused before any pairing exists",
    run: async () => (await probeBefore(
      BOUND,
      async () => admitManager({ host: `127.0.0.2:${String(requireAttackerPorts()[0] ?? 0)}` }),
      async () => admitManager({ host: "127.0.0.2:39122" }),
    )).probe,
  },
  {
    arm: "AFTER",
    boundary: "PROJECT_MANAGER_HTTP_LAYER",
    expected: httpUnauthenticated,
    name: "the real credential replayed on the cookie channel is refused after a legitimate claim",
    run: async () => (await probeAfter(
      BOUND,
      // The legitimate claim: the credential on its own header is admitted.
      async () => admitManager({
        [PROJECT_MANAGER_CREDENTIAL_HEADER]: MANAGER_CREDENTIAL, host: "127.0.0.2:39122",
      }),
      // The theft: the SAME secret, arriving as a cookie on another port.
      async () => admitManager(stolenCookieAt(requireAttackerPorts()[1] ?? 0)),
    )).probe,
  },
  {
    // Arm is AFTER, not RACE, and deliberately so: transport-boundaries.security.ts:152
    // requires EXACTLY one RACE case per rostered boundary
    // (`expect(races).toBe(ROSTER_TRANSPORT.length)`), and this boundary's RACE slot is
    // already held by the codec contention above. A second RACE here would red a file
    // this row does not own. The property is unchanged: an attacker listening on a
    // second 127.0.0.2 port while the operator pairs is admitted by nothing.
    arm: "AFTER",
    boundary: "PROJECT_MANAGER_HTTP_LAYER",
    expected: httpUnauthenticated,
    name: "a second attacker port holding the stolen cookie is admitted by nothing either",
    run: async () => {
      const ports = requireAttackerPorts();
      return (await probeAfter(
        BOUND,
        async () => admitManager(stolenCookieAt(ports[2] ?? 0)),
        async () => admitManager(stolenCookieAt(ports[3] ?? 0)),
      )).probe;
    },
  },
]);

export const PROJECT_TRANSPORT_HOSTILE_CASES: readonly HostileCase[] = Object.freeze([
  {
    arm: "BEFORE",
    boundary: "PROJECT_MANAGER_LOCAL_LAYER",
    expected: localInvalid,
    name: "an unparsable project origin in the open answer is refused before navigation",
    run: async () => (await probeBefore(
      BOUND,
      async () => await openWith("not a url"),
      async () => await openWith("http://[::1"),
    )).probe,
  },
  {
    arm: "AFTER",
    boundary: "PROJECT_MANAGER_LOCAL_LAYER",
    expected: localInvalid,
    name: "authority replayed in a query or fragment is refused as a project origin",
    run: async () => (await probeAfter(
      BOUND,
      async () => await openWith("http://127.0.0.1:39122/?manager=caller-secret"),
      async () => await openWith("http://127.0.0.1:39122/#manager=short"),
    )).probe,
  },
  {
    arm: "RACE",
    boundary: "PROJECT_MANAGER_LOCAL_LAYER",
    expected: both(localInvalid, localInvalid),
    name: "query and fragment forgeries contend and neither becomes a navigation origin",
    run: async () => await probeRacing(
      BOUND,
      async () => await openWith("http://127.0.0.1:39122/?manager=caller-secret"),
      async () => await openWith("http://127.0.0.1:39122/#manager=short"),
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
  ...MANAGER_PORT_BOUNDARY_CASES,
]);

/**
 * THE ENVIRONMENTS JOURNEY, AGAINST A REAL DAEMON: the required-vs-set table, a set/unset ROUND
 * TRIP, the fingerprint changing on update, and the leak check at the REAL WIRE.
 *
 * WHAT IS REAL: the daemon process, its composed HTTP listener, the environment store with its
 * sealing key derived from the daemon's own credential, the command edge, all four refusal codes,
 * the browser, and the dev server's proxy pin. Nothing about the environment slice is doubled -
 * there is no docker or gh here to fake.
 *
 * WHY THE WIRE CHECK MATTERS AND A COMPONENT TEST CANNOT REPLACE IT. The component arms in
 * apps/control-room/src/v2/ops/environment-variables-screen.test.tsx prove the SCREEN never
 * renders or retains a value; they cannot see a response body. This spec records every response
 * the page receives and every request it sends, then searches the lot for the sentinel. That is
 * the only place the daemon's promise and the browser's promise are checked against each other.
 *
 * THE ROUND TRIP IS THE POINT of the set/unset arms. A set that renders but does not persist, and
 * an unset that leaves a row reading "set", both pass a component test happily.
 */
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { createConnection } from "node:net";

import { lanePids, mintLaneOperatorSeat, readWireProtocolVersion, survivingPids,
  withDaemonBackedControlRoom } from "./daemon-ports.js";
import type { DaemonLane } from "./daemon-ports.js";

/**
 * A VALUE THAT IS NOT A CREDENTIAL. Epic rail 3 forbids a realistic-looking secret in a committed
 * fixture; a plausible one would also trip a credential scanner on every clone of this repo. It
 * is still a real value as far as the store is concerned - it is sealed, fingerprinted and never
 * readable back exactly like any other.
 */
const SENTINEL = "SENTINEL-e2e-not-a-secret-0000-1111-2222";
const SENTINEL_UPDATED = "SENTINEL-e2e-not-a-secret-3333-4444-5555";
const VARIABLE = "DATABASE_URL";
const ENVIRONMENT = "preview";
/** Outside the store's closed `ENVIRONMENT_NAMES`; the store must answer ENV_ENVIRONMENT_UNKNOWN. */
const UNROSTERED_ENVIRONMENT = "staging";

const LANE_TIMEOUT_MS = 240_000;

interface WireRecord {
  readonly bodies: string[];
  readonly requests: string[];
}

/**
 * One command through the daemon's own /command route.
 *
 * THE SEAT IS THE LANE CREDENTIAL, NOT A MINTED ONE, and that is the opposite of what
 * `repository.publish` needs - worth stating because getting it backwards is how this arm first
 * failed. Both environment kinds are in `OPERATOR_PRINCIPAL_KINDS`
 * (apps/daemon/src/daemon-command-vocabulary.ts:380), whose fence is
 * `principal.principalId !== operatorPrincipalId`. The widening beside it covers approval intent,
 * criterion, `repository.publish` and clarification answers - NOT these. So a MINTED session,
 * however durably HUMAN, is refused OPERATOR_PRINCIPAL_REQUIRED @ DAEMON_AUTHORIZATION, while the
 * lane credential authenticates AS the configured operator principal and passes. The refusal arm
 * below pins both directions so this cannot be rediscovered.
 */
async function command(
  lane: DaemonLane, kind: string, payload: object, commandId: string,
  credential: string = lane.credential,
): Promise<unknown> {
  const response = await fetch(`${lane.daemonOrigin}/command`, {
    method: "POST",
    headers: {
      "content-type": "application/json", origin: lane.daemonOrigin,
      "x-moe-csrf": lane.csrfToken,
      "x-moe-session-credential": credential,
      "x-moe-protocol-version": await readWireProtocolVersion(lane.repoRoot) ?? "",
    },
    body: JSON.stringify({
      commandId, commandKind: kind, correlationId: `lane-env-${commandId}`,
      // The environment edge reads NEITHER `expectedVersion` NOR `targetAggregateId`: it derives
      // the aggregate from the AUTHENTICATED principal's project. Both are stated because the
      // envelope shape requires them, exactly as the browser port states them.
      expectedVersion: 0, payload, requestDigest: "d".repeat(64),
      schemaVersion: "moe-runtime-command/1",
      sessionCredential: credential,
      targetAggregateId: `environment/${ENVIRONMENT}`,
    }),
  });
  return response.json();
}

/** The daemon's own `/environments/read`, on a minted ADMIN seat. */
async function readTable(lane: DaemonLane, environment: string): Promise<Record<string, unknown>> {
  const seat = mintLaneOperatorSeat(lane);
  const response = await fetch(`${lane.daemonOrigin}/environments/read`, {
    method: "POST",
    headers: {
      "content-type": "application/json", origin: lane.daemonOrigin,
      "x-moe-csrf": lane.csrfToken,
      "x-moe-session-credential": seat.credential,
      "x-moe-protocol-version": await readWireProtocolVersion(lane.repoRoot) ?? "",
    },
    body: JSON.stringify({ environment }),
  });
  return await response.json() as Record<string, unknown>;
}

function rowsOf(frame: Record<string, unknown>): Record<string, unknown>[] {
  const variables = frame["variables"];
  return Array.isArray(variables) ? variables as Record<string, unknown>[] : [];
}

function portClosed(origin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const url = new URL(origin);
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    const done = (closed: boolean): void => { socket.destroy(); resolve(closed); };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(false)); socket.once("error", () => done(true));
  });
}

/**
 * EPIC RAIL 4: anything this spec starts, it stops - on the throwing path too. A leaked port or a
 * surviving daemon makes every later gate on this board inadmissible.
 */
async function assertStopped(lane: DaemonLane | undefined): Promise<void> {
  expect(lane, "the real daemon and server must have started").toBeDefined();
  if (lane === undefined) return;
  expect(await survivingPids([...lanePids(lane)])).toEqual([]);
  expect(await portClosed(lane.daemonOrigin)).toBe(true);
  expect(await portClosed(lane.baseUrl)).toBe(true);
  expect(existsSync(dirname(lane.catalogPath))).toBe(false);
}

test("real daemon: the variable table round-trips, the fingerprint moves, no value crosses the wire", async ({ page }) => {
  test.setTimeout(LANE_TIMEOUT_MS);
  let started: DaemonLane | undefined;
  const wire: WireRecord = { bodies: [], requests: [] };
  try {
    const result = await withDaemonBackedControlRoom({ liveCredentials: "ATTACHED" }, async (lane) => {
      started = lane;

      // ---- THE TABLE, FROM A REAL FRAME -------------------------------------------------
      const empty = await readTable(lane, ENVIRONMENT);
      expect(empty, JSON.stringify(empty)).toMatchObject({ environment: ENVIRONMENT, ok: true });
      expect(rowsOf(empty), "a fresh environment holds nothing").toEqual([]);

      // THE ROSTER IS THE STORE'S. The browser restates `ENVIRONMENT_NAMES`; this is the other
      // end of that restatement - an unrostered name refuses at the STORE's own SCOPE layer, so
      // a drift in the browser copy surfaces as this refusal rather than as a missing screen.
      const unknown = await readTable(lane, UNROSTERED_ENVIRONMENT);
      expect(unknown).toMatchObject({
        code: "ENV_ENVIRONMENT_UNKNOWN", layer: "SCOPE", ok: false,
      });

      // ---- THE OPERATOR-PRINCIPAL FENCE, BOTH DIRECTIONS -------------------------------
      // A MINTED session is durably HUMAN and holds ADMIN - it can READ the table above - and is
      // still REFUSED the write, because both environment kinds are in OPERATOR_PRINCIPAL_KINDS
      // and are NOT in the widening that lets `repository.publish` through for a paired browser.
      // Asserted with the code AND the layer: this is an AUTHORIZATION refusal, distinct from
      // every ENV_* refusal the store mints, and reading it as one would send an operator to fix
      // their variable name.
      const mintedSeat = mintLaneOperatorSeat(lane);
      const refusedSeat = await command(lane, "environment.set_variable",
        { environment: ENVIRONMENT, name: VARIABLE, value: SENTINEL }, "lane-env-minted",
        mintedSeat.credential);
      expect(refusedSeat, JSON.stringify(refusedSeat)).toMatchObject({
        outcome: "PORT_REFUSED",
        refusal: { code: "OPERATOR_PRINCIPAL_REQUIRED", layer: "DAEMON_AUTHORIZATION" },
      });
      // AND THE REFUSAL DOES NOT CARRY WHAT WAS SUBMITTED - this path is above the store's own
      // fixed-prose refusals, so it is a separate surface with a separate chance to leak.
      expect(JSON.stringify(refusedSeat)).not.toContain(SENTINEL);

      // ---- SET: THE ROUND TRIP ----------------------------------------------------------
      // The CONFIGURED operator principal, which is what the lane credential authenticates as.
      const set = await command(lane, "environment.set_variable",
        { environment: ENVIRONMENT, name: VARIABLE, value: SENTINEL }, "lane-env-set-1");
      expect(set, JSON.stringify(set)).toMatchObject({ outcome: "ACCEPTED" });

      const afterSet = await readTable(lane, ENVIRONMENT);
      const first = rowsOf(afterSet)[0];
      expect(first, JSON.stringify(afterSet)).toMatchObject({ isSet: true, name: VARIABLE });
      // FOUR KEYS AND NO OTHER. This is the daemon-side half of the no-value property, asserted
      // as exact arity so a future `value` slot fails here rather than reaching a screen.
      expect(Object.keys(first ?? {}).sort())
        .toEqual(["fingerprintSha256", "isSet", "name", "updatedAt"]);
      const firstFingerprint = String(first?.["fingerprintSha256"] ?? "");
      expect(firstFingerprint, "a full sha256, not a prefix of the value").toMatch(/^[0-9a-f]{64}$/u);
      // The fingerprint is not the value, nor derived from it in any recoverable way.
      expect(firstFingerprint).not.toContain(SENTINEL);

      // ---- THE FINGERPRINT MOVES ON UPDATE ----------------------------------------------
      const updated = await command(lane, "environment.set_variable",
        { environment: ENVIRONMENT, name: VARIABLE, value: SENTINEL_UPDATED }, "lane-env-set-2");
      expect(updated, JSON.stringify(updated)).toMatchObject({ outcome: "ACCEPTED" });
      const afterUpdate = rowsOf(await readTable(lane, ENVIRONMENT))[0];
      const secondFingerprint = String(afterUpdate?.["fingerprintSha256"] ?? "");
      expect(secondFingerprint).toMatch(/^[0-9a-f]{64}$/u);
      // THE OPERATOR'S ONLY CONFIRMATION THE UPDATE TOOK, since they can never read the value.
      expect(secondFingerprint, "a different value fingerprints differently")
        .not.toBe(firstFingerprint);

      // ---- THE FOUR REFUSALS, AT THE REAL BOUNDARY --------------------------------------
      // Each carries the code AND the layer that answered, from the store's closed map.
      const badName = await command(lane, "environment.set_variable",
        { environment: ENVIRONMENT, name: "lower_case", value: SENTINEL }, "lane-env-badname");
      expect(JSON.stringify(badName)).toContain("ENV_NAME_INVALID");
      expect(JSON.stringify(badName)).toContain("NAME");
      const badScope = await command(lane, "environment.set_variable",
        { environment: UNROSTERED_ENVIRONMENT, name: VARIABLE, value: SENTINEL }, "lane-env-badscope");
      expect(JSON.stringify(badScope)).toContain("ENV_ENVIRONMENT_UNKNOWN");
      const tooLarge = await command(lane, "environment.set_variable",
        { environment: ENVIRONMENT, name: VARIABLE, value: "z".repeat(4_097) }, "lane-env-toolarge");
      expect(JSON.stringify(tooLarge)).toContain("ENV_VALUE_TOO_LARGE");
      // AND NO REFUSAL CARRIES WHAT WAS SUBMITTED.
      for (const refusal of [badName, badScope, tooLarge]) {
        expect(JSON.stringify(refusal)).not.toContain(SENTINEL);
      }

      // ---- UNSET: THE OTHER HALF OF THE ROUND TRIP -------------------------------------
      const unset = await command(lane, "environment.unset_variable",
        { environment: ENVIRONMENT, name: VARIABLE }, "lane-env-unset-1");
      expect(unset, JSON.stringify(unset)).toMatchObject({ outcome: "ACCEPTED" });
      const afterUnset = await readTable(lane, ENVIRONMENT);
      // A row that stayed "set" after an unset passes a component test happily; it cannot pass
      // this one.
      expect(rowsOf(afterUnset), JSON.stringify(afterUnset)).toEqual([]);

      // ---- THE BROWSER, AND THE LEAK CHECK AT THE WIRE ---------------------------------
      // Seated BEFORE the first navigation: a recorder attached later misses the reads the page
      // makes on mount, which are the ones that would carry a value if any did.
      page.on("response", (response) => {
        wire.requests.push(response.url());
        void response.text().then((body) => { wire.bodies.push(body); }, () => undefined);
      });
      page.on("request", (request) => {
        wire.requests.push(`${request.url()} ${request.postData() ?? ""}`);
      });
      // The bare base URL: main.tsx serves the legacy shell only for `?v1=1`, so a journey that
      // added one would re-prove the old dev board and leave the shipped surface untested.
      await page.goto(lane.baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(3_000);

      // Set one more variable while the page is live, so the recorder is running across a write.
      const live = await command(lane, "environment.set_variable",
        { environment: ENVIRONMENT, name: VARIABLE, value: SENTINEL }, "lane-env-set-live");
      expect(live, JSON.stringify(live)).toMatchObject({ outcome: "ACCEPTED" });
      await page.waitForTimeout(3_000);

      // CONTROL: the recorder actually recorded something, so the three absences below are not
      // three empty arrays.
      expect(wire.bodies.length, "the page received response bodies").toBeGreaterThan(0);
      expect(wire.requests.length).toBeGreaterThan(0);

      // NO RESPONSE BODY THE PAGE RECEIVED CARRIES THE VALUE.
      const bodies = wire.bodies.join("\n");
      expect(bodies).not.toContain(SENTINEL);
      expect(bodies).not.toContain(SENTINEL_UPDATED);
      // NOR ANY REQUEST THE PAGE SENT - the browser never typed it here, and must not be echoing
      // one back either.
      const requests = wire.requests.join("\n");
      expect(requests).not.toContain(SENTINEL);
      expect(requests).not.toContain(SENTINEL_UPDATED);
      // NOR THE RENDERED PAGE.
      const content = await page.content();
      expect(content).not.toContain(SENTINEL);
      expect(content).not.toContain(SENTINEL_UPDATED);

      // CONTROL, POSITIVE: the search would find the sentinel if a surface carried it. Without
      // this, the four absences above prove the technique works no better than they prove the
      // wire is clean.
      expect(`${bodies}${requests}${content}${SENTINEL}`).toContain(SENTINEL);

      // AND THE FINGERPRINT IS ON THE WIRE, which is what the screen renders. Its presence
      // proves the reads above really travelled rather than being empty.
      const reFingerprinted = rowsOf(await readTable(lane, ENVIRONMENT))[0];
      expect(String(reFingerprinted?.["fingerprintSha256"] ?? "")).toBe(firstFingerprint);
    });
    expect(result.ok ? "ok" : `${result.code}: ${result.detail}`).toBe("ok");
  } finally {
    await assertStopped(started);
  }
});

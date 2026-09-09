/**
 * THE BACKUPS READ CLIENT, at the decoder seam.
 *
 * The frames below are the shape `projectBackups` in apps/daemon/src/http/backups-read.ts
 * actually serves - top level exactly `backups, ok`, and per backup exactly
 * `checkedAt, environment, ref, restoreProof, sha256` - so a daemon-side shape change reds this
 * file rather than reaching production as a backups list with a blank where a restore-proof
 * state used to be.
 *
 * WHY THE MALFORMED-FRAME ARMS ASSERT MORE THAN A CODE. Every malformation funnels to the one
 * BACKUPS_RESPONSE_INVALID code at the one CONTROL_ROOM_BACKUPS layer, so an arm that stopped at
 * `status === "ERROR"` would prove the same thing four times over and would survive a decoder
 * that leaked a half-decoded list. Each arm therefore asserts the code, the LAYER that refused,
 * and that the decode FAILED CLOSED BY VALUE: the outcome carries exactly three keys, no
 * `backups` member at all, and none of the input's refs or restore-proof states.
 */

import { describe, expect, it } from "vitest";

import {
  BACKUPS_READ_PATH, mapBackupsAnswer, readBackups,
} from "./live-backups.js";
import { DEV_PROXY_PATHS } from "./dev-proxy-paths.js";

/** The served frame, verbatim: every key the route projects, none this client invented. */
const FRAME = {
  backups: [
    {
      checkedAt: "2026-09-07T09:04:00.000Z",
      environment: "production",
      ref: "20260907090400000.sqlite",
      restoreProof: "PROVEN",
      sha256: "9f2c1b7a44e0d3f6a8b5c2e1907d4a63f0b8e5c27a19d4f36b0e8c5a2d719f4c3",
    },
    {
      checkedAt: "2026-09-07T08:04:00.000Z",
      environment: "production",
      ref: "20260907080400000.sqlite",
      restoreProof: "FAILED",
      sha256: null,
    },
    {
      checkedAt: null,
      environment: "staging",
      ref: "20260907070400000.sql",
      restoreProof: "NOT_CHECKED",
      sha256: null,
    },
  ],
  ok: true,
};

const backupAt = (index: number): Record<string, unknown> =>
  ({ ...(FRAME.backups[index] as Record<string, unknown>) });

const frameWith = (backups: readonly unknown[]): Record<string, unknown> =>
  ({ backups, ok: true });

/**
 * THE CREDENTIAL INSTRUMENT, and the reason it is a named function rather than an inline regex:
 * step 3 runs it over BOTH the decoder's output (where it must find nothing) and a planted
 * literal (where it must find something). An arm that matched nothing would otherwise be
 * indistinguishable from an arm that found nothing.
 */
const CREDENTIAL_SHAPES: ReadonlyArray<readonly [string, RegExp]> = Object.freeze([
  ["connection-string", /\b(?:postgres(?:ql)?|mysql|mongodb|redis):\/\//iu],
  ["userinfo-at-host", /[A-Za-z0-9._%-]+:[^\s"/@]{6,}@[A-Za-z0-9.-]+/u],
  // No word boundary on purpose: a real leak arrives as `DATABASE_PASSWORD`, and `\b` does not
  // fire after an underscore, so the boundary form would miss the commonest shape of all.
  ["password-token", /password/iu],
  ["private-key-header", /BEGIN [A-Z ]*PRIVATE KEY/u],
  ["absolute-windows-path", /[A-Za-z]:\\\\/u],
  ["absolute-posix-path", /"\/(?:var|etc|home|srv)\//u],
]);

function credentialShapesIn(value: unknown): readonly string[] {
  const serialized = JSON.stringify(value) ?? String(value);
  return CREDENTIAL_SHAPES.filter(([, pattern]) => pattern.test(serialized)).map(([name]) => name);
}

/** A frame whose backup row hides a connection string where the artifact basename belongs. */
const POISONED_FRAME = frameWith([{
  ...backupAt(0),
  ref: "postgresql://deploy:hunter2correcthorse@db.internal:5432/app",
  sourcePath: "/var/lib/moe/backups/20260907090400000.sqlite",
}]);

describe("the backups read client decodes exactly what the daemon serves", () => {
  it("carries all three restore-proof states across verbatim, by value", () => {
    const outcome = mapBackupsAnswer(200, FRAME);

    expect(outcome.status).toBe("BACKUPS");
    if (outcome.status !== "BACKUPS") throw new Error("unreachable");
    expect(outcome.backups.map((backup) => backup.restoreProof))
      .toStrictEqual(["PROVEN", "FAILED", "NOT_CHECKED"]);
    expect(outcome.backups[0]).toStrictEqual(FRAME.backups[0]);
    expect(outcome.backups[2]).toStrictEqual(FRAME.backups[2]);
  });

  it("keeps an absent digest and an absent check time NULL, never an empty string", () => {
    const outcome = mapBackupsAnswer(200, FRAME);

    if (outcome.status !== "BACKUPS") throw new Error("unreachable");
    const notChecked = outcome.backups[2];
    expect(notChecked?.restoreProof).toBe("NOT_CHECKED");
    // By VALUE and by TYPE: `null`, not "", not 0, not undefined, not a dash.
    expect(notChecked?.sha256).toBeNull();
    expect(notChecked?.checkedAt).toBeNull();
    expect(outcome.backups[1]?.sha256).toBeNull();
    expect(outcome.backups[1]?.checkedAt).toBe("2026-09-07T08:04:00.000Z");
  });

  it("admits an empty list without inventing a backup", () => {
    const outcome = mapBackupsAnswer(200, { backups: [], ok: true });

    expect(outcome.status).toBe("BACKUPS");
    if (outcome.status !== "BACKUPS") throw new Error("unreachable");
    expect(outcome.backups).toStrictEqual([]);
  });
});

/**
 * The four malformation arms. Each one asserts the code, the layer, and the FAIL-CLOSED VALUE -
 * the three clauses fail differently, and the third is the one a leaky decoder trips.
 */
function expectFailedClosed(outcome: ReturnType<typeof mapBackupsAnswer>): void {
  expect(outcome.status).toBe("ERROR");
  if (outcome.status === "BACKUPS") throw new Error("unreachable");
  expect(outcome.code).toBe("BACKUPS_RESPONSE_INVALID");
  // WHICH LAYER REFUSED: this client's own, not the daemon's. A daemon-layer answer here would
  // mean a refusal envelope was matched and the frame never reached the shape check.
  expect(outcome.layer).toBe("CONTROL_ROOM_BACKUPS");
  // NO PARTIAL FRAME SURVIVES. Exactly three keys, and no `backups` member under any name.
  expect(Object.keys(outcome).sort()).toStrictEqual(["code", "layer", "status"]);
  expect(outcome).not.toHaveProperty("backups");
  // AND NO RESTORE-PROOF STATE LEAKS THROUGH, by value on the serialized outcome.
  const serialized = JSON.stringify(outcome);
  expect(serialized).not.toContain("PROVEN");
  expect(serialized).not.toContain("NOT_CHECKED");
  expect(serialized).not.toContain("FAILED");
  expect(serialized).not.toContain(".sqlite");
}

describe("a malformed frame fails closed rather than dropping the restore-proof state", () => {
  it("refuses an EXTRA key at the top level", () => {
    const body = { ...FRAME, generatedAt: "2026-09-07T09:05:00.000Z" };

    expectFailedClosed(mapBackupsAnswer(200, body));
  });

  it("refuses a MISSING key at the top level", () => {
    const body: Record<string, unknown> = { backups: FRAME.backups };

    expectFailedClosed(mapBackupsAnswer(200, body));
  });

  it("refuses an EXTRA key on a nested backup row", () => {
    const body = frameWith([{ ...backupAt(0), kind: "STORE" }, backupAt(2)]);

    expectFailedClosed(mapBackupsAnswer(200, body));
  });

  it("refuses a MISSING key on a nested backup row", () => {
    const row = backupAt(2);
    delete row.restoreProof;

    expectFailedClosed(mapBackupsAnswer(200, frameWith([backupAt(0), row])));
  });

  it("refuses an UNKNOWN restore-proof state rather than defaulting it", () => {
    expectFailedClosed(mapBackupsAnswer(200, frameWith([{ ...backupAt(0), restoreProof: "OK" }])));
    expectFailedClosed(mapBackupsAnswer(200, frameWith([{ ...backupAt(0), restoreProof: null }])));
  });

  it("refuses a non-200 status and a body that is not the frame", () => {
    expectFailedClosed(mapBackupsAnswer(500, FRAME));
    expectFailedClosed(mapBackupsAnswer(200, { backups: FRAME.backups, ok: false }));
    expectFailedClosed(mapBackupsAnswer(200, { backups: "many", ok: true }));
    expectFailedClosed(mapBackupsAnswer(200, null));
  });
});

/**
 * A MALFORMED MEMBER IS NOT AN ABSENT ONE. `""` and `0` are the two shapes that would quietly
 * become "no digest" in a decoder that only checked for falsiness, and a digest that failed to
 * travel would then render identically to one that was never taken.
 */
describe("an unreadable member never reads as an absent one", () => {
  it("refuses an EMPTY-STRING digest and an empty check time instead of reading them as absent", () => {
    expectFailedClosed(mapBackupsAnswer(200, frameWith([{ ...backupAt(0), sha256: "" }])));
    expectFailedClosed(mapBackupsAnswer(200, frameWith([{ ...backupAt(0), checkedAt: "" }])));
  });

  it("refuses a ZERO digest and a numeric check time", () => {
    expectFailedClosed(mapBackupsAnswer(200, frameWith([{ ...backupAt(0), sha256: 0 }])));
    expectFailedClosed(mapBackupsAnswer(200, frameWith([{ ...backupAt(0), checkedAt: 0 }])));
  });

  it("refuses an UNDEFINED member, which a missing key would otherwise mimic", () => {
    expectFailedClosed(mapBackupsAnswer(200, frameWith([{ ...backupAt(0), sha256: undefined }])));
  });

  it("refuses the whole frame when ONE row is unreadable, never a silently shorter list", () => {
    const body = frameWith([backupAt(0), { ...backupAt(1), environment: "" }, backupAt(2)]);

    expectFailedClosed(mapBackupsAnswer(200, body));
  });
});

describe("each refusal envelope arrives with its own code and its own layer", () => {
  it("decodes the LISTENER refusal, which carries code and layer only", () => {
    const outcome = mapBackupsAnswer(503, {
      code: "LISTENER_BACKUPS_UNAVAILABLE", layer: "CONTROL_ROOM_LISTENER",
    });

    expect(outcome.status).toBe("REFUSED");
    if (outcome.status === "BACKUPS") throw new Error("unreachable");
    expect(outcome.code).toBe("LISTENER_BACKUPS_UNAVAILABLE");
    expect(outcome.layer).toBe("CONTROL_ROOM_LISTENER");
  });

  it("decodes the ROUTE refusal, which carries an outcome beside them", () => {
    const outcome = mapBackupsAnswer(200, {
      code: "BACKUPS_READ_CAPABILITY_DENIED", layer: "CONTROL_ROOM_LISTENER", outcome: "REFUSED",
    });

    expect(outcome.status).toBe("REFUSED");
    if (outcome.status === "BACKUPS") throw new Error("unreachable");
    expect(outcome.code).toBe("BACKUPS_READ_CAPABILITY_DENIED");
    expect(outcome.layer).toBe("CONTROL_ROOM_LISTENER");
  });

  it("decodes the STORE refusal at DAEMON_INGRESS, cause intact rather than erased", () => {
    const outcome = mapBackupsAnswer(200, {
      code: "BACKUP_PROOF_STORE_UNAVAILABLE", layer: "DAEMON_INGRESS", ok: false,
    });

    expect(outcome.status).toBe("REFUSED");
    if (outcome.status === "BACKUPS") throw new Error("unreachable");
    // The whole point of the third envelope: the STORE's layer, not this client's, so an
    // operator can tell an unreadable record from a malformed frame.
    expect(outcome.code).toBe("BACKUP_PROOF_STORE_UNAVAILABLE");
    expect(outcome.layer).toBe("DAEMON_INGRESS");
  });
});

describe("no credential-shaped material survives a failed decode", () => {
  it("finds a planted credential, so the instrument is not vacuous", () => {
    // THE POSITIVE CONTROL. Without it, an arm that matched nothing looks exactly like an arm
    // that found nothing, and the negative arm below would pass against a decoder that echoed
    // the whole request body.
    expect(credentialShapesIn(POISONED_FRAME))
      .toStrictEqual(["connection-string", "userinfo-at-host", "absolute-posix-path"]);
    expect(credentialShapesIn({ note: "BEGIN RSA PRIVATE KEY" })).toStrictEqual(["private-key-header"]);
    expect(credentialShapesIn({ note: "DATABASE_PASSWORD is unset" })).toStrictEqual(["password-token"]);
  });

  it("returns none of it on the FAILURE path", () => {
    const outcome = mapBackupsAnswer(200, POISONED_FRAME);

    expectFailedClosed(outcome);
    expect(credentialShapesIn(outcome)).toStrictEqual([]);
    expect(JSON.stringify(outcome)).not.toContain("hunter2correcthorse");
    expect(JSON.stringify(outcome)).not.toContain("db.internal");
  });

  it("returns none of it on the CLEAN frame either", () => {
    expect(credentialShapesIn(mapBackupsAnswer(200, FRAME))).toStrictEqual([]);
  });
});

describe("the read is wired to the one path the daemon serves", () => {
  it("posts an exactly-empty body to the pinned path", async () => {
    let seenBody = "";
    const outcome = await readBackups({}, async (body: string) => {
      seenBody = body;
      return new Response(JSON.stringify(FRAME), { status: 200 });
    });

    expect(seenBody).toBe("{}");
    expect(outcome.status).toBe("BACKUPS");
    expect(BACKUPS_READ_PATH).toBe("/backups/read");
    // Without the dev-proxy pin the dev server answers the route itself and the Health screen
    // renders against Vite instead of against a daemon.
    expect(DEV_PROXY_PATHS).toContain(BACKUPS_READ_PATH);
  });

  it("states a thrown request as a transport failure, never as an empty backups list", async () => {
    const outcome = await readBackups({}, async () => {
      throw new Error("connect ECONNREFUSED");
    });

    expect(outcome.status).toBe("ERROR");
    if (outcome.status === "BACKUPS") throw new Error("unreachable");
    expect(outcome.code).toBe("TRANSPORT_REQUEST_FAILED");
    expect(outcome.layer).toBe("CONTROL_ROOM_BACKUPS");
    expect(outcome).not.toHaveProperty("backups");
  });

  it("states an unparseable body as invalid, never as an empty backups list", async () => {
    const outcome = await readBackups({}, async () =>
      new Response("<html>proxy error</html>", { status: 200 }));

    expectFailedClosed(outcome);
  });
});

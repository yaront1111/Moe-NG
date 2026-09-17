import { describe, expect, it } from "vitest";

import {
  CUTOVER_V2_AUTHORITY_CODES, admitV2ActiveInstallation, admitV2AuthoritativeCommand,
} from "./cutover-v2-authority.js";
import type { CutoverMarkerStore } from "./cutover-v2-authority.js";

/**
 * "I CANNOT READ THE MARKER" IS NOT "THIS PROJECT WAS NEVER CUT OVER".
 *
 * `readMarkerState` already tells ABSENT from UNKNOWN — a store throw, more than one marker
 * event, the wrong event type or sequence, or a payload that will not decode all answer UNKNOWN.
 * One function later `readCutoverActivationMarker` collapsed both into `null`, and
 * `admitV2ActiveInstallation` turned that null into CUTOVER_V2_NOT_ACTIVE: the affirmative claim
 * that the installation was never activated onto the /2 plane.
 *
 * That code reaches an operator through every /2 command dispatch and through the HTTP
 * contract read, so a SQLITE_BUSY presented as "you never cut over". This file's own history
 * records what that costs when it happens: "v2 answered 'not active', v1 answered 'status
 * unknown', and the activated project was locked out of both planes with no in-band
 * re-cutover."
 *
 * The fence DIRECTION is unchanged — an unprovable marker still grants no /2 authority. Only
 * the name changes, so the operator is sent to the store rather than to a re-cutover that
 * cannot help.
 */

const STORE_FAULT = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

const unreadableStore = (): CutoverMarkerStore => ({
  readEvents: (): never => { throw STORE_FAULT; },
}) as unknown as CutoverMarkerStore;

const emptyStore = (): CutoverMarkerStore => ({
  readEvents: () => [],
}) as unknown as CutoverMarkerStore;

describe("admitV2ActiveInstallation", () => {
  it("answers STATUS_UNKNOWN when the marker aggregate cannot be read", () => {
    expect(admitV2ActiveInstallation(unreadableStore(), { projectId: "project-1" }))
      .toMatchObject({
        code: "CUTOVER_V2_STATUS_UNKNOWN",
        layer: "DAEMON_CUTOVER_V2_AUTHORITY",
        ok: false,
      });
  });

  it("still answers NOT_ACTIVE for a project that genuinely never cut over", () => {
    expect(admitV2ActiveInstallation(emptyStore(), { projectId: "project-1" }))
      .toMatchObject({ code: "CUTOVER_V2_NOT_ACTIVE", ok: false });
  });

  it("grants no /2 authority on either arm, so the fence direction is unchanged", () => {
    for (const store of [unreadableStore(), emptyStore()]) {
      const result = admitV2ActiveInstallation(store, { projectId: "project-1" });

      expect(result.ok).toBe(false);
      expect("marker" in result).toBe(false);
    }
  });
});

describe("admitV2AuthoritativeCommand", () => {
  it("carries the unknown status out to the command plane", () => {
    expect(admitV2AuthoritativeCommand(
      unreadableStore(), { commandKind: "goal.create", projectId: "project-1" },
    )).toMatchObject({ ok: false });
  });

  it("still refuses an unrostered kind before consulting the store at all", () => {
    expect(admitV2AuthoritativeCommand(
      unreadableStore(), { commandKind: "not.a.command", projectId: "project-1" },
    )).toMatchObject({ code: "CUTOVER_V2_COMMAND_UNKNOWN", ok: false });
  });
});

it("keeps the new code in the closed roster", () => {
  expect([...CUTOVER_V2_AUTHORITY_CODES]).toContain("CUTOVER_V2_STATUS_UNKNOWN");
  expect(new Set(CUTOVER_V2_AUTHORITY_CODES).size).toBe(CUTOVER_V2_AUTHORITY_CODES.length);
});

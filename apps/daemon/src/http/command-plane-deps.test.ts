import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createStoreDependencies } from "../daemon-store-foundation-composition.js";
import { createPlaneFollowingDeps } from "./command-plane-deps.js";
import type { CommandAuthorityPlane } from "./http-contract.js";

/**
 * The value routes by the plane READ AT EACH ACCESS. Over the shipped composition, because
 * the two planes' identities are what the assertions compare: `provide()` and `provideV2()`
 * each return a fresh frozen object whose `registry` and `decisions` are the composition's
 * own instances, so identity against those is the proof that the right plane answered.
 */
const closers: (() => void)[] = [];
afterAll(() => { for (const close of closers) close(); });

function shippedPlanes(label: string) {
  const project = `proj-plane-deps-${label}`;
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `moe-plane-deps-${label}-`)));
  const provider = createStoreDependencies({
    clock: () => "2026-09-13T12:00:00.000Z", credential: "plane-deps-operator",
    principalId: "operator-local", projectId: project, storePath: join(directory, "store.db"),
  });
  closers.push(() => {
    provider.close();
    rmSync(directory, { force: true, recursive: true });
  });
  const v2 = provider.provideV2?.();
  if (v2 === undefined) throw new Error("provider serves no /2 plane");
  return { project, v1: provider.provide(), v2 };
}

describe("createPlaneFollowingDeps", () => {
  it("routes registry and decisions by the plane read at each access, never memoised", () => {
    const { project, v1, v2 } = shippedPlanes("routes");
    const answers: CommandAuthorityPlane[] = ["V1", "V2", "V2", "V1"];
    let reads = 0;
    const following = createPlaneFollowingDeps({
      commandAuthorityPlane: Object.freeze({
        boundProjectId: project,
        readPlane: () => answers[Math.min(reads++, answers.length - 1)] ?? "V1",
      }),
      deps: v1, v2Deps: v2,
    });
    // The two planes are distinct instances, or the identities below prove nothing.
    expect(v1.registry).not.toBe(v2.registry);
    expect(v1.decisions).not.toBe(v2.decisions);

    expect(following.registry).toBe(v1.registry);
    expect(following.registry).toBe(v2.registry);
    expect(following.decisions).toBe(v2.decisions);
    expect(following.decisions).toBe(v1.decisions);
    // One read per access, so the fourth answer is what the fourth access got.
    expect(reads).toBe(4);
  });

  it("takes the authenticator and event-stream authority from /1 without reading the plane", () => {
    const { project, v1, v2 } = shippedPlanes("shared");
    let reads = 0;
    const following = createPlaneFollowingDeps({
      commandAuthorityPlane: Object.freeze({
        boundProjectId: project, readPlane: () => { reads++; return "V2"; },
      }),
      deps: v1, v2Deps: v2,
    });
    expect(following.authenticator).toBe(v1.authenticator);
    expect(following.eventStreamAccess).toBe(v1.eventStreamAccess);
    expect(reads).toBe(0);
    // The shipped composition shares both instances across the planes: the fact the choice
    // rests on, measured here rather than assumed.
    expect(v2.authenticator).toBe(v1.authenticator);
    expect(v2.eventStreamAccess).toBe(v1.eventStreamAccess);
  });

  it("omits eventStreamAccess when /1 composes none, rather than carrying an undefined key", () => {
    const { project, v1, v2 } = shippedPlanes("bare");
    const { eventStreamAccess: _dropped, ...bare } = v1;
    const following = createPlaneFollowingDeps({
      commandAuthorityPlane: Object.freeze({ boundProjectId: project, readPlane: () => "V1" }),
      deps: bare, v2Deps: v2,
    });
    expect(Object.hasOwn(following, "eventStreamAccess")).toBe(false);
    expect(following.registry).toBe(v1.registry);
  });

  it("throws on a plane outside the roster rather than coercing it to /1", () => {
    const { project, v1, v2 } = shippedPlanes("invalid");
    const following = createPlaneFollowingDeps({
      commandAuthorityPlane: Object.freeze({
        boundProjectId: project, readPlane: () => "V3" as unknown as CommandAuthorityPlane,
      }),
      deps: v1, v2Deps: v2,
    });
    expect(() => following.registry).toThrow("COMMAND_AUTHORITY_PLANE_INVALID");
    expect(() => following.decisions).toThrow("COMMAND_AUTHORITY_PLANE_INVALID");
  });
});

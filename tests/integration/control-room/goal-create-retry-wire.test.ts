import { createHash } from "node:crypto";
import { rmSync } from "node:fs";

import { expect, it } from "vitest";

import { frameOfSurface } from "../../../apps/control-room/src/live/live-board-feed.js";
import type { LiveSetup } from "../../../apps/control-room/src/live/live-config.js";
import type { GoalDraft } from "../../../apps/control-room/src/v2/goals/goal-model.js";
import { createGoalDispatcher, goalCreateOffer }
  from "../../../apps/control-room/src/v2/goals/live-goal-create.js";
import { WIRE_PROTOCOL_VERSION } from "../../../apps/daemon/src/http/http-contract.js";
import { createControlRoomTransport }
  from "../../../packages/control-room-client/src/client-transport.js";
import { CSRF_TOKEN, createJ1Scratch, killTree, runSeed, startDaemon }
  from "../../e2e/foundation/j1-loop-harness.js";
import type { DaemonHandle } from "../../e2e/foundation/j1-loop-harness.js";
import { asObject, daemonWire } from "../../e2e/foundation/multi-node-wire.js";

it("retries both real HTTP goal creates after a lost committed reply without creating a second goal", async () => {
  const scratch = createJ1Scratch();
  let daemon: DaemonHandle | undefined;
  try {
    daemon = await startDaemon(scratch);
    const origin = daemon.origin;
    expect((await runSeed(scratch, origin)).code).toBe(0);
    const wire = daemonWire(origin, scratch.credential);
    const catalogCount = async (): Promise<number> => {
      const catalog = await wire.post("/goals/read", {});
      expect(catalog["outcome"]).toBe("GOALS");
      expect(catalog["nextCursor"]).toBeNull();
      expect(Array.isArray(catalog["goals"])).toBe(true);
      return (catalog["goals"] as unknown[]).length;
    };
    const baselineCount = await catalogCount();
    let created = 0;
    for (const kind of ["goal.create", "goal.create_with_source"] as const) {
      let frame = frameOfSurface(await wire.post("/affordances/read", { projectId: scratch.projectId }));
      expect(frame.outcome).toBe("SURFACE");
      const commandId = goalCreateOffer(frame, kind)?.["commandId"];
      expect(typeof commandId).toBe("string");
      const postedBytes: string[] = [];
      const wireAnswers: Record<string, unknown>[] = [];
      const transport = createControlRoomTransport({
        csrfToken: CSRF_TOKEN, origin, sessionCredential: scratch.credential,
        wireProtocolVersion: WIRE_PROTOCOL_VERSION,
        fetch: async (input, init) => {
          postedBytes.push(String(init.body));
          const headers = new Headers(init.headers);
          headers.set("origin", origin);
          const response = await fetch(input, { ...init, headers });
          const answer = asObject(await response.clone().json());
          if (answer !== null) wireAnswers.push(answer);
          // The real listener has committed and replied; lose only its first answer.
          if (postedBytes.length === 1) throw new Error("simulated lost response");
          return response;
        },
      });
      const dispatch = createGoalDispatcher({
        headers: {}, sessionCredential: scratch.credential, transport,
      } as LiveSetup, () => frame, async () => frame);
      const text = "# Retry source\nThe same goal must survive an uncertain HTTP reply.\n";
      const draft: GoalDraft = {
        acceptanceCriteria: ["Only one durable goal is created"], budgetEnvelope: "",
        outcome: "Preserve the original command identity after a lost reply", title: `Retry ${kind}`,
        ...(kind === "goal.create" ? {} : { prd: {
          localSha256: createHash("sha256").update(text).digest("hex"),
          mediaType: "text/markdown" as const, name: "retry.md", size: Buffer.byteLength(text), text,
        } }),
      };
      expect(await dispatch(draft)).toEqual({
        ok: false, report: "UNDELIVERED · TRANSPORT_REQUEST_FAILED",
      });
      const first = wireAnswers[0];
      expect(first).toMatchObject({ ok: true, outcome: "ACCEPTED", decision: {
        commandId, disposition: "DECIDED", resultCode: "EFFECTS_COMMITTED",
        effectId: expect.any(String),
      } });
      frame = frameOfSurface(await wire.post("/affordances/read", { projectId: scratch.projectId }));
      const refreshedCommandId = goalCreateOffer(frame, kind)?.["commandId"];
      expect(typeof refreshedCommandId).toBe("string");
      expect(refreshedCommandId).not.toBe(commandId);
      expect(await dispatch(draft)).toEqual({
        commandId, ok: true, report: `Goal created: ${draft.title}`,
      });
      expect(postedBytes).toHaveLength(2);
      expect(postedBytes[1] === postedBytes[0]).toBe(true);
      expect(wireAnswers).toHaveLength(2);
      expect(wireAnswers[1]).toMatchObject({ ok: true, outcome: "ACCEPTED", decision: {
        commandId, disposition: "REPLAYED", resultCode: "EFFECTS_COMMITTED",
        effectId: asObject(first?.["decision"])?.["effectId"],
      } });
      created += 1;
      expect(await catalogCount()).toBe(baselineCount + created);
    }
    expect(created).toBe(2);
  } finally {
    if (daemon !== undefined) await killTree(daemon.child);
    rmSync(scratch.root, { force: true, recursive: true });
  }
}, 120_000);

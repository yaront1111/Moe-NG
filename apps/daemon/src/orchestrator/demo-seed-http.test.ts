import { describe, expect, it } from "vitest";

import { BUDGET_COMMITMENT_READ_PATH } from "../http/budget-commitment-read.js";
import type { SeedConfig } from "./demo-seed-env.js";
import {
  MOE_SEED_FRAME_UNREADABLE,
  MOE_SEED_TRANSPORT_FAILED,
  fetchBudgetCommitment,
  wireFor,
} from "./demo-seed-http.js";
import type { FetchLike } from "./demo-seed-http.js";

/**
 * task-80b6bf7c DoD 4, daemon/seed half: a client with NO `SqliteEventStore` can
 * obtain the shared-builder commitment after finalization.
 *
 * Driven with an INJECTED `FetchLike`, never a real socket — the route's own suite
 * already proves the wire end to end over a real listener and a real store, so what
 * is under test here is only how the seam reads what came back.
 */

const CONFIG: SeedConfig = {
  credential: "seed-credential",
  csrfToken: "seed-csrf",
  origin: "http://127.0.0.1:39123",
} as unknown as SeedConfig;

const RUN_ID = "run-1";
const REF = "c".repeat(64);

/** Records what was sent, so the arm can prove the seam names the run and nothing else. */
interface Sent {
  readonly body: unknown;
  readonly url: string;
}

function wireAnswering(frame: unknown, sent: Sent[] = []): ReturnType<typeof wireFor> {
  const fetchImpl: FetchLike = async (url, init) => {
    sent.push({ body: JSON.parse(init.body) as unknown, url });
    return await Promise.resolve({
      json: async (): Promise<unknown> => await Promise.resolve(frame),
      status: 200,
      text: async (): Promise<string> => await Promise.resolve(""),
    });
  };
  return wireFor(CONFIG, fetchImpl);
}

describe("the seed obtains the budget commitment over HTTP, holding no store", () => {
  it("yields the ref from a COMMITMENT frame and names only the run", async () => {
    const sent: Sent[] = [];
    const wire = wireAnswering({ outcome: "COMMITMENT", ref: REF }, sent);

    const answered = await fetchBudgetCommitment(wire, RUN_ID);

    expect(answered).toStrictEqual({ ok: true, ref: REF });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`${CONFIG.origin}${BUDGET_COMMITMENT_READ_PATH}`);
    // The seam presents no projectId and no authority — exactly one key.
    expect(sent[0]?.body).toStrictEqual({ runId: RUN_ID });
  });

  it("echoes the daemon's OWN code from a refusal frame, not a generic failure", async () => {
    const wire = wireAnswering({
      code: "APPROVAL_RUN_NOT_REVIEWABLE", layer: "APPROVAL_RUN_BINDING", outcome: "REFUSED",
    });

    const answered = await fetchBudgetCommitment(wire, RUN_ID);

    expect(answered.ok).toBe(false);
    // The SPECIFIC code, not merely ok:false — a seam that collapsed every refusal
    // into one local code would pass an `ok:false` assertion and red here.
    expect(answered).toMatchObject({ code: "APPROVAL_RUN_NOT_REVIEWABLE" });
    if (!answered.ok) expect(answered.line).toContain("layer=APPROVAL_RUN_BINDING");
  });

  it("echoes a listener transport-fault code verbatim too", async () => {
    const wire = wireAnswering({ code: "LISTENER_BUDGET_COMMITMENT_UNAVAILABLE" });

    const answered = await fetchBudgetCommitment(wire, RUN_ID);

    expect(answered).toMatchObject({ code: "LISTENER_BUDGET_COMMITMENT_UNAVAILABLE", ok: false });
  });

  it("reports MOE_SEED_FRAME_UNREADABLE for a non-object frame", async () => {
    const wire = wireAnswering("not-a-frame");

    const answered = await fetchBudgetCommitment(wire, RUN_ID);

    expect(answered).toMatchObject({ code: MOE_SEED_FRAME_UNREADABLE, ok: false });
  });

  it("reports MOE_SEED_FRAME_UNREADABLE for a COMMITMENT frame with no ref", async () => {
    // A frame that claims success but states no value is NOT a commitment. Without this
    // the seam would answer `{ok:true, ref:undefined}` and the seed would thread it on.
    const wire = wireAnswering({ outcome: "COMMITMENT" });

    const answered = await fetchBudgetCommitment(wire, RUN_ID);

    expect(answered).toMatchObject({ code: MOE_SEED_FRAME_UNREADABLE, ok: false });
  });

  it("reports MOE_SEED_TRANSPORT_FAILED when the transport throws", async () => {
    const fetchImpl: FetchLike = async () => {
      await Promise.resolve();
      throw new Error("connection refused");
    };
    const wire = wireFor(CONFIG, fetchImpl);

    const answered = await fetchBudgetCommitment(wire, RUN_ID);

    expect(answered).toMatchObject({ code: MOE_SEED_TRANSPORT_FAILED, ok: false });
    if (!answered.ok) expect(answered.line).toContain("connection refused");
  });
});

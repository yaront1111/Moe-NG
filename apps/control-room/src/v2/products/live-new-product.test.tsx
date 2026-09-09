import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BOOTSTRAP_READ_PATH, BOOTSTRAP_RECEIPT_ABSENT, BOOTSTRAP_READ_UNREADABLE,
  classifyReceipt, mapBootstrapReadAnswer, readBootstrapReceipt, receiptOf,
} from "../../live/live-bootstrap-receipt.js";
import type { BootstrapReceiptState } from "../../live/live-bootstrap-receipt.js";
import type { ActivationStep } from "../ops/activation-port.js";
import type { GoalCreateResult, GoalDraft } from "../goals/goal-model.js";
import type { OfferOutcome } from "../approvals/offer-wire.js";
import {
  BOOTSTRAP_NOT_OFFERED, CONTROLLED_PROFILE_VERSION, bootstrapPayload, runNewProduct,
} from "./live-new-product.js";
import type { NewProductPorts, NewProductRequest } from "./live-new-product.js";

/**
 * The live wiring, decode and run order. Nothing here mocks the DAEMON's authority: the
 * receipts below are the exact shapes `repository-bootstrap-read.ts` emits, and the four-state
 * classification is asserted against them rather than against a helper that restates it.
 */

afterEach(() => { vi.unstubAllGlobals(); });

const RECEIPT = Object.freeze({
  decidedAt: "2026-09-06T09:00:00.000Z",
  dir: "D:/projects/demo",
  githubRefusal: null,
  outcome: "BOOTSTRAPPED",
  refusal: null,
  remoteUrl: null,
  sha: "a".repeat(40),
  version: "moe.repository.bootstrap.receipt.v1",
});
const GH_REFUSAL = Object.freeze({
  code: "BOOTSTRAP_GH_UNAVAILABLE", detail: "GH_EXECUTABLE_ABSENT", refusedBy: "DAEMON_INGRESS",
});
const HARD_REFUSAL = Object.freeze({
  code: "BOOTSTRAP_DIR_NOT_EMPTY", detail: "DIRECTORY_NOT_EMPTY", refusedBy: "DAEMON_INGRESS",
});
const read = (receipt: unknown, extra: Record<string, unknown> = {}): unknown =>
  ({ outcome: "BOOTSTRAP_READ", receipt, ...extra });

describe("the caller half carries the operator values and omits an unrequested github", () => {
  it("sends dir, productName and the transcribed profile version, and no github key", () => {
    const payload = bootstrapPayload({ dir: "D:/projects/demo", productName: "demo" });
    // ABSENT, not empty: `{}` would ask the daemon for a repository named nothing.
    expect(Object.hasOwn(payload, "github")).toBe(false);
    expect(Object.keys(payload).sort()).toEqual(["dir", "productName", "profileVersion"]);
    expect(payload["profileVersion"]).toBe(CONTROLLED_PROFILE_VERSION);
    // Pinned as a literal so a silent drift from the daemon generator reds HERE, where the
    // comment naming the producer is, rather than as an opaque refusal in a browser.
    expect(CONTROLLED_PROFILE_VERSION).toBe("controlled-2");
  });

  it("carries owner, name and visibility verbatim when the operator asked for them", () => {
    const payload = bootstrapPayload({
      dir: "D:/projects/demo", productName: "demo",
      github: { name: "demo", owner: "an-owner", visibility: "private" },
    });
    expect(payload["github"]).toEqual({ name: "demo", owner: "an-owner", visibility: "private" });
  });
});

describe("the receipt read hits the disclosure route and decodes exactly", () => {
  it("POSTs exactly {} to /repository/bootstrap/read", async () => {
    const calls: { body: string; init: RequestInit; path: string }[] = [];
    vi.stubGlobal("fetch", vi.fn((path: string, init: RequestInit) => {
      calls.push({ body: String(init.body), init, path });
      return Promise.resolve({ json: async () => read(RECEIPT), status: 200 } as Response);
    }));
    const state = await readBootstrapReceipt({ "x-moe-csrf": "csrf-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe(BOOTSTRAP_READ_PATH);
    expect(calls[0]?.body).toBe("{}");
    expect(calls[0]?.init.method).toBe("POST");
    expect(state.state).toBe("FULL_SUCCESS");
  });

  it("rejects an unknown key, a missing key and a foreign prototype", () => {
    expect(receiptOf({ ...RECEIPT, extra: 1 })).toBeNull();
    const { sha: _sha, ...missing } = RECEIPT;
    expect(receiptOf(missing)).toBeNull();
    expect(receiptOf(Object.assign(Object.create({ inherited: 1 }), RECEIPT))).toBeNull();
    // The refusal object is exact-keyed too, at its own level.
    expect(receiptOf({ ...RECEIPT, githubRefusal: { ...GH_REFUSAL, extra: 1 } })).toBeNull();
  });

  it("reports a route refusal at the route's own code and layer", () => {
    const state = mapBootstrapReadAnswer(200, {
      code: "REPOSITORY_BOOTSTRAP_READ_UNAVAILABLE", layer: "REPOSITORY_WORKFLOW_READ",
      outcome: "REFUSED",
    });
    expect(state).toEqual({
      code: "REPOSITORY_BOOTSTRAP_READ_UNAVAILABLE", layer: "REPOSITORY_WORKFLOW_READ",
      state: "NO_RECEIPT",
    });
  });

  it("separates an absent receipt from an unreadable one", () => {
    expect(mapBootstrapReadAnswer(200, read(null))).toEqual({
      code: BOOTSTRAP_RECEIPT_ABSENT, layer: "CONTROL_ROOM_BOOTSTRAP_RECEIPT",
      state: "NO_RECEIPT",
    });
    expect(mapBootstrapReadAnswer(200, read(null, { unreadable: true }))).toEqual({
      code: BOOTSTRAP_READ_UNREADABLE, layer: "CONTROL_ROOM_BOOTSTRAP_RECEIPT",
      state: "NO_RECEIPT",
    });
  });
});

describe("all four states come from the daemon's own two fields", () => {
  it("BOOTSTRAPPED with no githubRefusal is a full success", () => {
    expect(classifyReceipt(receiptOf(RECEIPT)!).state).toBe("FULL_SUCCESS");
  });

  it("BOOTSTRAPPED WITH a githubRefusal is PARTIAL, never a refusal", () => {
    const state = classifyReceipt(receiptOf({ ...RECEIPT, githubRefusal: GH_REFUSAL })!);
    expect(state.state).toBe("PARTIAL_SUCCESS");
    expect(state.state).not.toBe("REFUSED");
    expect(state.state === "PARTIAL_SUCCESS" && state.githubRefusal.code)
      .toBe("BOOTSTRAP_GH_UNAVAILABLE");
    // The local repository is intact in the very same receipt.
    expect(state.state === "PARTIAL_SUCCESS" && state.receipt.sha).toBe("a".repeat(40));
  });

  it("a missing remoteUrl NEVER decides an outcome on its own", () => {
    // Identical receipts, both with remoteUrl null: only githubRefusal separates them.
    expect(classifyReceipt(receiptOf({ ...RECEIPT, remoteUrl: null })!).state).toBe("FULL_SUCCESS");
    expect(classifyReceipt(receiptOf({ ...RECEIPT, githubRefusal: GH_REFUSAL, remoteUrl: null })!)
      .state).toBe("PARTIAL_SUCCESS");
  });

  it("REFUSED carries the refusal code and the layer that refused", () => {
    const state = classifyReceipt(receiptOf({
      ...RECEIPT, outcome: "REFUSED", refusal: HARD_REFUSAL, remoteUrl: null, sha: null,
    })!);
    expect(state.state).toBe("REFUSED");
    expect(state.state === "REFUSED" && state.refusal).toEqual(HARD_REFUSAL);
  });
});

const committed = (kind: string): ActivationStep =>
  ({ kind, state: "ALREADY_COMMITTED" } as ActivationStep);
const answered = (kind: string, outcome: OfferOutcome): ActivationStep =>
  ({ kind, outcome, state: "ANSWERED" } as ActivationStep);

/**
 * `overrides` is a FUNCTION of the shared call log, so an overridden port still records its
 * own call. An override that closed over its own array would silently drop steps from the
 * order assertion, which is the one thing these arms exist to pin.
 */
function recordingPorts(
  overrides: (calls: string[]) => Partial<NewProductPorts> = () => ({}),
): { readonly calls: string[]; readonly ports: NewProductPorts } {
  const calls: string[] = [];
  const ports: NewProductPorts = {
    createGoal: (draft: GoalDraft): Promise<GoalCreateResult> => {
      calls.push(`goal:${draft.title}`);
      return Promise.resolve({ ok: true, report: `Goal created: ${draft.title}` });
    },
    drive: (kinds?: readonly string[]) => {
      calls.push(`drive:${kinds === undefined ? "CHAIN" : kinds.join(",")}`);
      return Promise.resolve((kinds ?? ["project.register"]).map(committed));
    },
    readReceipt: (): Promise<BootstrapReceiptState> => {
      calls.push("read");
      return Promise.resolve(classifyReceipt(receiptOf(RECEIPT)!));
    },
    submit: (request: NewProductRequest) => {
      calls.push(`submit:${request.dir}`);
      return Promise.resolve({ commandId: "command-1", ok: true } as OfferOutcome);
    },
    ...overrides(calls),
  } as NewProductPorts;
  return { calls, ports };
}

const REQUEST: NewProductRequest = { dir: "D:/projects/demo", productName: "demo" };
const DRAFT: GoalDraft = {
  acceptanceCriteria: [], budgetEnvelope: "", outcome: "Deliver demo.", title: "demo",
};

describe("the run follows the daemon's prerequisite order", () => {
  it("registers, bootstraps, reads, activates and only then creates the goal", async () => {
    const { calls, ports } = recordingPorts();
    const run = await runNewProduct(ports, REQUEST, DRAFT);
    expect(calls).toEqual([
      "drive:project.register", "submit:D:/projects/demo", "read", "drive:CHAIN", "goal:demo",
    ]);
    expect(run.bootstrap?.state).toBe("FULL_SUCCESS");
    expect(run.goal?.ok).toBe(true);
  });

  it("continues to the goal on a PARTIAL success, because the repository is real", async () => {
    const { calls, ports } = recordingPorts((log) => ({
      readReceipt: () => {
        log.push("read");
        return Promise.resolve(classifyReceipt(receiptOf({ ...RECEIPT, githubRefusal: GH_REFUSAL })!));
      },
    }));
    const run = await runNewProduct(ports, REQUEST, DRAFT);
    expect(run.bootstrap?.state).toBe("PARTIAL_SUCCESS");
    expect(run.goal?.ok).toBe(true);
    expect(calls).toContain("goal:demo");
  });

  it("stops at a hard refusal and never reaches the chain or the goal", async () => {
    const { calls, ports } = recordingPorts((log) => ({
      readReceipt: () => {
        log.push("read");
        return Promise.resolve(classifyReceipt(receiptOf({
          ...RECEIPT, outcome: "REFUSED", refusal: HARD_REFUSAL, remoteUrl: null, sha: null,
        })!));
      },
    }));
    const run = await runNewProduct(ports, REQUEST, DRAFT);
    expect(run.bootstrap?.state).toBe("REFUSED");
    expect(run.goal).toBeNull();
    expect(calls).toEqual(["drive:project.register", "submit:D:/projects/demo", "read"]);
  });

  it("never submits the bootstrap when project.register itself was refused", async () => {
    const { calls, ports } = recordingPorts((log) => ({
      drive: (kinds?: readonly string[]) => {
        log.push(`drive:${kinds === undefined ? "CHAIN" : kinds.join(",")}`);
        return Promise.resolve([answered("project.register", {
          code: "BOOTSTRAP_PREREQUISITE_MISSING", layer: "DAEMON_INGRESS", ok: false,
        })]);
      },
    }));
    const run = await runNewProduct(ports, REQUEST, DRAFT);
    expect(calls).toEqual(["drive:project.register"]);
    expect(run.bootstrap).toBeNull();
    expect(run.dispatch.ok).toBe(false);
    expect(run.dispatch.ok === false && run.dispatch.code).toBe(BOOTSTRAP_NOT_OFFERED);
  });

  it("stops before the goal when the activation chain refuses", async () => {
    let seen = 0;
    const { ports } = recordingPorts(() => ({
      drive: (kinds?: readonly string[]) => {
        seen += 1;
        return Promise.resolve(kinds === undefined
          ? [answered("project.activate", {
            code: "ACTIVATION_POLICY_UNMEASURED", layer: "DAEMON_ACTIVATION_RECEIPTS", ok: false,
          })]
          : kinds.map(committed));
      },
    }));
    const run = await runNewProduct(ports, REQUEST, DRAFT);
    expect(seen).toBe(2);
    expect(run.bootstrap?.state).toBe("FULL_SUCCESS");
    expect(run.goal).toBeNull();
  });
});

/**
 * MEASURED, NOT IMAGINED. Driving the real command from a real browser on 2026-09-06 answered
 * BOOTSTRAP_CATALOG_FAILED at DAEMON_INGRESS with the local repository already created,
 * committed and BOUND (filed as task-123da653). The dispatch refuses, and the durable receipt
 * is the ONLY thing that says the repository survived - the daemon commits it before it throws
 * (repository-bootstrap-command.ts:219-222). So the refused path reads it, and treating every
 * refused dispatch as "nothing was created" is the same harm as calling a partial success a
 * failure: it invites an operator to delete good work.
 */
describe("a refused dispatch still reads the durable receipt", () => {
  const RETAINED_REFUSAL = Object.freeze({
    code: "BOOTSTRAP_CATALOG_FAILED", detail: "CATALOG_FAILED_LOCAL_REPOSITORY_RETAINED",
    refusedBy: "DAEMON_INGRESS",
  });
  const refusedSubmit = (code: string) => (log: string[]): Partial<NewProductPorts> => ({
    readReceipt: (): Promise<BootstrapReceiptState> => {
      log.push("read");
      return Promise.resolve(classifyReceipt(receiptOf({
        ...RECEIPT, outcome: "REFUSED", refusal: RETAINED_REFUSAL, remoteUrl: null, sha: null,
      })!));
    },
    submit: (request: NewProductRequest) => {
      log.push(`submit:${request.dir}`);
      return Promise.resolve({ code, layer: "DAEMON_INGRESS", ok: false } as OfferOutcome);
    },
  });

  it("surfaces the retained-repository refusal when the receipt names THIS run's code", async () => {
    const { calls, ports } = recordingPorts(refusedSubmit("BOOTSTRAP_CATALOG_FAILED"));
    const run = await runNewProduct(ports, REQUEST, DRAFT);
    expect(calls).toEqual(["drive:project.register", "submit:D:/projects/demo", "read"]);
    const state = run.bootstrap;
    expect(state?.state).toBe("REFUSED");
    if (state?.state !== "REFUSED") throw new Error("expected a refused receipt");
    expect(state.refusal.code).toBe("BOOTSTRAP_CATALOG_FAILED");
    expect(state.refusal.detail, "the operator's proof the repository is still there")
      .toBe("CATALOG_FAILED_LOCAL_REPOSITORY_RETAINED");
    expect(run.goal).toBeNull();
  });

  it("DISCARDS a receipt whose code is not this run's, because admission writes none", async () => {
    const { calls, ports } = recordingPorts(refusedSubmit("BOOTSTRAP_PREREQUISITE_MISSING"));
    const run = await runNewProduct(ports, REQUEST, DRAFT);
    // The read still HAPPENED: the discard is a judgement about the answer, not a skipped call.
    expect(calls).toContain("read");
    expect(run.bootstrap, "a previous run's receipt must not describe this one").toBeNull();
    expect(run.dispatch.ok === false && run.dispatch.code).toBe("BOOTSTRAP_PREREQUISITE_MISSING");
  });

  it("DISCARDS a stale BOOTSTRAPPED receipt, which would render a refusal as a success", async () => {
    // The DEFAULT readReceipt answers FULL_SUCCESS - exactly the previous run's receipt an
    // admission-time refusal would leave behind. Without the code match this arm renders a
    // repository that this run never created.
    const { calls, ports } = recordingPorts((log) => ({
      submit: (request: NewProductRequest) => {
        log.push(`submit:${request.dir}`);
        return Promise.resolve({
          code: "BOOTSTRAP_PREREQUISITE_MISSING", layer: "DAEMON_INGRESS", ok: false,
        } as OfferOutcome);
      },
    }));
    const run = await runNewProduct(ports, REQUEST, DRAFT);
    expect(calls).toContain("read");
    expect(run.bootstrap, "a stale success must never survive a refused dispatch").toBeNull();
    expect(run.goal).toBeNull();
  });
});

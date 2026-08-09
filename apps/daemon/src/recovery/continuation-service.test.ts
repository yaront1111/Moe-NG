import { RECOVERY_ERROR_CODES } from "@moe/runner";
import { afterEach, describe, expect, it } from "vitest";

import { CONTINUATION_COMMAND_KINDS } from "./continuation-contracts.js";
import {
  evaluateContinuationCommandBytes,
  readContinuationBindings,
} from "./continuation-service.js";
import {
  ABSENT,
  PROJECT_ID,
  UNCLASSIFIABLE,
  closeOpenStores,
  decisions,
  run,
  seed,
  snapshot,
  store,
} from "./continuation-test-harness.js";

afterEach(closeOpenStores);

describe("continuation is one safe action", () => {
  it("moves a reconciled attempt forward on a SINGLE command", () => {
    const opened = store();
    expect(seed(opened, "attempt-absent", ABSENT)).toBe(true);
    const before = decisions(opened).length;

    const outcome = run(opened);

    // One command in the vocabulary and one durable row out of one call: a
    // caller cannot be left holding half a continuation after a crash, which is
    // the state J3 exists to prevent.
    expect(CONTINUATION_COMMAND_KINDS).toHaveLength(1);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.outcome).toBe("BOUND");
    expect(decisions(opened).length - before).toBe(1);

    const bindings = readContinuationBindings(opened, PROJECT_ID);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.attemptRef).toBe("attempt-absent");
    expect(bindings[0]?.successorRef).toBe("successor-1");
    expect(bindings[0]?.safeHandoff).toBe("handoff-1");
  });
});

describe("a resume across an unproven boundary refuses and commits nothing", () => {
  it("refuses a predecessor known to be ACTIVE with the runner's own code and layer", () => {
    const opened = store();
    expect(seed(opened, "attempt-absent", ABSENT)).toBe(true);
    const before = snapshot(opened);

    const outcome = run(opened, { predecessorRelease: "ACTIVE" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.outcome).toBe("REFUSED");
    expect(outcome.code).toBe("RECOVERY_PREDECESSOR_ACTIVE");
    expect(outcome.layer).toBe("SAFE_BOUNDARY");
    expect(RECOVERY_ERROR_CODES).toContain(outcome.code);
    // Read the store back: a handler that committed and then refused would pass
    // every assertion above.
    expect(snapshot(opened)).toBe(before);
    expect(readContinuationBindings(opened, PROJECT_ID)).toHaveLength(0);
  });

  it("refuses an UNESTABLISHED predecessor under a code distinct from the active case", () => {
    const opened = store();
    expect(seed(opened, "attempt-absent", ABSENT)).toBe(true);
    const before = snapshot(opened);

    const outcome = run(opened, { predecessorRelease: "UNKNOWN" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("RECOVERY_PREDECESSOR_RELEASE_UNKNOWN");
    expect(outcome.layer).toBe("SAFE_BOUNDARY");
    // "we cannot tell" and "we know it has not" lead an operator to different
    // next actions, so the two refusals must not collapse into one code.
    expect(outcome.code).not.toBe("RECOVERY_PREDECESSOR_ACTIVE");
    expect(snapshot(opened)).toBe(before);
  });

  it("refuses a proven release carrying no safe handoff, so admitResume is load-bearing", () => {
    const opened = store();
    expect(seed(opened, "attempt-absent", ABSENT)).toBe(true);
    const before = snapshot(opened);

    // The overlap admission ADMITS this case; only admitResume refuses it, so a
    // composition that called the first helper and skipped the second is red here.
    const outcome = run(opened, { safeHandoff: null });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("RECOVERY_RESUME_BOUNDARY_UNPROVEN");
    expect(outcome.layer).toBe("SAFE_BOUNDARY");
    expect(snapshot(opened)).toBe(before);
  });
});

describe("nothing continues without a classified record", () => {
  it("refuses an attempt restart reconciliation never saw", () => {
    const opened = store();
    expect(seed(opened, "attempt-absent", ABSENT)).toBe(true);
    const before = snapshot(opened);

    const outcome = run(opened, { attemptRef: "attempt-never-reconciled" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.outcome).toBe("UNRECONCILED");
    expect(outcome.code).toBe("CONTINUATION_ATTEMPT_UNRECONCILED");
    // The daemon's own gate answered here, not the runner's boundary.
    expect(outcome.layer).toBe("CONTINUATION");
    expect(snapshot(opened)).toBe(before);
  });

  it("refuses an attempt whose classification the runner itself refused", () => {
    const opened = store();
    expect(seed(opened, "attempt-unclassified", UNCLASSIFIABLE)).toBe(true);
    const before = snapshot(opened);

    const outcome = run(opened, { attemptRef: "attempt-unclassified" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.outcome).toBe("UNCLASSIFIED");
    expect(outcome.code).toBe("CONTINUATION_ATTEMPT_UNCLASSIFIED");
    expect(outcome.layer).toBe("CONTINUATION");
    expect(snapshot(opened)).toBe(before);
  });
});

describe("continuation ingress refuses under its own layer", () => {
  it("rejects input the bounded decoder will not accept", () => {
    const opened = store();
    const outcome = evaluateContinuationCommandBytes(opened, "not bytes");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.outcome).toBe("INPUT_REJECTED");
    expect(outcome.layer).toBe("BOUNDED_JSON");
    // The decoder's own code survives; a daemon-minted stand-in would hide which
    // bound was exceeded.
    expect(outcome.code).toBe("JSON_INPUT_TYPE_INVALID");
  });

  it("refuses an envelope carrying an undeclared key", () => {
    const opened = store();
    expect(seed(opened, "attempt-absent", ABSENT)).toBe(true);
    const before = snapshot(opened);

    const outcome = run(opened, { unexpected: "value" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.outcome).toBe("REQUEST_INVALID");
    expect(outcome.code).toBe("CONTINUATION_REQUEST_SHAPE_INVALID");
    expect(outcome.layer).toBe("CONTINUATION");
    expect(snapshot(opened)).toBe(before);
  });

  it("refuses a request pinned to a schema version this surface does not speak", () => {
    const opened = store();
    const outcome = run(opened, { schemaVersion: "moe-recovery-continuation-request/0" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("CONTINUATION_REQUEST_SHAPE_INVALID");
  });

  it("refuses a command kind outside the one-action vocabulary", () => {
    const opened = store();
    const outcome = run(opened, { kind: "work.claim" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("CONTINUATION_REQUEST_SHAPE_INVALID");
  });

  it("refuses a predecessor release outside the runner's lattice", () => {
    const opened = store();
    const outcome = run(opened, { predecessorRelease: "PROBABLY_RELEASED" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("CONTINUATION_REQUEST_SHAPE_INVALID");
    expect(outcome.layer).toBe("CONTINUATION");
  });
});

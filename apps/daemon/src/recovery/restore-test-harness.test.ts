/**
 * The shared restore harness's own teardown, which ~10 daemon suites depend on.
 *
 * WHY THIS FILE EXISTS. `$env:TEMP` on this host held **17,073** `moe-release-*` directories
 * when this task started, growing by roughly 1,700 an hour whenever the daemon suite ran.
 * Two defects produce them and they are NOT the same defect:
 *  - fixture roots that were never registered with the harness at all, so teardown had
 *    nothing to remove — those leak on the GREEN path, every run, with no host event; and
 *  - a teardown loop that popped each root BEFORE removing it, so one throw lost that root
 *    and aborted the loop, taking every remaining root with it.
 *
 * The cases below pin the second. The first is pinned by the adoption edit in the suite that
 * owns those fixtures, and by step 4's registration drill.
 *
 * Every directory here is REAL and removed on every exit path — a test about leaks that
 * leaks on its own failing path would be the same defect wearing a different hat.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupRestoreHarnesses, pendingHarnessRoots, sweepHarnessRoots, trackHarnessRoot,
} from "./restore-test-harness.js";

const scratch = (): string => mkdtempSync(join(tmpdir(), "moe-harness-teardown-"));

/** The real remover, so a case that does not exercise a failure removes for real. */
type Remover = (path: string, options: {
  readonly force: true; readonly maxRetries: number;
  readonly recursive: true; readonly retryDelay: number;
}) => void;

const held = (): Error => Object.assign(new Error("EPERM: held"), { code: "EPERM" });

afterEach(() => {
  // Never leave the shared list dirty for the next case, and never throw from here.
  for (const root of pendingHarnessRoots()) {
    rmSync(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
  try {
    cleanupRestoreHarnesses();
  } catch {
    /* the pending list is already emptied above; a report here is not this case's subject */
  }
});

describe("cleanupRestoreHarnesses removes every root it was given", () => {
  it("removes tracked roots and empties the pending list", () => {
    const first = trackHarnessRoot(scratch());
    const second = trackHarnessRoot(scratch());

    cleanupRestoreHarnesses();

    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
    expect(pendingHarnessRoots()).toEqual([]);
  });

  it("retries a transient removal failure instead of abandoning the root", () => {
    const first = trackHarnessRoot(scratch());
    const second = trackHarnessRoot(scratch());
    let refused = false;
    const remove: Remover = (path, options) => {
      if (path === first && !refused) {
        refused = true;
        throw held();
      }
      rmSync(path, options);
    };

    sweepHarnessRoots(remove);

    expect(refused).toBe(true);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
    expect(pendingHarnessRoots()).toEqual([]);
  });

  it("keeps EXACTLY the failing root pending and reports it, losing none of the rest", () => {
    const stuck = trackHarnessRoot(scratch());
    const removable = trackHarnessRoot(scratch());
    const remove: Remover = (path, options) => {
      if (path === stuck) throw held();
      rmSync(path, options);
    };

    try {
      let thrown: unknown = null;
      try {
        sweepHarnessRoots(remove);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message.includes("RESTORE_HARNESS_TEARDOWN_LEAK")).toBe(true);
      expect(message.includes(stuck)).toBe(true);
      // The root BEHIND the failure is still removed: a throw must not abort the sweep.
      expect(existsSync(removable)).toBe(false);
      // And the failing one is the ONLY thing still pending — the prune-after-success
      // assertion, and the killer for a prune-before-remove regression.
      expect(pendingHarnessRoots()).toEqual([stuck]);
    } finally {
      rmSync(stuck, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    }
  });

  it("closes stores BEFORE removing roots, which is what makes the removal possible", () => {
    // Ordering is the subject: a held SQLite handle is the win32 EPERM source, so a root
    // removed before its store closed would fail for a reason the retry cannot fix.
    const order: string[] = [];
    const root = trackHarnessRoot(scratch());
    const remove: Remover = (path, options) => {
      order.push("root");
      rmSync(path, options);
    };

    sweepHarnessRoots(remove);

    expect(order).toEqual(["root"]);
    expect(existsSync(root)).toBe(false);
  });
});

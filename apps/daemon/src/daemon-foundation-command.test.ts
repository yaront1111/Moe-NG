/**
 * The `foundation.dispatch` seam: what the transport admits, and which authority answers when
 * the server-side completion refuses.
 *
 * THE ALLOW-LIST is graded BIDIRECTIONALLY and through the REAL production seam. A test that
 * only iterates `FOUNDATION_DISPATCH_PAYLOAD_KEYS` shrinks its own iteration when a member is
 * deleted and stays green, so the ADMITTED side is enumerated from the seam's own refusal
 * BEHAVIOUR — every advertised key must survive the payload-shape check, and every key outside
 * the roster must be refused by it.
 *
 * THE COMPLETION PASSTHROUGH is driven through `createFoundationDispatchHandler` itself. The
 * discriminator is deliberate: an uncomposed service answers `FOUNDATION_ATTEMPT_LAUNCH_UNKNOWN`
 * from its own fail-closed default, so reading the UPSTREAM code back out is what proves the
 * production authority is wired AND that its refusal is not restamped on the way out.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { DomainRefusal } from "./daemon-command-dispatch.js";
import {
  FOUNDATION_DISPATCH_BYTES_KEY, FOUNDATION_DISPATCH_PAYLOAD_KEYS,
  createFoundationDispatchHandler,
} from "./daemon-foundation-command.js";
import {
  ACTIVATION_AGGREGATE, DECIDED_AT, FOUNDATION_SEAM_CATALOG_PATH, NODE_KEY, SESSION_ID,
  activationBytes, cleanupSeamHarnesses, commandRequest, dispatchPayload, seamHarness,
  seedFoundationStore,
} from "./http/foundation-registry-fixtures.js";
import { handleAsyncCommandRequest } from "./http/http-adapter.js";
import { PRINCIPAL_ID, PROJECT_ID } from "./recovery/restore-test-harness.js";
import { FOUNDATION_DISPATCH_COMMAND_KIND } from "./work/foundation-attempt-contracts.js";
import type { FoundationAttemptLaunchTemplate } from "./work/foundation-attempt-contracts.js";
import {
  FOUNDATION_WORKSPACE_CATALOG_ENV_KEY, readFoundationCatalogConfig,
} from "./work/foundation-capture-lifecycle.js";
import type {
  FoundationCaptureLifecycle, PreparedCapture,
} from "./work/foundation-capture-lifecycle.js";
import type { FoundationContextSealPort } from "./work/foundation-context-record.js";

/**
 * The roster this row narrows to, named ONCE as an immutable constant so a member deletion has
 * an exact count to red rather than a length that silently follows it down.
 */
const EXPECTED_DISPATCH_PAYLOAD_KEYS = Object.freeze([
  "activationRequestBytesBase64", "binding",
] as const);

/** Keys the seam must now REFUSE, each derived server-side rather than carried by the caller. */
const RETIRED_PAYLOAD_KEYS = Object.freeze([
  "graphSnapshot", "inputManifest", "launchTemplate",
] as const);

const PIN_ROOT = "D:\\moe-data\\runtime-pins";
const WORKTREE_ROOT = "D:\\moe-data\\worktrees\\attempt-1";
const DIGEST = "a".repeat(64);
const CONFIGURATION_LAYER = "PROJECT_CONFIGURATION_SELECTION";

const roots: string[] = [];

afterAll(() => {
  cleanupSeamHarnesses();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { force: true, maxRetries: 5, recursive: true });
  }
});

describe("the transport allow-list is the narrowed two-key roster", () => {
  it("advertises exactly the two server-independent keys", () => {
    expect(EXPECTED_DISPATCH_PAYLOAD_KEYS).toHaveLength(2);
    expect(FOUNDATION_DISPATCH_PAYLOAD_KEYS).toHaveLength(2);
    expect([...FOUNDATION_DISPATCH_PAYLOAD_KEYS].sort())
      .toEqual([...EXPECTED_DISPATCH_PAYLOAD_KEYS].sort());
    expect(FOUNDATION_DISPATCH_BYTES_KEY).toBe("activationRequestBytesBase64");
    expect([...FOUNDATION_DISPATCH_PAYLOAD_KEYS]).not.toContain("launchTemplate");
  });

  /**
   * THE DENOMINATOR THE TWO BEHAVIOURAL SWEEPS BELOW ARE MEASURED AGAINST. Both rosters are
   * frozen constants with an EXACT count, and they must stay DISJOINT: re-admitting a retired
   * key to the advertised roster would otherwise leave one sweep expecting it past the shape
   * gate and the other expecting it refused there, with nothing naming the contradiction.
   */
  it("names two disjoint rosters of exact size, five keys in total", () => {
    expect(EXPECTED_DISPATCH_PAYLOAD_KEYS).toHaveLength(2);
    expect(RETIRED_PAYLOAD_KEYS).toHaveLength(3);
    const advertised = new Set<string>(EXPECTED_DISPATCH_PAYLOAD_KEYS);
    const retired = new Set<string>(RETIRED_PAYLOAD_KEYS);
    expect(advertised.size).toBe(2);
    expect(retired.size).toBe(3);
    for (const key of retired) expect(advertised.has(key), key).toBe(false);
    for (const key of advertised) expect(retired.has(key), key).toBe(false);
    expect(new Set([...advertised, ...retired]).size).toBe(5);
  });

  /**
   * THE ADMITTED SIDE, enumerated from the seam's BEHAVIOUR rather than from the roster.
   * Each advertised key is sent ALONE, so the payload-shape gate is the only thing that can
   * have an opinion about it: an admitted key reaches a LATER authority (the request is
   * incomplete, so the attempt codec refuses it at DISPATCH), while a key the roster no longer
   * advertises would answer `INPUT_INVALID` at `PAYLOAD_SHAPE` before any of that.
   *
   * Deleting a member from `FOUNDATION_DISPATCH_PAYLOAD_KEYS` therefore reds this arm, which a
   * test that merely iterated the roster could never do — its own iteration would shrink too.
   */
  it("lets every advertised key past the payload-shape check when sent alone", async () => {
    const harness = seamHarness("allow-list-admitted");
    try {
      let probed = 0;
      for (const key of EXPECTED_DISPATCH_PAYLOAD_KEYS) {
        probed += 1;
        const solo = Object.fromEntries(
          Object.entries(dispatchPayload()).filter(([name]) => name === key));
        expect(Object.keys(solo), key).toHaveLength(1);
        const answer = await handleAsyncCommandRequest(harness.deps, commandRequest({
          commandId: `cmd-admitted-${key}`, payload: solo as never,
        }));
        expect(answer.ok, key).toBe(false);
        if (answer.ok) return;
        expect(answer.stage, key).not.toBe("PAYLOAD_SHAPE");
        expect(answer.stage, key).toBe("DISPATCH");
      }
      expect(probed).toBe(EXPECTED_DISPATCH_PAYLOAD_KEYS.length);
      expect(probed).toBe(2);
    } finally {
      harness.close();
    }
  }, 60_000);

  /**
   * THE SERVED SIDE. `launchTemplate` now sits beside `graphSnapshot` and `inputManifest`:
   * refused at the seam rather than trimmed, because a silently ignored spoof is
   * indistinguishable from an honoured one at the call site.
   */
  it("refuses every retired key at the seam's own allow-list, naming code and stage", async () => {
    expect(RETIRED_PAYLOAD_KEYS).toHaveLength(3);
    const harness = seamHarness("allow-list-retired");
    try {
      let probed = 0;
      for (const key of RETIRED_PAYLOAD_KEYS) {
        probed += 1;
        const answer = await handleAsyncCommandRequest(harness.deps, commandRequest({
          commandId: `cmd-retired-${key}`,
          payload: { ...dispatchPayload(), [key]: { spoofed: true } } as never,
        }));
        expect(answer.ok, key).toBe(false);
        if (answer.ok) return;
        // WHICH authority refused: the seam's payload-shape gate, not the attempt codec —
        // both can refuse this request, and only the stage separates them.
        expect(answer.stage, key).toBe("PAYLOAD_SHAPE");
        expect(answer.outcome, key).toBe("REFUSED");
        if (answer.outcome !== "REFUSED") return;
        expect(answer.error.code, key).toBe("INPUT_INVALID");
      }
      expect(probed).toBe(RETIRED_PAYLOAD_KEYS.length);
      expect(probed).toBe(3);
    } finally {
      harness.close();
    }
  }, 60_000);
});

/** A sealed context whose template the completion phase is handed; never asserted against. */
function sealingContextPort(template: FoundationAttemptLaunchTemplate): FoundationContextSealPort {
  const bytes = Object.freeze([...new TextEncoder().encode("sealed context")]);
  return {
    sealFoundationContext: () => Object.freeze({
      bytes, contextManifestDigest: DIGEST, ok: true as const,
      template: template as never,
    }),
  };
}

/** Prepares a capture without materializing a tree: the launch phase is what is under test. */
function preparingLifecycle(): FoundationCaptureLifecycle {
  return {
    prepareCapture: async () => Object.freeze({
      assignment: {
        adopted: false, assignmentVersion: "moe-worktree-assignment/1",
        attemptId: "attempt-1", baseIdentity: "b".repeat(64), leaf: "attempt-1",
        projectId: PROJECT_ID, realSourceRepositoryRoot: WORKTREE_ROOT,
        realWorktreeParent: WORKTREE_ROOT, realWorktreePath: WORKTREE_ROOT,
        worktreePath: WORKTREE_ROOT,
      },
      captureRef: DIGEST, disposition: "COMMITTED" as const,
      inputManifest: { baseIdentity: "b".repeat(64), entries: [] },
      observation: {}, ok: true as const, proof: null, record: {},
    }) as unknown as PreparedCapture,
    releaseWorktree: () => { throw new Error("release must not run on a refusal"); },
  };
}

function dispatchInput(): unknown {
  return {
    envelope: {
      commandId: "cmd-completion-passthrough", commandKind: FOUNDATION_DISPATCH_COMMAND_KIND,
      correlationId: "corr-completion", expectedVersion: 0,
      payload: {
        [FOUNDATION_DISPATCH_BYTES_KEY]: Buffer.from(activationBytes()).toString("base64"),
        binding: { attemptAggregateId: ACTIVATION_AGGREGATE, nodeKey: NODE_KEY,
          sessionId: SESSION_ID },
      },
      requestDigest: DIGEST, schemaVersion: "moe-runtime-command-envelope/1",
      sessionCredential: "credential", targetAggregateId: ACTIVATION_AGGREGATE,
    },
    principal: { capabilities: [], principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
  };
}

function seededStore(label: string): SqliteEventStore {
  const root = mkdtempSync(join(tmpdir(), `moe-foundation-command-${label}-`));
  roots.push(root);
  const storePath = join(root, "project.db");
  seedFoundationStore(storePath);
  return SqliteEventStore.openForProject(storePath, PROJECT_ID);
}

describe("the handler derives the launch template server-side", () => {
  /**
   * The store is seeded so `deriveFoundationDispatchFacts` SUCCEEDS — the graph and the
   * workspace are present and that fence runs BEFORE any provider read. An empty store would
   * refuse at the derivation and this arm would pass while proving nothing.
   */
  it("passes the completion authority's upstream refusal through with its own code and layer",
    async () => {
      const store = seededStore("completion-passthrough");
      const template = {
        argv: ["--print"], bootstrapCredentialDigest: DIGEST, cwd: WORKTREE_ROOT,
        environment: {}, launchSelection: {}, limits: {},
        runtime: { installedRoot: "C:\\installed", pinRoot: PIN_ROOT, quotedObservation: {} },
      } as unknown as FoundationAttemptLaunchTemplate;
      try {
        const handler = createFoundationDispatchHandler({
          catalogSource: readFoundationCatalogConfig({
            [FOUNDATION_WORKSPACE_CATALOG_ENV_KEY]: FOUNDATION_SEAM_CATALOG_PATH,
          }),
          contextSeal: sealingContextPort(template),
          lifecycle: preparingLifecycle(),
          pinRoot: PIN_ROOT,
          store,
        });

        const refusal = await handler(dispatchInput() as never)
          .then(() => null, (error: unknown) => error);

        expect(refusal).toBeInstanceOf(DomainRefusal);
        if (!(refusal instanceof DomainRefusal)) throw new Error("the dispatch was not refused");
        // The seeded world carries no durable project configuration, so the FIRST authority the
        // completion consults refuses — and its code travels out unrestamped.
        expect(refusal.code).toBe("PROJECT_CONFIGURATION_ABSENT");
        expect(refusal.layer).toBe(CONFIGURATION_LAYER);
        // THE DISCRIMINATOR: an uncomposed service answers from its own fail-closed default.
        // Reading anything other than that code back is what proves the production authority
        // is actually wired into this handler.
        expect(refusal.code).not.toBe("FOUNDATION_ATTEMPT_LAUNCH_UNKNOWN");
      } finally {
        store.close();
      }
    }, 60_000);

  it("names the decided-at the fixtures pin, so the seeded world is the one under test", () => {
    expect(DECIDED_AT).toBe("2026-08-15T00:00:00.000Z");
  });
});

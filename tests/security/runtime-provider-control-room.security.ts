/// <reference lib="dom" />
/** Hostile coverage for the browser-owned control-room runtime boundaries. */

import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinEnvironments } from "vitest/runtime";

import { PRD_LOCAL_LAYER } from "../../apps/control-room/src/v2/goals/new-goal-form-model.js";
import {
  PRD_FILE_PREFLIGHT_MAX_BYTES,
  readGoalPrdFile,
  useGoalPrd,
} from "../../apps/control-room/src/v2/goals/use-goal-prd.js";
import {
  SESSION_KEY_LAYER,
  generateSessionKey,
} from "../../packages/control-room-client/src/session-key.js";
import { probeAfter, probeBefore, probeRacing } from "./hostile-harness.js";
import {
  RUNTIME_BOUND as BOUND,
  createLedger,
  describeSliceInvariants,
} from "./runtime-provider-ledger.js";
import type { Arm } from "./runtime-provider-ledger.js";

const OWNED = [SESSION_KEY_LAYER, PRD_LOCAL_LAYER] as const;
const ledger = createLedger();
const requireFromControlRoom = createRequire(
  new URL("../../apps/control-room/package.json", import.meta.url),
);
const REFUSAL = Object.freeze({
  code: "SESSION_KEY_ALGORITHM_UNSUPPORTED",
  layer: SESSION_KEY_LAYER,
  ok: false as const,
});

interface HostileCase {
  readonly arm: Arm;
  readonly title: string;
  readonly run: () => Promise<void>;
}

interface PrdHostileCase {
  readonly arm: Arm;
  readonly title: string;
  readonly run: () => Promise<void>;
}

interface HookRender<T> {
  readonly result: { readonly current: T };
}

interface HookUtilities {
  act(action: () => void): void;
  act(action: () => Promise<void>): Promise<void>;
  cleanup(): void;
  renderHook<T>(render: () => T): HookRender<T>;
  waitFor(assertion: () => void): Promise<void>;
}

const PRD_TOO_LARGE = Object.freeze({
  code: "PRD_FILE_TOO_LARGE",
  layer: PRD_LOCAL_LAYER,
});
const PRD_UNREADABLE = Object.freeze({
  code: "PRD_FILE_UNREADABLE",
  layer: PRD_LOCAL_LAYER,
});

function stubFetchCanary(): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(() => { throw new Error("PRD selection reached fetch"); });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function assertExactRefusal(actual: unknown): void {
  const ok = typeof actual === "object" && actual !== null
    ? (actual as { readonly ok?: unknown }).ok
    : undefined;
  expect(ok).toBe(false);
  if (ok !== false) return;
  expect(actual).toStrictEqual(REFUSAL);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const CASES = [
  {
    arm: "BEFORE",
    title: "two rejected generation attempts reach no downstream crypto operation",
    run: async () => {
      const generateKey = vi.fn(async () => {
        throw new DOMException("hostile Ed25519 rejection", "NotSupportedError");
      });
      const exportKey = vi.fn(async () => {
        throw new Error("BEFORE reached exportKey");
      });
      const digest = vi.fn(async () => {
        throw new Error("BEFORE reached digest");
      });
      vi.stubGlobal("crypto", { subtle: { digest, exportKey, generateKey } });

      const outcome = await probeBefore(
        BOUND,
        () => generateSessionKey(),
        () => generateSessionKey(),
      );

      ledger.refused(SESSION_KEY_LAYER, "BEFORE", outcome.probe, REFUSAL);
      ledger.refused(SESSION_KEY_LAYER, "BEFORE", outcome.effect, REFUSAL);
      assertExactRefusal(outcome.probe);
      assertExactRefusal(outcome.effect);
      expect(generateKey).toHaveBeenCalledTimes(2);
      expect(exportKey).not.toHaveBeenCalled();
      expect(digest).not.toHaveBeenCalled();
    },
  },
  {
    arm: "AFTER",
    title: "two private-only results cannot borrow valid downstream crypto",
    run: async () => {
      const privateOnly = [
        Object.freeze({ privateKey: Symbol("private-only-effect") }),
        Object.freeze({ privateKey: Symbol("private-only-probe") }),
      ] as const;
      let generated = 0;
      const generateKey = vi.fn(async () => privateOnly[generated++]);
      const exportKey = vi.fn(async () => new Uint8Array(44).buffer);
      const digest = vi.fn(async () => new Uint8Array(32).buffer);
      vi.stubGlobal("crypto", { subtle: { digest, exportKey, generateKey } });

      const outcome = await probeAfter(
        BOUND,
        () => generateSessionKey(),
        () => generateSessionKey(),
      );

      ledger.refused(SESSION_KEY_LAYER, "AFTER", outcome.effect, REFUSAL);
      ledger.refused(SESSION_KEY_LAYER, "AFTER", outcome.probe, REFUSAL);
      assertExactRefusal(outcome.effect);
      assertExactRefusal(outcome.probe);
      expect(privateOnly.map((pair) => Object.keys(pair))).toStrictEqual([
        ["privateKey"],
        ["privateKey"],
      ]);
      expect(generateKey).toHaveBeenCalledTimes(2);
      expect(exportKey).not.toHaveBeenCalled();
      expect(digest).not.toHaveBeenCalled();
    },
  },
  {
    arm: "RACE",
    title: "two malformed SPKI widths overlap and neither reaches the digest",
    run: async () => {
      const leftPublicKey = Object.freeze({ side: "left-public" });
      const rightPublicKey = Object.freeze({ side: "right-public" });
      const pairs = [
        Object.freeze({ privateKey: Symbol("left-private"), publicKey: leftPublicKey }),
        Object.freeze({ privateKey: Symbol("right-private"), publicKey: rightPublicKey }),
      ] as const;
      let generated = 0;
      const generateKey = vi.fn(async () => pairs[generated++]);
      let arrivals = 0;
      let arrivalsAtRelease = 0;
      let release!: () => void;
      const bothExporting = new Promise<void>((resolve) => { release = resolve; });
      const exportedWidths: number[] = [];
      const exportKey = vi.fn(async (_format: unknown, publicKey: unknown) => {
        arrivals += 1;
        if (arrivals === 2) {
          arrivalsAtRelease = arrivals;
          release();
        }
        await bothExporting;
        const width = publicKey === leftPublicKey ? 43 : publicKey === rightPublicKey ? 45 : 0;
        exportedWidths.push(width);
        return new Uint8Array(width).buffer;
      });
      const digest = vi.fn(async () => new Uint8Array(32).buffer);
      vi.stubGlobal("crypto", { subtle: { digest, exportKey, generateKey } });

      const outcome = await probeRacing(
        BOUND,
        () => generateSessionKey(),
        () => generateSessionKey(),
      );

      const assertionErrors: unknown[] = [];
      for (const side of [outcome.left, outcome.right]) {
        try {
          ledger.refusedSide(SESSION_KEY_LAYER, side, REFUSAL);
        } catch (error) {
          assertionErrors.push(error);
        }
      }
      if (assertionErrors.length > 0) throw assertionErrors[0];
      for (const side of [outcome.left, outcome.right]) {
        if (side.status !== "fulfilled") throw new Error("session-key race leg rejected");
        assertExactRefusal(side.value);
      }
      expect(arrivalsAtRelease).toBe(2);
      expect(exportKey).toHaveBeenCalledTimes(2);
      expect(exportedWidths.sort((left, right) => left - right)).toStrictEqual([43, 45]);
      expect(digest).not.toHaveBeenCalled();
    },
  },
] as const satisfies readonly HostileCase[];

const PRD_CASES = [
  {
    arm: "BEFORE",
    title: "oversize preflight refuses before text or digest",
    run: async () => {
      const fetch = stubFetchCanary();
      const digest = vi.fn(async () => new Uint8Array(32).buffer);
      vi.stubGlobal("crypto", { subtle: { digest } });
      const file = new File(
        ["a".repeat(PRD_FILE_PREFLIGHT_MAX_BYTES + 1)],
        "too-large.md",
        { type: "text/markdown" },
      );
      const text = vi.fn(async () => "must not be read");
      Object.defineProperty(file, "text", { value: text });

      const actual = await readGoalPrdFile(file);

      ledger.refused(PRD_LOCAL_LAYER, "BEFORE", actual, PRD_TOO_LARGE);
      expect(actual).toStrictEqual({
        code: "PRD_FILE_TOO_LARGE",
        layer: "CONTROL_ROOM_NEWGOAL",
        status: "ERROR",
      });
      expect(text).not.toHaveBeenCalled();
      expect(digest).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  },
  {
    arm: "AFTER",
    title: "valid-size text rejection maps to the local unreadable refusal",
    run: async () => {
      const fetch = stubFetchCanary();
      const digest = vi.fn(async () => new Uint8Array(32).buffer);
      vi.stubGlobal("crypto", { subtle: { digest } });
      const file = new File(["read me"], "unreadable.md", { type: "text/markdown" });
      const text = vi.fn(async () => { throw new Error("hostile text rejection"); });
      Object.defineProperty(file, "text", { value: text });

      const actual = await readGoalPrdFile(file);

      ledger.refused(PRD_LOCAL_LAYER, "AFTER", actual, PRD_UNREADABLE);
      expect(actual).toStrictEqual({
        code: "PRD_FILE_UNREADABLE",
        layer: "CONTROL_ROOM_NEWGOAL",
        status: "ERROR",
      });
      expect(text).toHaveBeenCalledTimes(1);
      expect(digest).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  },
  {
    arm: "RACE",
    title: "superseded success cannot publish over the current unreadable refusal",
    run: async () => {
      const environment = await builtinEnvironments.jsdom.setup(globalThis, {});
      let cleanup: (() => void) | undefined;
      try {
        const utilities = requireFromControlRoom("@testing-library/react/pure") as HookUtilities;
        ({ cleanup } = utilities);
        const { act, renderHook, waitFor } = utilities;
        const fetch = stubFetchCanary();
        let resolveDigest!: (value: ArrayBuffer) => void;
        const digest = vi.fn(() => new Promise<ArrayBuffer>((resolve) => {
          resolveDigest = resolve;
        }));
        vi.stubGlobal("crypto", { subtle: { digest } });
        const stale = new File(["stale bytes"], "stale.md", { type: "text/markdown" });
        const current = new File(["current bytes"], "current.md", { type: "text/markdown" });
        Object.defineProperty(current, "text", {
          value: vi.fn(async () => { throw new Error("current file is unreadable"); }),
        });
        const { result } = renderHook(() => useGoalPrd());

        act(() => result.current.acceptFile(stale));
        await waitFor(() => expect(digest).toHaveBeenCalledTimes(1));
        act(() => result.current.acceptFile(current));
        await waitFor(() => expect(result.current.read).toStrictEqual({
          code: "PRD_FILE_UNREADABLE",
          layer: "CONTROL_ROOM_NEWGOAL",
          status: "ERROR",
        }));
        await act(async () => {
          resolveDigest(new Uint8Array(32).buffer);
          await Promise.resolve();
        });

        ledger.refused(PRD_LOCAL_LAYER, "RACE", result.current.read, PRD_UNREADABLE);
        expect(result.current.read).toStrictEqual({
          code: "PRD_FILE_UNREADABLE",
          layer: "CONTROL_ROOM_NEWGOAL",
          status: "ERROR",
        });
        expect(result.current.prd).toBeNull();
        expect(result.current.submittedPrd).toBeUndefined();
        expect(digest).toHaveBeenCalledTimes(1);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        cleanup?.();
        vi.unstubAllGlobals();
        await environment.teardown(globalThis);
      }
    },
  },
] as const satisfies readonly PrdHostileCase[];

describe(SESSION_KEY_LAYER, () => {
  it("declares exactly one literal case for each hostile arm", () => {
    expect(CASES).toHaveLength(3);
    expect(CASES.map(({ arm }) => arm)).toStrictEqual(["BEFORE", "AFTER", "RACE"]);
  });

  for (const hostileCase of CASES) {
    it(`${hostileCase.arm} - ${hostileCase.title}`, hostileCase.run);
  }

  it("records exactly two refusing outcomes per hostile arm", () => {
    expect(CASES.map(({ arm }) => [
      arm,
      ledger.entries.filter((entry) => entry.boundary === SESSION_KEY_LAYER && entry.arm === arm)
        .length,
    ])).toStrictEqual([
      ["BEFORE", 2],
      ["AFTER", 2],
      ["RACE", 2],
    ]);
  });
});

describe(PRD_LOCAL_LAYER, () => {
  it("declares a nonzero exact BEFORE, AFTER, RACE tuple", () => {
    expect(PRD_CASES.length).toBeGreaterThan(0);
    expect(PRD_CASES).toHaveLength(3);
    expect(PRD_CASES.map(({ arm }) => arm)).toStrictEqual(["BEFORE", "AFTER", "RACE"]);
  });

  for (const hostileCase of PRD_CASES) {
    it(`${hostileCase.arm} - ${hostileCase.title}`, hostileCase.run);
  }
});

describeSliceInvariants("control-room browser boundaries", ledger, OWNED, [], 0);

/** Hostile coverage for the browser-owned session-key generation boundary. */

import { afterEach, describe, expect, it, vi } from "vitest";

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

const OWNED = [SESSION_KEY_LAYER] as const;
const ledger = createLedger();
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
      ledger.entries.filter((entry) => entry.arm === arm).length,
    ])).toStrictEqual([
      ["BEFORE", 2],
      ["AFTER", 2],
      ["RACE", 2],
    ]);
  });
});

describeSliceInvariants("control-room session key", ledger, OWNED, [], 0);

import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  PAIRING_OPERATOR_MAX_LINE_BYTES,
  consumePairingOperatorLines,
} from "./pairing-operator-channel.js";
import type { CancellablePairingOperatorInput } from "./pairing-operator-channel.js";

async function* chunks(values: readonly (string | Uint8Array)[]): AsyncIterable<string | Uint8Array> {
  for (const value of values) yield value;
}

describe("bounded private pairing operator channel", () => {
  it("reassembles newline-delimited input without exposing partial bytes", async () => {
    const accept = vi.fn();
    await consumePairingOperatorLines(chunks(["abcd-ef", "01-2345\r\n"]), accept);
    expect(accept).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledWith("abcd-ef01-2345");
  });

  it("drops overlong, non-ascii, NUL, and unterminated input", async () => {
    const accept = vi.fn();
    await consumePairingOperatorLines(chunks([
      `${"a".repeat(PAIRING_OPERATOR_MAX_LINE_BYTES + 1)}\n`,
      "abcd-ef01-23é5\n",
      "abcd-ef01-23\u000045\n",
      "abcd-ef01-2345",
    ]), accept);
    expect(accept).not.toHaveBeenCalled();
  });

  it("continues with the next bounded line after discarding an overlong one", async () => {
    const accept = vi.fn();
    await consumePairingOperatorLines(chunks([
      `${"x".repeat(PAIRING_OPERATOR_MAX_LINE_BYTES + 10)}\nnext\n`,
    ]), accept);
    expect(accept).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledWith("next");
  });

  it("owns cancellation of a never-ending operator input", async () => {
    const controller = new AbortController();
    let destroys = 0;
    let settleNext: ((value: IteratorResult<string>) => void) | undefined;
    const input: CancellablePairingOperatorInput = {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<string>> =>
          await new Promise<IteratorResult<string>>((resolve) => { settleNext = resolve; }),
      }),
      destroy: (): void => {
        destroys += 1;
        settleNext?.({ done: true, value: undefined });
      },
    };
    const consuming = consumePairingOperatorLines(
      input,
      vi.fn(),
      { signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort();

    const outcome = await Promise.race([
      consuming.then(() => "CANCELLED" as const),
      new Promise<"STILL_READING">((resolve) => {
        setTimeout(() => { resolve("STILL_READING"); }, 25);
      }),
    ]);
    expect(outcome).toBe("CANCELLED");
    expect(destroys).toBe(1);
  });

  it("releases a real Node stdin handle while the parent keeps its pipe open", async () => {
    const source = new URL("./pairing-operator-channel.ts", import.meta.url).href;
    const script = [
      `import { consumePairingOperatorLines } from ${JSON.stringify(source)};`,
      "const controller = new AbortController();",
      "const consuming = consumePairingOperatorLines(process.stdin, () => undefined,",
      "  { signal: controller.signal });",
      "setTimeout(() => controller.abort(), 20);",
      "await consuming;",
    ].join("\n");
    const child = spawn(process.execPath, [
      "--experimental-transform-types", "--input-type=module", "--eval", script,
    ], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    const outcome = await new Promise<{ readonly code: number | null; readonly timedOut: boolean }>(
      (resolve) => {
        const timer = setTimeout(() => {
          child.kill();
          resolve({ code: null, timedOut: true });
        }, 1_000);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve({ code, timedOut: false });
        });
      },
    );

    expect(outcome, stderr).toEqual({ code: 0, timedOut: false });
  });
});

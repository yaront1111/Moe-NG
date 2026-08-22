/**
 * Retention tests for the session close latch of the Streamable HTTP adapter.
 *
 * The lifecycle suite proves a close SETTLES an in-flight JSON-mode POST. This file proves the
 * other half: a POST that settled on its own leaves NOTHING parked on its session's latch. A
 * shared-promise latch kept one closure and one dead Response per completed call until the
 * session closed, then built one SESSION_EXPIRED refusal per retained call in a single drain.
 *
 * The latch is adapter-private, so retention is observed at the one seam the drain crosses:
 * the runtime error factory that every refusal is built from. It is wrapped, not replaced, so
 * the adapter's refusals stay the real ones; the wrapper only counts. A drained close that
 * built a refusal per completed call reads here as N calls where a deregistered latch reads 0.
 */
import { describe, expect, it, vi } from "vitest";

import { createRuntimeError } from "@moe/contracts";

import {
  CONFORMANCE_COMMAND_ARGS,
  CONFORMANCE_COMMAND_LABEL,
  CONFORMANCE_COMMAND_RESPONSE_TEXT,
  createRecordingPort,
} from "../dispatch-conformance.js";
import { MCP_SESSION_ID_HEADER } from "./http-session.js";
import {
  INITIALIZE_BODY,
  build,
  openSession,
  readPayload,
  resultText,
  toolCallBody,
} from "./http-server-test-helpers.js";

vi.mock("@moe/contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@moe/contracts")>();
  return { ...actual, createRuntimeError: vi.fn(actual.createRuntimeError) };
});

const COMPLETED_CALLS = 8;

/** Refusals built with the code the latch leg produces, since the last `mockClear`. */
function sessionExpiredRefusalsBuilt(): number {
  return vi
    .mocked(createRuntimeError)
    .mock.calls.filter(
      ([input]) => (input as { code?: unknown } | undefined)?.code === "SESSION_EXPIRED",
    ).length;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe("http adapter - close latch retains no completed request", () => {
  it("builds zero refusals at DELETE for calls that already settled", async () => {
    const port = createRecordingPort();
    const { adapter, sessionId } = await openSession(port);
    for (let id = 2; id < 2 + COMPLETED_CALLS; id += 1) {
      const response = await adapter.handleRequest(
        build({ body: toolCallBody(id, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), sessionId }),
      );
      expect(response.status).toBe(200);
      expect(resultText(await readPayload(response))).toBe(CONFORMANCE_COMMAND_RESPONSE_TEXT);
    }
    // Every call reached the daemon port: each settled through the SDK, not through a refusal.
    expect(port.calls.filter((call) => call === "dispatchCommandBytes")).toHaveLength(COMPLETED_CALLS);

    vi.mocked(createRuntimeError).mockClear();
    const deleted = await adapter.handleRequest(build({ method: "DELETE", sessionId }));
    expect(deleted.status).toBe(200);
    // The drain, where there is one, runs in the microtasks the release queues; settle past
    // them so an empty count means no drain and not a count taken too early.
    await settle();
    expect(sessionExpiredRefusalsBuilt()).toBe(0);

    // Positive control for the seam itself: the same code IS built, exactly once, by a request
    // that arrives after the close. Without this a wrapper that counted nothing would pass.
    const late = await adapter.handleRequest(
      build({ body: toolCallBody(99, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), sessionId }),
    );
    expect(late.status).toBe(404);
    expect(sessionExpiredRefusalsBuilt()).toBe(1);
    await adapter.close();
  });

  it("builds zero refusals at shutdown for calls that already settled on several sessions", async () => {
    const port = createRecordingPort();
    const { adapter, sessionId: firstId } = await openSession(port);
    const second = await adapter.handleRequest(build({ body: INITIALIZE_BODY }));
    const secondId = second.headers.get(MCP_SESSION_ID_HEADER) ?? "";
    await second.text();
    expect(secondId).not.toBe("");

    for (const sessionId of [firstId, secondId]) {
      for (let id = 2; id < 2 + COMPLETED_CALLS; id += 1) {
        const response = await adapter.handleRequest(
          build({ body: toolCallBody(id, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), sessionId }),
        );
        expect(response.status).toBe(200);
        await response.text();
      }
    }

    vi.mocked(createRuntimeError).mockClear();
    // The sweep releases each latch right after closing its transport, the same act a DELETE
    // performs per session; with every call settled there is nothing for either to drain.
    await adapter.close();
    await settle();
    expect(sessionExpiredRefusalsBuilt()).toBe(0);
  });

  /**
   * The subscribe-after-release branch. A POST is screened while its session is still open,
   * then parks on its own body read; the DELETE lands in that gap. When the body completes the
   * POST reaches a latch that has ALREADY released, and must settle with the same 404 rather
   * than wait on a close that will never come again.
   */
  it("settles a POST whose session closed while it was still reading its body", async () => {
    const port = createRecordingPort();
    const { adapter, sessionId } = await openSession(port);

    let pushBody: () => void = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        pushBody = (): void => {
          controller.enqueue(new TextEncoder().encode(
            toolCallBody(2, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS),
          ));
          controller.close();
        };
      },
    });
    // Headers and method from the shared builder; only the body is swapped for the stream.
    const streaming = new Request(build({ body: "{}", sessionId }), {
      body,
      ...({ duplex: "half" } as object),
    });
    const parked = adapter.handleRequest(streaming);
    await settle();
    expect(port.calls).toEqual([]);

    const deleted = await adapter.handleRequest(build({ method: "DELETE", sessionId }));
    expect(deleted.status).toBe(200);

    pushBody();
    const response = await parked;
    expect(response.status).toBe(404);
    const error = (await readPayload(response))["error"] as { data?: { code?: string } };
    expect(error.data?.code).toBe("SESSION_EXPIRED");
    expect(port.calls).toEqual([]);
    await adapter.close();
  });
});

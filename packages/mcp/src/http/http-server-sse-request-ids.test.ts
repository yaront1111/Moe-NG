import { describe, expect, it } from "vitest";

import {
  CONFORMANCE_COMMAND_ARGS,
  CONFORMANCE_COMMAND_LABEL,
} from "../dispatch-conformance.js";
import type { HttpDispatchContext, HttpDispatchPort } from "./http-server.js";
import { build, openSession, readPayload, resultText } from "./http-server-test-helpers.js";

function deferredPort(): {
  readonly port: HttpDispatchPort;
  readonly pending: ((text: string) => void)[];
  readonly signals: AbortSignal[];
} {
  const pending: ((text: string) => void)[] = [];
  const signals: AbortSignal[] = [];
  const dispatch = (_bytes: Uint8Array, context: HttpDispatchContext): Promise<Uint8Array> => new Promise((resolve) => {
    if (context.signal !== undefined) signals.push(context.signal);
    pending.push((text) => { resolve(new TextEncoder().encode(text)); });
  });
  return {
    pending,
    signals,
    port: {
      authenticate: () => ({ ok: true }),
      dispatchCommandBytes: dispatch,
      dispatchQueryBytes: dispatch,
    },
  };
}

function call(id: number | string): Record<string, unknown> {
  return {
    id,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: CONFORMANCE_COMMAND_ARGS, name: CONFORMANCE_COMMAND_LABEL },
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

async function expectDuplicateRefused(response: Response): Promise<void> {
  expect(response.status).toBe(400);
  expect(await readPayload(response)).toMatchObject({
    error: { code: -32602, data: { code: "INPUT_INVALID" } },
    id: null,
  });
}

describe("HTTP SSE request ID lifetime", () => {
  it.each([2, "request-2"])("retains ID %s after headers until its response is sent", async (id) => {
    const { port, pending } = deferredPort();
    const { adapter, sessionId } = await openSession(port, false);
    try {
      const first = await adapter.handleRequest(build({ body: JSON.stringify(call(id)), sessionId }));
      await settle();
      expect(first.headers.get("content-type")).toBe("text/event-stream");
      expect(pending).toHaveLength(1);

      const duplicate = await adapter.handleRequest(build({ body: JSON.stringify(call(id)), sessionId }));
      await expectDuplicateRefused(duplicate);
      expect(pending).toHaveLength(1);

      pending[0]?.("first-response");
      expect(resultText(await readPayload(first))).toBe("first-response");
      await settle();
      const reused = await adapter.handleRequest(build({ body: JSON.stringify(call(id)), sessionId }));
      expect(reused.status).toBe(200);
      expect(pending).toHaveLength(2);
      pending[1]?.("reused-response");
      expect(resultText(await readPayload(reused))).toBe("reused-response");
    } finally {
      for (const release of pending) release("cleanup");
      await adapter.close();
    }
  });

  it("retains every batch ID until the last response releases the SDK stream mapping", async () => {
    const { port, pending } = deferredPort();
    const { adapter, sessionId } = await openSession(port, false);
    try {
      const first = await adapter.handleRequest(build({
        body: JSON.stringify([call(10), call(11)]), sessionId,
      }));
      await settle();
      expect(pending).toHaveLength(2);
      pending[0]?.("first-in-batch");
      await settle();

      // The first result has been emitted, but the SDK still correlates both IDs to this batch.
      const duplicate = await adapter.handleRequest(build({ body: JSON.stringify(call(10)), sessionId }));
      await expectDuplicateRefused(duplicate);
      expect(pending).toHaveLength(2);

      pending[1]?.("last-in-batch");
      const original = await first.text();
      expect(original).toContain("first-in-batch");
      expect(original).toContain("last-in-batch");
      await settle();
      const reused = await adapter.handleRequest(build({ body: JSON.stringify(call(10)), sessionId }));
      expect(pending).toHaveLength(3);
      pending[2]?.("reused-batch-id");
      expect(resultText(await readPayload(reused))).toBe("reused-batch-id");
    } finally {
      for (const release of pending) release("cleanup");
      await adapter.close();
    }
  });

  it("retains an ID after SSE cancellation until the running handler completes", async () => {
    const { port, pending } = deferredPort();
    const { adapter, sessionId } = await openSession(port, false);
    try {
      const first = await adapter.handleRequest(build({ body: JSON.stringify(call(20)), sessionId }));
      await first.body?.cancel();
      await settle();
      const duplicate = await adapter.handleRequest(build({ body: JSON.stringify(call(20)), sessionId }));
      await expectDuplicateRefused(duplicate);
      expect(pending).toHaveLength(1);

      pending[0]?.("disconnected-response");
      await settle();
      const reused = await adapter.handleRequest(build({ body: JSON.stringify(call(20)), sessionId }));
      expect(pending).toHaveLength(2);
      pending[1]?.("reused-after-disconnect");
      expect(resultText(await readPayload(reused))).toBe("reused-after-disconnect");
    } finally {
      for (const release of pending) release("cleanup");
      await adapter.close();
    }
  });

  it("releases IDs refused by the SDK before creating an SSE stream", async () => {
    const { port, pending } = deferredPort();
    const { adapter, sessionId } = await openSession(port, false);
    try {
      const refused = await adapter.handleRequest(build({
        accept: "application/json", body: JSON.stringify(call(30)), sessionId,
      }));
      expect(refused.status).toBe(406);
      await refused.text();
      expect(pending).toHaveLength(0);

      const accepted = await adapter.handleRequest(build({ body: JSON.stringify(call(30)), sessionId }));
      expect(accepted.status).toBe(200);
      expect(pending).toHaveLength(1);
      pending[0]?.("accepted-after-refusal");
      expect(resultText(await readPayload(accepted))).toBe("accepted-after-refusal");
    } finally {
      for (const release of pending) release("cleanup");
      await adapter.close();
    }
  });

  it("releases an ID after the SDK sends an error response", async () => {
    const { port, pending } = deferredPort();
    const { adapter, sessionId } = await openSession(port, false);
    try {
      const unknown = await adapter.handleRequest(build({
        body: JSON.stringify({ id: 40, jsonrpc: "2.0", method: "unsupported" }), sessionId,
      }));
      expect(await readPayload(unknown)).toMatchObject({ error: { code: -32601 }, id: 40 });
      await settle();

      const reused = await adapter.handleRequest(build({ body: JSON.stringify(call(40)), sessionId }));
      expect(reused.status).toBe(200);
      expect(pending).toHaveLength(1);
      pending[0]?.("reused-after-error");
      expect(resultText(await readPayload(reused))).toBe("reused-after-error");
    } finally {
      for (const release of pending) release("cleanup");
      await adapter.close();
    }
  });

  it("keeps protocol-cancelled batch IDs reserved while distinct requests remain usable", async () => {
    const { port, pending, signals } = deferredPort();
    const { adapter, sessionId } = await openSession(port, false);
    try {
      const batch = await adapter.handleRequest(build({
        body: JSON.stringify([call(50), call(51)]), sessionId,
      }));
      const cancelled = await adapter.handleRequest(build({ body: JSON.stringify({
        jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 50 },
      }), sessionId }));
      expect(cancelled.status).toBe(202);
      expect(signals[0]?.aborted).toBe(true);
      pending[0]?.("cancelled-result");
      pending[1]?.("uncancelled-partner-result");
      await settle();
      // The SDK suppresses result 50 and therefore retains both batch correlations.
      for (const id of [50, 51]) {
        await expectDuplicateRefused(await adapter.handleRequest(build({
          body: JSON.stringify(call(id)), sessionId,
        })));
      }
      expect(pending).toHaveLength(2);
      const distinct = await adapter.handleRequest(build({ body: JSON.stringify(call(52)), sessionId }));
      expect(pending).toHaveLength(3);
      pending[2]?.("distinct-result");
      expect(resultText(await readPayload(distinct))).toBe("distinct-result");
      await batch.body?.cancel();
    } finally {
      for (const release of pending) release("cleanup");
      await adapter.close();
    }
  });
});

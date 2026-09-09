import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ advance: vi.fn(), close: vi.fn(async () => undefined), publish: vi.fn(async () => []),
  start: vi.fn(async () => ({ ok: true })), coordinate: vi.fn(async () => undefined) }));
vi.mock("../criterion-evidence/criterion-service.js", () => ({ createCriterionEvidenceService: () => ({ advance: mocks.advance, close: mocks.close }) }));
vi.mock("./node-publisher.js", () => ({ createNodePublisher: () => ({ publishOnce: mocks.publish }) }));
vi.mock("./repository-delivery-coordinator.js", () => ({ createRepositoryDeliveryCoordinator: () => ({ advance: mocks.coordinate, start: mocks.start }) }));
import { createRepositoryDeliveryRuntime } from "./repository-delivery-runtime.js";
function runtime() {
  // The three workflow services are mocked; this fixture exercises the sequencing facade only.
  return createRepositoryDeliveryRuntime({ compiledWorkspace: "workspace", storePath: process.execPath, landingOn: true,
    nodes: () => [], log: () => undefined, fence: {}, verifier: { projectId: "project", nodeMission: () => null, store: {} },
  } as unknown as Parameters<typeof createRepositoryDeliveryRuntime>[0]);
}
afterEach(() => vi.clearAllMocks());
it("does not start publication after close interrupts a pending criterion stage", async () => {
  let finish!: () => void;
  mocks.advance.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const delivery = runtime(); const pending = delivery.advance();
  await vi.waitFor(() => expect(mocks.advance).toHaveBeenCalledTimes(1));
  await delivery.close(); finish(); await pending;
  expect(mocks.publish).not.toHaveBeenCalled();
  await delivery.advance(); expect(mocks.coordinate).toHaveBeenCalledTimes(1);
});
it("rejects new node admission once shutdown starts", async () => {
  const delivery = runtime(); await delivery.close();
  const spawn = vi.fn();
  expect(await delivery.start(spawn)({ kind: "node.deliver" } as never)).toMatchObject({ ok: false, code: "REPOSITORY_DELIVERY_CLOSED" });
  expect(mocks.start).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
});

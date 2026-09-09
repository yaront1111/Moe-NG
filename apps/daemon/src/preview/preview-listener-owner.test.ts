import { expect, it } from "vitest";
import { listenerPidsOwned, previewOwnsListener } from "./preview-listener-owner.js";

it("accepts only listeners in the observed child ancestry", () => {
  const parents = new Map([[10, 1], [11, 10], [12, 11], [20, 1]]);
  expect(listenerPidsOwned(10, [10, 12], parents)).toBe(true);
  expect(listenerPidsOwned(10, [12, 20], parents)).toBe(false);
  expect(listenerPidsOwned(10, [99], parents)).toBe(false);
  expect(listenerPidsOwned(10, [], parents)).toBe(false);
  expect(listenerPidsOwned(99, [99], parents)).toBe(false);
});
it("refuses cyclic ancestry instead of guessing an owner", () => {
  expect(listenerPidsOwned(10, [11], new Map([[10, 1], [11, 12], [12, 11]]))).toBe(false);
});
it("refuses invalid process/port identities before observing the OS", async () => {
  expect(await previewOwnsListener(0, 3000, process.platform, process.env)).toBe(false);
  expect(await previewOwnsListener(process.pid, 0, process.platform, process.env)).toBe(false);
});

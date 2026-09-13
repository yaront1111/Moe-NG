import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { CaptureImage } from "./preview-capture-image.js";

const ROUTE = "/preview/capture/goal-1/abc/orders.png";
const ALT = "Screenshot of Read orders";
const PNG = new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });

/** jsdom has no object URLs; these stand in and let the revoke be asserted by value. */
let minted = 0;
const createObjectURL = vi.fn((_blob: Blob): string => `blob:mock/${String(++minted)}`);
const revokeObjectURL = vi.fn((_url: string): void => undefined);

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
});
afterAll(() => {
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});
afterEach(() => { cleanup(); createObjectURL.mockClear(); revokeObjectURL.mockClear(); });

/** True when ANY element in the document carries the capture route as its src. */
const routeOnAnElement = (): boolean =>
  document.querySelector(`[src^="/preview/capture"]`) !== null;

/** The real `<img>`, once the bytes arrived: the pending placeholder is a span with role img. */
const findImage = (): Promise<HTMLImageElement> => waitFor(() => {
  const image = document.querySelector("img");
  if (image === null) throw new Error("no <img> yet");
  return image;
});

describe("a capture is fetched, never linked", () => {
  it("shows the bytes the loader fetched through an object URL, and revokes it on unmount", async () => {
    const load = vi.fn(async (_url: string): Promise<Blob | null> => PNG);
    const { unmount } = render(<CaptureImage alt={ALT} load={load} url={ROUTE} />);

    // The route path is what is FETCHED - with the session headers, by the loader - and it is
    // on no element before, during or after the load: a bare src is the request the route
    // refuses (measured 403), so an element carrying it would be a broken image by design.
    expect(load).toHaveBeenCalledWith(ROUTE);
    expect(routeOnAnElement()).toBe(false);
    const shot = await findImage();
    expect(shot.getAttribute("alt")).toBe(ALT);
    expect(shot.getAttribute("src")).toBe("blob:mock/1");
    expect(createObjectURL).toHaveBeenCalledWith(PNG);
    expect(routeOnAnElement()).toBe(false);

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock/1");
  });

  it("says a refused capture could not be loaded, and renders no image for it", async () => {
    const load = vi.fn(async (_url: string): Promise<Blob | null> => null);
    render(<CaptureImage alt={ALT} load={load} url={ROUTE} />);

    const shot = await screen.findByText(`${ALT} could not be loaded.`);
    expect(shot.getAttribute("data-state")).toBe("UNAVAILABLE");
    expect(document.querySelector("img")).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(routeOnAnElement()).toBe(false);
  });

  it("is loading, not broken, until the loader settles - and a throwing loader is unavailable", async () => {
    let settle: (blob: Blob | null) => void = () => undefined;
    const load = vi.fn((_url: string) => new Promise<Blob | null>((resolve) => { settle = resolve; }));
    render(<CaptureImage alt={ALT} load={load} url={ROUTE} />);
    expect(screen.getByText(`${ALT} is loading.`).getAttribute("data-state")).toBe("PENDING");
    expect(document.querySelector("img")).toBeNull();
    settle(PNG);
    expect((await findImage()).getAttribute("alt")).toBe(ALT);
    cleanup();

    const throwing = vi.fn(async (_url: string): Promise<Blob | null> => { throw new Error("gone"); });
    render(<CaptureImage alt={ALT} load={throwing} url={ROUTE} />);
    expect((await screen.findByText(`${ALT} could not be loaded.`)).getAttribute("data-state"))
      .toBe("UNAVAILABLE");
  });
});

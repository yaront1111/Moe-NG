import { resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { pathInside } from "./pack-tool-identity.js";

const root = resolve("moe-path-inside-root");

describe("pathInside containment", () => {
  it("admits the root itself and any descendant", () => {
    expect(pathInside(root, root)).toBe(true);
    expect(pathInside(root, `${root}${sep}child`)).toBe(true);
    expect(pathInside(root, resolve(root, "nested", "deep", "file.txt"))).toBe(true);
  });

  it("admits a descendant whose first segment merely starts with two dots", () => {
    expect(pathInside(root, resolve(root, "..hidden"))).toBe(true);
    expect(pathInside(root, resolve(root, "...", "file"))).toBe(true);
  });

  it("refuses the parent, a sibling, and a sibling that shares the root's name prefix", () => {
    expect(pathInside(root, resolve(root, ".."))).toBe(false);
    expect(pathInside(root, resolve(root, "..", "sibling"))).toBe(false);
    expect(pathInside(root, `${root}-other`)).toBe(false);
    expect(pathInside(`${root}${sep}child`, root)).toBe(false);
  });

  it.runIf(process.platform === "win32")("refuses a candidate on another drive", () => {
    const drive = root.slice(0, 1).toUpperCase() === "Z" ? "Y" : "Z";
    expect(pathInside(root, `${drive}:${sep}moe-path-inside-root`)).toBe(false);
  });
});

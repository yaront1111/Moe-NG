import { describe, expect, it } from "vitest";

import { flag } from "./argv-flag.js";

describe("flag reads one --name=value out of argv", () => {
  it("returns the value, with any later '=' kept whole", () => {
    expect(flag(["--store-path=/tmp/store.sqlite"], "store-path")).toBe("/tmp/store.sqlite");
    expect(flag(["--filter=a=b"], "filter")).toBe("a=b");
  });

  it("answers null for a flag that is not there, and for the bare form with no '='", () => {
    expect(flag([], "store-path")).toBeNull();
    expect(flag(["--project-id=p"], "store-path")).toBeNull();
    expect(flag(["--store-path"], "store-path")).toBeNull();
    expect(flag(["--store-path /tmp/store.sqlite"], "store-path")).toBeNull();
  });

  it("keeps absent and empty apart, so an entrypoint can refuse a blank value by name", () => {
    expect(flag(["--project-id="], "project-id")).toBe("");
    expect(flag(["--project-id="], "store-path")).toBeNull();
  });

  it("takes the first occurrence: a repeated flag never silently overrides", () => {
    expect(flag(["--project-id=first", "--project-id=second"], "project-id")).toBe("first");
  });

  it("matches on the whole name, so a longer flag is not read as a shorter one", () => {
    expect(flag(["--source-root=/checkout"], "source")).toBeNull();
    expect(flag(["--source-root=/checkout", "--source=x"], "source")).toBe("x");
    expect(flag(["--source-root=/checkout"], "source-root")).toBe("/checkout");
  });
});

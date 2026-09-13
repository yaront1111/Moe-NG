import { useState } from "react";
import { createHash } from "node:crypto";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductQuery } from "./product-query.js";
import { FixtureProductWorkspace } from "./fixtures/fixture-product-workspace.js";
import { EXAMPLE_SOURCE } from "./fixtures/fixture-product-data.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const route = { kind: "board", goalId: "example-booking", planningRunRef: "example-run", title: "Bicycle shop appointments" } as const;
function Example({ artifactId = null }: { readonly artifactId?: string | null }) {
  const [query, update] = useState<ProductQuery>({ goalId: route.goalId, artifactId, inspector: null });
  return <FixtureProductWorkspace route={route} query={query} update={update} />;
}

describe("fixture product workspace", () => {
  it("identifies the exact authored PRD bytes shown on the canvas", () => {
    if (EXAMPLE_SOURCE.status !== "GOAL_SOURCE") throw new Error("missing example source");
    expect(EXAMPLE_SOURCE.byteLength).toBe(new TextEncoder().encode(EXAMPLE_SOURCE.text).byteLength);
    expect(EXAMPLE_SOURCE.contentSha256).toBe(createHash("sha256").update(EXAMPLE_SOURCE.text).digest("hex"));
  });

  it("uses real text artifacts and production inspectors without contacting a daemon", async () => {
    const user = userEvent.setup();
    const fetch = vi.fn(() => { throw new Error("example must not use transport"); });
    vi.stubGlobal("fetch", fetch);
    render(<Example />);
    expect(screen.getByText(/Example product\. These states/u)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Appointment product requirements" })).toBeTruthy();
    expect(screen.getByText(/Online payment is excluded/u)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Viewed product artifact"), "example:design");
    expect(screen.getByText("Authored design")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Screens and journeys" })).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    await user.click(screen.getByLabelText("Refresh product status"));
    expect((screen.getByLabelText("Viewed product artifact") as HTMLSelectElement).value).toBe("example:design");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps failed and corrected candidate checks bound to their selected version", async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.click(screen.getByRole("button", { name: "Failed check" }));
    expect(screen.getByText("1 of 2 criterion checks passed for this candidate")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Appointment dates stay on the chosen day/u }));
    expect(screen.getByText("The request date is unchanged near midnight")).toBeTruthy();
    await user.click(screen.getByText("Inspect evidence references"));
    expect(screen.getByText("example:check:failed:date")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Corrected candidate" }));
    expect(screen.getByText("2 of 2 criterion checks passed for this candidate")).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Viewed product artifact"), "example:build:failed");
    expect(screen.getByText("1 of 2 criterion checks passed for this candidate")).toBeTruthy();
  });

  it("does not borrow old release checks for the proposed payment scope", async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.click(screen.getByRole("button", { name: "Scope change" }));
    expect(screen.getByText("A released version is available")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Customers can pay online/u })).toBeTruthy();
    expect(screen.queryByText("2 of 2 criterion checks passed for this candidate")).toBeNull();
    await user.selectOptions(screen.getByLabelText("Viewed product artifact"), "example:release");
    const requirements = within(screen.getByRole("region", { name: "Product requirements" }));
    expect(requirements.queryByRole("button", { name: /Customers can pay online/u })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Product" }));
    expect(screen.getByText("Released source")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open pull request" })).toBeNull();
  });

  it("preserves an unavailable capture selection and never fabricates an image", async () => {
    const user = userEvent.setup();
    render(<Example artifactId="example:preview" />);
    expect(screen.getByRole("heading", { name: "This version cannot be read right now" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Captured preview unavailable" })).toBeTruthy();
    await user.click(screen.getByLabelText("Refresh product status"));
    expect((screen.getByLabelText("Viewed product artifact") as HTMLSelectElement).value).toBe("example:preview");
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("link", { name: "Open preview" })).toBeNull();
  });
});

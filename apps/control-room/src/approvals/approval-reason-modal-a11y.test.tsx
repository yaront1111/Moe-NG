import { useState } from "react";

import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, expect, it } from "vitest";

import { ReasonModal } from "./approval-detail-plan.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

function ModalHarness(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">Reject plan…</button>
      {open ? (
        <ReasonModal
          auditEvent="approval.decide"
          body="The plan returns to its author."
          confirmLabel="Reject plan"
          onCancel={() => setOpen(false)}
          onConfirm={() => setOpen(false)}
          scope="plan revision a3f9c2d4 on api-endpnt"
          title="Reject plan — api-endpnt"
        />
      ) : null}
    </>
  );
}

it("opens as a modal on the required reason field", async () => {
  const user = userEvent.setup();
  render(<ModalHarness />);

  await user.click(screen.getByRole("button", { name: "Reject plan…" }));

  const modal = screen.getByRole("dialog");
  const reason = within(modal).getByRole("textbox");
  expect(modal.getAttribute("aria-modal")).toBe("true");
  expect(document.activeElement).toBe(reason);
});

it("contains forward and reverse tab traversal", async () => {
  const user = userEvent.setup();
  render(<ModalHarness />);
  await user.click(screen.getByRole("button", { name: "Reject plan…" }));
  const modal = screen.getByRole("dialog");
  const reason = within(modal).getByRole("textbox");
  const cancel = within(modal).getByRole("button", { name: "Cancel" });

  await user.tab({ shift: true });
  expect(document.activeElement).toBe(cancel);
  await user.tab();
  expect(document.activeElement).toBe(reason);

  await user.type(reason, "scope too wide");
  const confirm = within(modal).getByRole("button", { name: "Reject plan" });
  await user.tab();
  expect(document.activeElement).toBe(confirm);
  await user.tab();
  expect(document.activeElement).toBe(cancel);
  await user.tab();
  expect(document.activeElement).toBe(reason);
});

it("closes on the first Escape and restores the invoking control", async () => {
  const user = userEvent.setup();
  render(<ModalHarness />);
  const invoker = screen.getByRole("button", { name: "Reject plan…" });
  await user.click(invoker);

  await user.keyboard("{Escape}");

  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(invoker);
});

it("restores the invoking control after explicit cancellation", async () => {
  const user = userEvent.setup();
  render(<ModalHarness />);
  const invoker = screen.getByRole("button", { name: "Reject plan…" });
  await user.click(invoker);

  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));

  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(invoker);
});

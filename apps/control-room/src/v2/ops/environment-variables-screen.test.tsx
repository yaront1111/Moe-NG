/**
 * THE ENVIRONMENTS SCREEN. Read this file as an attacker would: its subject is a surface that
 * must never show, keep, or echo the one thing an operator types into it.
 *
 * THE SENTINEL is a string that cannot occur naturally and is not a plausible credential. Epic
 * rail 3 forbids a realistic-looking secret in a committed fixture, and a plausible one would
 * also trip a credential scanner on every clone of this repo.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EnvironmentVariablesOutcome, EnvironmentVariablesView } from "../../live/live-environment-variables.js";
import { ENVIRONMENT_REFUSAL_ADVICE } from "./environment-refusal-words.js";
import { EnvironmentVariablesScreen } from "./environment-variables-screen.js";
import type { EnvironmentWriteOutcome } from "./environment-variables-port.js";
import { environmentTableRows, requiredEnvironmentNames, unsetRequiredCount } from "./environment-variables-model.js";

afterEach(cleanup);

/** Not a credential, and shaped so nothing else in the DOM can collide with it. */
const SENTINEL = "SENTINEL-not-a-secret-0000-1111-2222";
const FINGERPRINT_A = "a1b2c3d4e5f6".padEnd(64, "0");
const FINGERPRINT_B = "9f8e7d6c5b4a".padEnd(64, "0");

const table = (
  variables: readonly { name: string; fingerprintSha256: string }[],
): EnvironmentVariablesView => ({
  environment: "preview",
  status: "ENVIRONMENT_VARIABLES",
  variables: variables.map((entry) => ({
    fingerprintSha256: entry.fingerprintSha256, isSet: true as const,
    name: entry.name, updatedAt: "2026-09-07T09:00:00.000Z",
  })),
});

const REQUIRED = ["DATABASE_URL", "SESSION_KEY"] as const;

interface Recorded { readonly environment: string; readonly name: string; readonly value?: string }

function recordingPort(answer: EnvironmentWriteOutcome): {
  readonly calls: Recorded[];
  readonly port: { set: (e: string, n: string, v: string) => Promise<EnvironmentWriteOutcome>;
    unset: (e: string, n: string) => Promise<EnvironmentWriteOutcome>; };
} {
  const calls: Recorded[] = [];
  return {
    calls,
    port: {
      set: (environment, name, value) => {
        calls.push({ environment, name, value });
        return Promise.resolve(answer);
      },
      unset: (environment, name) => {
        calls.push({ environment, name });
        return Promise.resolve(answer);
      },
    },
  };
}

const renderScreen = (
  outcome: EnvironmentVariablesOutcome | null,
  port: EnvironmentVariablesScreenProps["port"] = null,
  onSettled?: () => void,
): ReturnType<typeof render> => render(
  <EnvironmentVariablesScreen
    environment="preview" onSettled={onSettled} outcome={outcome} port={port}
    requiredNames={[...REQUIRED]}
  />,
);
type EnvironmentVariablesScreenProps = Parameters<typeof EnvironmentVariablesScreen>[0];

/**
 * Types the sentinel into the dialog for `name` and submits it, settling on the ANSWER rather
 * than on the dialog closing.
 *
 * THAT CHOICE IS LOAD-BEARING, and it was made because the mutation drill exposed the weaker
 * version. Waiting for the dialog to disappear makes every arm below red on the WAIT when the
 * screen is mutated to keep the dialog open - so the arms would go red for the right change but
 * at the wrong assertion, and would still be green if the value leaked somewhere the dialog is
 * not. Settling on the answer lets the sentinel search itself be the thing that fails.
 */
async function submitSentinel(name: string): Promise<void> {
  fireEvent.click(screen.getByTestId(`cr.env-vars.set.${name}`));
  fireEvent.change(screen.getByTestId("cr.env-vars.value"), { target: { value: SENTINEL } });
  fireEvent.submit(screen.getByTestId("cr.env-vars.dialog"));
  await waitFor(() => {
    const settled = screen.queryByTestId("cr.env-vars.write-ok")
      ?? screen.queryByTestId("cr.env-vars.write-refusal");
    expect(settled).not.toBeNull();
  });
}

describe("the required-vs-set table", () => {
  it("renders every required name, set or not, with its state", () => {
    renderScreen(table([{ fingerprintSha256: FINGERPRINT_A, name: "DATABASE_URL" }]));
    expect(screen.getByTestId("cr.env-vars.state.DATABASE_URL").textContent).toBe("Set");
    expect(screen.getByTestId("cr.env-vars.state.SESSION_KEY").textContent).toBe("Not set");
    expect(screen.getByTestId("cr.env-vars.required.DATABASE_URL").textContent).toBe("Required");
  });

  it("keeps a SET variable the contract does not require, marked Extra", () => {
    // An operator needs to see what is actually in the environment; an unexpected variable is
    // worth noticing, not hiding.
    renderScreen(table([{ fingerprintSha256: FINGERPRINT_A, name: "LEGACY_TOKEN" }]));
    expect(screen.getByTestId("cr.env-vars.required.LEGACY_TOKEN").textContent).toBe("Extra");
    expect(screen.getByTestId("cr.env-vars.state.LEGACY_TOKEN").textContent).toBe("Set");
  });

  it("puts the UNSET rows first, because those are the ones that fail a deploy", () => {
    renderScreen(table([{ fingerprintSha256: FINGERPRINT_A, name: "DATABASE_URL" }]));
    const rows = [...screen.getByTestId("cr.env-vars.table").querySelectorAll("tr")];
    expect(rows.map((row) => row.getAttribute("data-set"))).toEqual(["false", "true"]);
  });

  it("shows the last update, and Never for a variable that has none", () => {
    renderScreen(table([{ fingerprintSha256: FINGERPRINT_A, name: "DATABASE_URL" }]));
    expect(screen.getByTestId("cr.env-vars.updated.DATABASE_URL").textContent)
      .toBe("2026-09-07T09:00:00.000Z");
    expect(screen.getByTestId("cr.env-vars.updated.SESSION_KEY").textContent).toBe("Never");
  });

  it("states the unset count and names the environment it counts for", () => {
    renderScreen(table([{ fingerprintSha256: FINGERPRINT_A, name: "DATABASE_URL" }]));
    expect(screen.getByTestId("cr.env-vars.summary").textContent)
      .toContain("1 of 2 required variables unset for preview");
  });

  it("renders the read refusal with its code and the layer that refused", () => {
    renderScreen({
      code: "ENV_ENVIRONMENT_UNKNOWN",
      detail: "the environment named is not one this project has",
      layer: "SCOPE", status: "REFUSED",
    });
    const note = screen.getByTestId("cr.env-vars.read-refusal");
    expect(note.textContent).toContain("the environment named is not one this project has");
    expect(note.textContent).toContain("ENV_ENVIRONMENT_UNKNOWN @ SCOPE");
  });
});

describe("THE FINGERPRINT IS LABELLED AS A FINGERPRINT, not shown as a truncated value", () => {
  it("renders the word fingerprint beside the hex, so nobody reads it as part of the secret", () => {
    renderScreen(table([{ fingerprintSha256: FINGERPRINT_A, name: "DATABASE_URL" }]));
    const cell = screen.getByTestId("cr.env-vars.fingerprint.DATABASE_URL");
    expect(cell.textContent).toContain("sha256 fingerprint");
    expect(cell.getAttribute("title")).toContain("It is not part of the value.");
  });

  it("says Not set rather than showing an empty fingerprint", () => {
    renderScreen(table([]));
    expect(screen.getByTestId("cr.env-vars.fingerprint.DATABASE_URL").textContent).toBe("Not set");
  });

  it("tells the operator, in the dialog, that the value cannot be read back", () => {
    renderScreen(table([]), recordingPort({ commandId: "c", ok: true }).port);
    fireEvent.click(screen.getByTestId("cr.env-vars.set.DATABASE_URL"));
    expect(screen.getByTestId("cr.env-vars.dialog-note").textContent)
      .toContain("cannot be read back");
  });
});

describe("the set and unset dialogs reach the port with the right payload", () => {
  it("sends {environment, name, value} on set", async () => {
    const { calls, port } = recordingPort({ commandId: "cmd-1", ok: true });
    renderScreen(table([]), port);
    await submitSentinel("DATABASE_URL");
    expect(calls).toEqual([{ environment: "preview", name: "DATABASE_URL", value: SENTINEL }]);
    expect(screen.getByTestId("cr.env-vars.write-ok")).toBeTruthy();
  });

  it("offers Unset only for a variable that is SET, and sends {environment, name}", async () => {
    const { calls, port } = recordingPort({ commandId: "cmd-2", ok: true });
    renderScreen(table([{ fingerprintSha256: FINGERPRINT_A, name: "DATABASE_URL" }]), port);
    expect(screen.queryByTestId("cr.env-vars.unset.SESSION_KEY")).toBeNull();
    fireEvent.click(screen.getByTestId("cr.env-vars.unset.DATABASE_URL"));
    await waitFor(() => { expect(calls.length).toBe(1); });
    expect(calls).toEqual([{ environment: "preview", name: "DATABASE_URL" }]);
  });

  it("renders no write control at all with no attached session", () => {
    renderScreen(table([]), null);
    fireEvent.click(screen.getByTestId("cr.env-vars.set.DATABASE_URL"));
    fireEvent.change(screen.getByTestId("cr.env-vars.value"), { target: { value: SENTINEL } });
    fireEvent.submit(screen.getByTestId("cr.env-vars.dialog"));
    // No port, so nothing is spent and nothing is claimed to have been stored.
    expect(screen.queryByTestId("cr.env-vars.write-ok")).toBeNull();
  });

  it("re-reads after a settled write, so the fingerprint shown is the daemon new one", async () => {
    const onSettled = vi.fn();
    const { port } = recordingPort({ commandId: "cmd-3", ok: true });
    renderScreen(table([]), port, onSettled);
    await submitSentinel("DATABASE_URL");
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});

describe("the pure model the table and the goal card share", () => {
  it("counts only REQUIRED-and-unset rows, never an extra one", () => {
    const rows = environmentTableRows(
      table([{ fingerprintSha256: FINGERPRINT_A, name: "LEGACY_TOKEN" }]), [...REQUIRED]);
    expect(unsetRequiredCount(rows)).toBe(2);
    expect(rows.find((row) => row.name === "LEGACY_TOKEN")?.required).toBe(false);
  });

  it("reads required names from deploymentRequirements only, deduped and sorted", () => {
    const revision = {
      deploymentRequirements: [
        { environmentVariableNames: ["SESSION_KEY", "DATABASE_URL"] },
        { environmentVariableNames: ["DATABASE_URL"] },
        { },
      ],
    } as unknown as Parameters<typeof requiredEnvironmentNames>[0];
    expect(requiredEnvironmentNames(revision)).toEqual(["DATABASE_URL", "SESSION_KEY"]);
  });

  it("treats a REFUSED read as no set names rather than as an empty environment", () => {
    const refused: EnvironmentVariablesOutcome = {
      code: "ENV_STORE_KEY_UNAVAILABLE", detail: "d", layer: "KEY", status: "REFUSED",
    };
    expect(unsetRequiredCount(environmentTableRows(refused, [...REQUIRED]))).toBe(2);
  });
});

/**
 * THE CENTRAL ARM. Every state the screen can be in, searched for the sentinel across the WHOLE
 * rendered container - not a chosen node. An assertion scoped to the input would miss the value
 * re-rendered anywhere else, which is precisely the failure mode being guarded.
 *
 * `container.innerHTML` is searched rather than `textContent` on purpose: it carries every
 * ATTRIBUTE too, so a value that reached `value=`, `title=`, `data-*` or an aria label is caught
 * even though nothing paints it. That is the devtools-visible surface (d).
 */
describe("NO VALUE IS EVER RENDERED OR RETAINED", () => {
  /** Every string the DOM could carry, attributes included, plus every React prop in the tree. */
  const domText = (container: HTMLElement): string => container.innerHTML;

  /**
   * The rendered React tree's own props, walked off the fiber the way a devtools inspector
   * reads them. A value passed down as a prop is visible there even when no node paints it, so
   * `innerHTML` alone would not see it.
   */
  function fiberProps(container: HTMLElement): string {
    const seen = new Set<unknown>();
    const collected: unknown[] = [];
    const walk = (node: unknown, depth: number): void => {
      if (depth > 40 || node === null || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      for (const value of Object.values(node as Record<string, unknown>)) {
        if (typeof value === "string") collected.push(value);
        else if (typeof value === "object") walk(value, depth + 1);
      }
    };
    for (const element of [container, ...container.querySelectorAll("*")]) {
      for (const key of Object.keys(element)) {
        if (key.startsWith("__react")) {
          walk((element as unknown as Record<string, unknown>)[key], 0);
        }
      }
    }
    return JSON.stringify(collected);
  }

  const CONTROL = "the search technique itself finds a planted sentinel";

  it(CONTROL, () => {
    // POSITIVE CONTROL. Without this, every `not.toContain` below proves the technique works no
    // better than it proves the screen is clean.
    const { container } = render(<p data-testid="planted" title={SENTINEL}>{SENTINEL}</p>);
    expect(domText(container)).toContain(SENTINEL);
  });

  it("finds a planted nested child prop even when the DOM never renders it", () => {
    function PropOnlyChild(_props: { readonly nested: { readonly value: string } }) {
      return <span>Nothing sensitive rendered</span>;
    }
    const { container } = render(<PropOnlyChild nested={{ value: SENTINEL }} />);
    expect(domText(container)).not.toContain(SENTINEL);
    expect(fiberProps(container)).toContain(SENTINEL);
  });

  it("(a) does not carry the sentinel anywhere after a SUCCESSFUL submit", async () => {
    const { port } = recordingPort({ commandId: "cmd-ok", ok: true });
    const { container } = renderScreen(table([]), port);
    await submitSentinel("DATABASE_URL");
    expect(domText(container)).not.toContain(SENTINEL);
    expect(fiberProps(container)).not.toContain(SENTINEL);
    // And specifically not in the cells an operator would screenshot.
    expect(screen.getByTestId("cr.env-vars.write-ok").textContent).not.toContain(SENTINEL);
    expect(screen.getByTestId("cr.env-vars.summary").textContent).not.toContain(SENTINEL);
  });

  it("(a) does not carry the sentinel in the fingerprint cell once the read reports it set", async () => {
    const { port } = recordingPort({ commandId: "cmd-ok", ok: true });
    const { container, rerender } = renderScreen(table([]), port);
    await submitSentinel("DATABASE_URL");
    rerender(
      <EnvironmentVariablesScreen
        environment="preview" outcome={table([{ fingerprintSha256: FINGERPRINT_B, name: "DATABASE_URL" }])}
        port={port} requiredNames={[...REQUIRED]}
      />,
    );
    const cell = screen.getByTestId("cr.env-vars.fingerprint.DATABASE_URL");
    expect(cell.textContent).not.toContain(SENTINEL);
    expect(cell.getAttribute("data-fingerprint")).toBe(FINGERPRINT_B);
    expect(domText(container)).not.toContain(SENTINEL);
  });

  /**
   * (b) THE ONE. Echoing the typed value back so the operator can correct it is the natural,
   * helpful-looking behaviour, and it is exactly how a secret reaches a screenshot.
   */
  it("(b) does NOT repopulate the input, and holds no sentinel, after a FAILED submit", async () => {
    const { port } = recordingPort({
      code: "ENV_VALUE_TOO_LARGE",
      detail: "the value exceeds the permitted size for an environment variable",
      layer: "VALUE", ok: false,
    });
    const { container } = renderScreen(table([]), port);
    await submitSentinel("DATABASE_URL");
    // The refusal really happened - otherwise "no sentinel" is satisfied by an idle screen.
    expect(screen.getByTestId("cr.env-vars.write-refusal").textContent)
      .toContain("ENV_VALUE_TOO_LARGE @ VALUE");
    expect(domText(container)).not.toContain(SENTINEL);
    expect(fiberProps(container)).not.toContain(SENTINEL);
    // The cleared dialog is gone; retrying must never restore the previous value.
    expect(screen.queryByTestId("cr.env-vars.dialog")).toBeNull();
    // Reopening the dialog to retry gives an EMPTY field, never the previous attempt.
    fireEvent.click(screen.getByTestId("cr.env-vars.set.DATABASE_URL"));
    expect((screen.getByTestId("cr.env-vars.value") as HTMLInputElement).value).toBe("");
    expect(domText(container)).not.toContain(SENTINEL);
  });

  it("(b) holds no sentinel after an UNDELIVERED submit either", async () => {
    // A thrown dispatch takes a different branch of settle(); the value must die on that one too.
    const port = {
      set: (): Promise<EnvironmentWriteOutcome> => Promise.reject(new Error("offline")),
      unset: (): Promise<EnvironmentWriteOutcome> => Promise.reject(new Error("offline")),
    };
    const { container } = renderScreen(table([]), port);
    await submitSentinel("DATABASE_URL");
    expect(screen.getByTestId("cr.env-vars.write-refusal").textContent)
      .toContain("ENVIRONMENT_WRITE_UNDELIVERED @ CONTROL_ROOM_ENVIRONMENT_WRITE");
    expect(domText(container)).not.toContain(SENTINEL);
    expect(fiberProps(container)).not.toContain(SENTINEL);
  });

  it("(c) carries no sentinel in ANY of the four refusal messages", async () => {
    for (const refusal of [
      { code: "ENV_NAME_INVALID", layer: "NAME" },
      { code: "ENV_VALUE_TOO_LARGE", layer: "VALUE" },
      { code: "ENV_ENVIRONMENT_UNKNOWN", layer: "SCOPE" },
      { code: "ENV_STORE_KEY_UNAVAILABLE", layer: "KEY" },
    ] as const) {
      const { port } = recordingPort({ ...refusal, detail: `refused at ${refusal.layer}`, ok: false });
      const { container, unmount } = renderScreen(table([]), port);
      await submitSentinel("DATABASE_URL");
      const note = screen.getByTestId("cr.env-vars.write-refusal");
      expect(note.textContent, refusal.code).toContain(refusal.code);
      expect(note.textContent, refusal.code).not.toContain(SENTINEL);
      expect(domText(container), refusal.code).not.toContain(SENTINEL);
      unmount();
    }
  });

  it("(d) never hands the value to a child as a prop, at any depth", async () => {
    // Asserted against the fiber tree rather than the painted text: a value passed down is
    // visible in a devtools inspector even when nothing renders it.
    const { port } = recordingPort({ commandId: "cmd-ok", ok: true });
    const { container } = renderScreen(table([]), port);
    fireEvent.click(screen.getByTestId("cr.env-vars.set.DATABASE_URL"));
    fireEvent.change(screen.getByTestId("cr.env-vars.value"), { target: { value: SENTINEL } });
    // The field owns the typed bytes. The walker also reaches live DOM refs, so the separate
    // planted-child control proves sensitivity to prop leaks without mistaking this for one.
    expect((screen.getByTestId("cr.env-vars.value") as HTMLInputElement).value).toBe(SENTINEL);
    expect(fiberProps(container)).toContain(SENTINEL);
    fireEvent.submit(screen.getByTestId("cr.env-vars.dialog"));
    await waitFor(() => { expect(screen.queryByTestId("cr.env-vars.dialog")).toBeNull(); });
    expect(fiberProps(container)).not.toContain(SENTINEL);
  });

  it("clears the input before dispatch while delivering the original bytes exactly once", async () => {
    const typed = `  ${SENTINEL}  `;
    const calls: Recorded[] = [];
    const atDispatch: string[] = [];
    let input!: HTMLInputElement;
    let release!: (answer: EnvironmentWriteOutcome) => void;
    const pending = new Promise<EnvironmentWriteOutcome>((resolve) => { release = resolve; });
    const port = {
      set(environment: string, name: string, value: string): Promise<EnvironmentWriteOutcome> {
        atDispatch.push(input.value);
        calls.push({ environment, name, value });
        return pending;
      },
      unset: async (): Promise<EnvironmentWriteOutcome> => ({ commandId: "unused", ok: true }),
    };
    const { container } = renderScreen(table([]), port);
    fireEvent.click(screen.getByTestId("cr.env-vars.set.DATABASE_URL"));
    input = screen.getByTestId("cr.env-vars.value") as HTMLInputElement;
    fireEvent.change(input, { target: { value: typed } });
    fireEvent.submit(screen.getByTestId("cr.env-vars.dialog"));
    expect(atDispatch).toEqual([""]);
    expect(calls).toEqual([{ environment: "preview", name: "DATABASE_URL", value: typed }]);
    expect(input.value).toBe("");
    expect(fiberProps(container)).not.toContain(SENTINEL);
    fireEvent.submit(screen.getByTestId("cr.env-vars.dialog"));
    expect(calls).toEqual([{ environment: "preview", name: "DATABASE_URL", value: typed }]);
    await act(async () => { release({ commandId: "stored", ok: true }); });
    expect(input.isConnected).toBe(false);
    expect(input.value).toBe("");
    expect(fiberProps(container)).not.toContain(SENTINEL);
  });

  it.each(["cancel", "unmount"] as const)("clears a saved detached input on %s", (ending) => {
    const { calls, port } = recordingPort({ commandId: "unused", ok: true });
    const { container, unmount } = renderScreen(table([]), port);
    fireEvent.click(screen.getByTestId("cr.env-vars.set.DATABASE_URL"));
    const input = screen.getByTestId("cr.env-vars.value") as HTMLInputElement;
    fireEvent.change(input, { target: { value: SENTINEL } });
    expect(input.value).toBe(SENTINEL);
    if (ending === "cancel") fireEvent.click(screen.getByTestId("cr.env-vars.cancel"));
    else unmount();
    expect(input.isConnected).toBe(false);
    expect(input.value).toBe("");
    expect(fiberProps(container)).not.toContain(SENTINEL);
    expect(calls).toEqual([]);
  });

  it.each(["variable", "environment"] as const)("clears the old input when the %s changes", async (scope) => {
    const { calls, port } = recordingPort({ commandId: "stored", ok: true });
    const { container, rerender } = renderScreen(table([]), port);
    fireEvent.click(screen.getByTestId("cr.env-vars.set.DATABASE_URL"));
    const previousInput = screen.getByTestId("cr.env-vars.value") as HTMLInputElement;
    fireEvent.change(previousInput, { target: { value: SENTINEL } });
    if (scope === "variable") fireEvent.click(screen.getByTestId("cr.env-vars.set.SESSION_KEY"));
    else rerender(
      <EnvironmentVariablesScreen
        environment="production" outcome={{ ...table([]), environment: "production" }}
        port={port} requiredNames={[...REQUIRED]}
      />,
    );
    const input = screen.getByTestId("cr.env-vars.value") as HTMLInputElement;
    expect(input).not.toBe(previousInput);
    expect(previousInput.isConnected).toBe(false);
    expect(previousInput.value).toBe("");
    expect(input.value).toBe("");
    expect(fiberProps(container)).not.toContain(SENTINEL);
    expect(calls).toEqual([]);
    fireEvent.change(input, { target: { value: "new-target-value" } });
    fireEvent.submit(screen.getByTestId("cr.env-vars.dialog"));
    await waitFor(() => { expect(screen.getByTestId("cr.env-vars.write-ok")).not.toBeNull(); });
    expect(calls).toEqual([{
      environment: scope === "environment" ? "production" : "preview",
      name: scope === "variable" ? "SESSION_KEY" : "DATABASE_URL",
      value: "new-target-value",
    }]);
  });

  it("reports a synchronous port throw as undelivered without retaining the input", async () => {
    const port = {
      set(): never { throw new Error("dispatch unavailable"); },
      unset(): never { throw new Error("dispatch unavailable"); },
    };
    const { container } = renderScreen(table([]), port);
    await submitSentinel("DATABASE_URL");
    expect(screen.getByTestId("cr.env-vars.write-refusal").textContent)
      .toContain("ENVIRONMENT_WRITE_UNDELIVERED @ CONTROL_ROOM_ENVIRONMENT_WRITE");
    expect(fiberProps(container)).not.toContain(SENTINEL);
    expect(screen.queryByTestId("cr.env-vars.dialog")).toBeNull();
  });

  it("keeps no sentinel in browser-local storage, on any path", async () => {
    const { port } = recordingPort({ code: "ENV_NAME_INVALID", detail: "d", layer: "NAME", ok: false });
    renderScreen(table([]), port);
    await submitSentinel("DATABASE_URL");
    const stored = [
      ...Object.entries(globalThis.localStorage ?? {}),
      ...Object.entries(globalThis.sessionStorage ?? {}),
    ];
    expect(JSON.stringify(stored)).not.toContain(SENTINEL);
  });

  it("keeps the field off autofill and off the screen while it is typed", () => {
    renderScreen(table([]), recordingPort({ commandId: "c", ok: true }).port);
    fireEvent.click(screen.getByTestId("cr.env-vars.set.DATABASE_URL"));
    const field = screen.getByTestId("cr.env-vars.value") as HTMLInputElement;
    expect(field.getAttribute("type")).toBe("password");
    expect(field.getAttribute("autocomplete")).toBe("off");
    expect(field.getAttribute("spellcheck")).toBe("false");
  });

  it("associates each environment dialog label with its own password input", () => {
    const { port } = recordingPort({ commandId: "unused", ok: true });
    const { container } = render(
      <>
        <EnvironmentVariablesScreen environment="preview" outcome={table([])} port={port} requiredNames={[...REQUIRED]} />
        <EnvironmentVariablesScreen environment="production" outcome={table([])} port={port} requiredNames={[...REQUIRED]} />
      </>,
    );
    const buttons = container.querySelectorAll('[data-testid="cr.env-vars.set.DATABASE_URL"]');
    expect(buttons).toHaveLength(2);
    for (const button of buttons) fireEvent.click(button);
    const labels = [...container.querySelectorAll("label")];
    const inputs = [...container.querySelectorAll("input")];
    expect(labels).toHaveLength(2);
    expect(inputs).toHaveLength(2);
    for (let index = 0; index < labels.length; index += 1) expect(labels[index]?.control).toBe(inputs[index]);
  });
});

/**
 * THE FINGERPRINT IS THE OPERATOR'S ONLY CONFIRMATION AN UPDATE TOOK, because the value can never
 * be read back. So it is not enough that something re-rendered: the shown fingerprint must be the
 * one the DAEMON returned, and it must differ from the one before.
 */
describe("the fingerprint CHANGES after an update, and is the daemon new one", () => {
  it("moves from the old fingerprint to exactly the one the read returned", async () => {
    const { port } = recordingPort({ commandId: "cmd-fp", ok: true });
    const before = table([{ fingerprintSha256: FINGERPRINT_A, name: "DATABASE_URL" }]);
    const after = table([{ fingerprintSha256: FINGERPRINT_B, name: "DATABASE_URL" }]);
    const { rerender } = renderScreen(before, port);
    const shown = (): string => screen.getByTestId("cr.env-vars.fingerprint.DATABASE_URL")
      .getAttribute("data-fingerprint") ?? "";
    expect(shown()).toBe(FINGERPRINT_A);
    await submitSentinel("DATABASE_URL");
    rerender(
      <EnvironmentVariablesScreen
        environment="preview" outcome={after} port={port} requiredNames={[...REQUIRED]}
      />,
    );
    // BOTH halves: it differs from before, AND it equals what the read returned. "It changed"
    // alone would be satisfied by a re-render that scrambled it.
    expect(shown()).not.toBe(FINGERPRINT_A);
    expect(shown()).toBe(FINGERPRINT_B);
    // And the visible text moved too, still carrying the word.
    expect(screen.getByTestId("cr.env-vars.fingerprint.DATABASE_URL").textContent)
      .toBe(`sha256 fingerprint ${FINGERPRINT_B.slice(0, 12)}`);
  });

  it("goes from a fingerprint back to Not set after an unset", async () => {
    const { port } = recordingPort({ commandId: "cmd-unset", ok: true });
    const { rerender } = renderScreen(
      table([{ fingerprintSha256: FINGERPRINT_A, name: "DATABASE_URL" }]), port);
    fireEvent.click(screen.getByTestId("cr.env-vars.unset.DATABASE_URL"));
    await waitFor(() => { expect(screen.queryByTestId("cr.env-vars.write-ok")).not.toBeNull(); });
    rerender(
      <EnvironmentVariablesScreen
        environment="preview" outcome={table([])} port={port} requiredNames={[...REQUIRED]}
      />,
    );
    expect(screen.getByTestId("cr.env-vars.fingerprint.DATABASE_URL").textContent).toBe("Not set");
    expect(screen.getByTestId("cr.env-vars.state.DATABASE_URL").textContent).toBe("Not set");
  });
});

/**
 * THE FOUR REFUSALS, each with the code AND the layer that answered. The layers are child 1's
 * CLOSED map (`ENVIRONMENT_CODE_LAYERS` in apps/daemon/src/environment/environment-contracts.ts),
 * reused rather than restated as a second authority; the details are that module's fixed prose,
 * copied verbatim so a change to it reds this file.
 */
describe("all four refusals render VERBATIM with their codes and their layers", () => {
  const REFUSALS = [
    {
      code: "ENV_ENVIRONMENT_UNKNOWN", layer: "SCOPE",
      detail: "the environment named is not one this project has",
      advice: "Pick one of the environments this project has.",
    },
    {
      code: "ENV_NAME_INVALID", layer: "NAME",
      detail: "the variable name is not a permitted environment variable name",
      advice: "Use an uppercase letter first",
    },
    {
      code: "ENV_STORE_KEY_UNAVAILABLE", layer: "KEY",
      detail: "the environment store key could not be derived from the daemon credential",
      advice: "Check the daemon credential is set and restart it",
    },
    {
      code: "ENV_VALUE_TOO_LARGE", layer: "VALUE",
      detail: "the value exceeds the permitted size for an environment variable",
      advice: "Shorten the value to under 4096 bytes.",
    },
  ] as const;

  it("covers exactly the four ENV_ codes the daemon closed roster carries, no fifth", () => {
    // BIDIRECTIONAL against the advice map, restricted to the store's own ENV_ namespace: every
    // ENV_ code advised is covered here, and every ENV_ code covered here is advised. A fifth
    // store code minted on either side reds.
    expect(REFUSALS.map((entry) => entry.code).toSorted()).toEqual(
      Object.keys(ENVIRONMENT_REFUSAL_ADVICE).filter((code) => code.startsWith("ENV_")).toSorted());
  });

  it("advises the AUTHORIZATION fence too, and that is the only non-ENV_ entry", () => {
    // Named explicitly rather than left to the filter above, so the exception cannot grow
    // silently: a second non-ENV_ entry appearing here reds.
    expect(Object.keys(ENVIRONMENT_REFUSAL_ADVICE).filter((code) => !code.startsWith("ENV_")))
      .toEqual(["OPERATOR_PRINCIPAL_REQUIRED"]);
  });

  /**
   * MEASURED AGAINST A REAL DAEMON by tests/e2e/control-room/environment-variables.spec.ts: both
   * environment kinds sit in `OPERATOR_PRINCIPAL_KINDS` and are absent from the widening that
   * lets a paired browser spend `repository.publish`. So a paired session READS this table
   * (it holds ADMIN) and cannot WRITE it.
   */
  it("renders OPERATOR_PRINCIPAL_REQUIRED with words that name the real cause", async () => {
    const { port } = recordingPort({
      code: "OPERATOR_PRINCIPAL_REQUIRED",
      detail: "this command requires the configured operator principal",
      layer: "DAEMON_AUTHORIZATION", ok: false,
    });
    renderScreen(table([]), port);
    await submitSentinel("DATABASE_URL");
    const note = screen.getByTestId("cr.env-vars.write-refusal");
    expect(note.textContent).toContain("OPERATOR_PRINCIPAL_REQUIRED @ DAEMON_AUTHORIZATION");
    expect(note.textContent).toContain("Set it from the daemon host instead");
    // It must NOT read as a variable-name problem, which is the obvious wrong guess.
    expect(note.textContent).not.toContain("uppercase letter");
    expect(note.textContent).not.toContain(SENTINEL);
  });

  for (const refusal of REFUSALS) {
    it(`renders ${refusal.code} with its detail, its layer and words that say what to do`, async () => {
      const { port } = recordingPort({ code: refusal.code, detail: refusal.detail, layer: refusal.layer, ok: false });
      renderScreen(table([]), port);
      await submitSentinel("DATABASE_URL");
      const note = screen.getByTestId("cr.env-vars.write-refusal");
      // THE CODE AND THE LAYER, not merely that it refused: four authorities can answer and an
      // arm checking only "not ok" stays green when a different one starts answering.
      expect(note.textContent).toContain(`${refusal.code} @ ${refusal.layer}`);
      // The daemon's own prose, VERBATIM.
      expect(note.textContent).toContain(refusal.detail);
      // Operator words beside it.
      expect(note.textContent).toContain(refusal.advice);
      // AND NEVER THE SUBMITTED VALUE.
      expect(note.textContent).not.toContain(SENTINEL);
      expect(note.getAttribute("role")).toBe("alert");
    });
  }

  /**
   * ENV_VALUE_TOO_LARGE IS THE TRAP. The natural message names the size and quotes the offending
   * input; the daemon's detail is asserted DIGIT-FREE for exactly that reason, so the limit has to
   * come from a constant on this side.
   */
  it("reports the LIMIT for ENV_VALUE_TOO_LARGE, never the value or its size", async () => {
    const { port } = recordingPort({
      code: "ENV_VALUE_TOO_LARGE",
      detail: "the value exceeds the permitted size for an environment variable",
      layer: "VALUE", ok: false,
    });
    renderScreen(table([]), port);
    await submitSentinel("DATABASE_URL");
    const text = screen.getByTestId("cr.env-vars.write-refusal").textContent ?? "";
    expect(text).toContain("under 4096 bytes");
    expect(text).not.toContain(SENTINEL);
    // The only digits in the message are the LIMIT: the submitted length never appears.
    expect(text).not.toContain(String(SENTINEL.length));
    expect(ENVIRONMENT_REFUSAL_ADVICE["ENV_VALUE_TOO_LARGE"]).not.toContain(SENTINEL);
  });

  it("falls back to the daemon prose for a code it has no advice for, without inventing one", async () => {
    // A code outside the closed roster (a transport failure, say) must still render its own code
    // and layer rather than be dressed up as one of the four.
    const { port } = recordingPort({ code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_TRANSPORT", ok: false });
    renderScreen(table([]), port);
    await submitSentinel("DATABASE_URL");
    const note = screen.getByTestId("cr.env-vars.write-refusal");
    expect(note.textContent).toContain("TRANSPORT_REQUEST_FAILED @ CONTROL_ROOM_TRANSPORT");
    expect(note.textContent).not.toContain("Shorten the value");
  });
});

export { FINGERPRINT_A, FINGERPRINT_B, REQUIRED, SENTINEL, recordingPort, renderScreen, submitSentinel, table };

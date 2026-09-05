import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { credentialSource, credentialSourceWords } from "./resources-credential.js";
import {
  CREDENTIAL_VALUE, HEAD_SHA, REMOTE_URL, REPO_ROOT, STORE_PATH, activation, allRead,
  withProviderReceipt,
} from "./resources-frames.fixture.js";
import { ResourcesScreen } from "./resources-screen.js";
import type { ResourceReads } from "./resources-model.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

/**
 * THE FACTS, THE ROWS, AND THE CREDENTIAL CLAUSE. Every frame reaches the screen through
 * the production decoder (see resources-frames.fixture.ts), so a drifted fixture reds at
 * the decode rather than quietly rendering refusal rows.
 */
export const valueOf = (id: string): string =>
  screen.getByTestId(`cr.resources.value.${id}`).textContent ?? "";

describe("resources screen, the project's measured facts", () => {
  it("renders each named fact's value from the read that carries it", () => {
    render(<ResourcesScreen reads={allRead()} />);
    expect(valueOf("repository.root")).toBe(REPO_ROOT);
    expect(valueOf("repository.head")).toBe(HEAD_SHA);
    expect(valueOf("repository.remote")).toBe(REMOTE_URL);
    expect(valueOf("provider.cli")).toBe("claude");
    expect(valueOf("store.path")).toBe(STORE_PATH);
    expect(valueOf("store.distribution")).toBe(`SOURCE_CHECKOUT at ${REPO_ROOT}`);
    expect(valueOf("governance.policy")).toBe("7");
    expect(valueOf("governance.seatlimit")).toBe("4");
    expect(valueOf("governance.seatsactive")).toBe("2");
  });

  it("puts one fact on each row, and every row inside its section", () => {
    render(<ResourcesScreen reads={allRead()} />);
    for (const [section, ids] of [
      ["repository", ["root", "head", "branch", "remote"]],
      ["provider", ["cli", "credential"]],
      ["store", ["path", "size", "backup", "distribution"]],
      ["governance", ["policy", "seatlimit", "seatsactive"]],
    ] as const) {
      const panel = screen.getByTestId(`cr.resources.section.${section}`);
      const rows = [...panel.querySelectorAll("[data-testid^='cr.resources.fact.']")];
      expect(rows.map((row) => row.getAttribute("data-testid")))
        .toEqual(ids.map((id) => `cr.resources.fact.${section}.${id}`));
      for (const row of rows) expect(row.querySelectorAll("dt")).toHaveLength(1);
    }
  });

  it("states a fact no read serves rather than omitting it", () => {
    render(<ResourcesScreen reads={allRead()} />);
    for (const id of ["repository.branch", "store.size"]) {
      expect(screen.getByTestId(`cr.resources.fact.${id}`).getAttribute("data-state")).toBe("REFUSED");
      expect(screen.getByTestId(`cr.resources.refusal.${id}`).textContent)
        .toContain("RESOURCES_FACT_NOT_SERVED @ CONTROL_ROOM_RESOURCES");
    }
  });

  it("reads pending until a read answers, without dropping the row", () => {
    render(<ResourcesScreen reads={{
      activation: null, health: null, policy: null, remote: null, sessions: null,
    }} />);
    expect(screen.getByTestId("cr.resources.pending.repository.root")).toBeTruthy();
    expect(screen.getByTestId("cr.resources.fact.provider.cli")).toBeTruthy();
    expect(screen.getByTestId("cr.resources.banner").textContent)
      .toBe("Reading this project's resources...");
  });
});

/**
 * THE CREDENTIAL CLAUSE. The one property on this screen that cannot be fixed after
 * the fact: a token in an operator's screenshot cannot be recalled, and a Resources
 * page is exactly the surface someone pastes into a bug report.
 *
 * These arms are HOSTILE. Each builds a frame whose provider section carries a
 * credential-shaped value in a field a naive render would reach for, sends it through
 * the production decoder, renders, and then greps the rendered output - textContent AND
 * innerHTML, so a value hidden in an attribute or a title still counts - for that value.
 * Zero occurrences is the pass. `renderedText()` also asserts the haystack is non-empty,
 * so "the value is absent" can never be satisfied by nothing having rendered.
 */
/** Everything the operator could see or copy: visible text plus the serialised markup. */
function renderedText(): string {
  const root = screen.getByTestId("cr.resources.screen");
  const text = `${root.textContent ?? ""}\n${root.innerHTML}\n${document.body.innerHTML}`;
  expect(text.length).toBeGreaterThan(200);
  return text;
}

describe("resources screen never renders a credential value", () => {
  it("renders the SOURCE and not the value when a value rides in on the receipt's prose", () => {
    // The MEASURED leak activation-read.ts:113-131 exists to stop: a git stderr tail that
    // echoed the environment. Here it arrives at the browser unscrubbed anyway, and the
    // ref is the well-formed one, so the source IS renderable and the value is beside it.
    const reads = allRead();
    const poisoned: ResourceReads = {
      ...reads,
      activation: activation(withProviderReceipt({
        code: null, hash: CREDENTIAL_VALUE, layer: null, measured: true, member: "provider",
        reason: `fatal: env ANTHROPIC_AUTH_TOKEN=${CREDENTIAL_VALUE}`,
        ref: "credential/claude/env:ANTHROPIC_AUTH_TOKEN",
      })),
    };
    render(<ResourcesScreen reads={poisoned} />);

    const rendered = renderedText();
    // THE GREP: zero occurrences, anywhere an operator could see or copy it.
    expect(rendered.split(CREDENTIAL_VALUE)).toHaveLength(1);
    expect(rendered).not.toContain(CREDENTIAL_VALUE);
    // ...while the SOURCE is present, so this is not passing by rendering nothing.
    expect(valueOf("provider.cli")).toBe("claude");
    expect(valueOf("provider.credential")).toBe("the ANTHROPIC_AUTH_TOKEN environment variable");
    expect(rendered).toContain("ANTHROPIC_AUTH_TOKEN");
  });

  it("refuses with a code, rather than rendering it, when the value rides in on the ref", () => {
    const reads = allRead();
    const poisoned: ResourceReads = {
      ...reads,
      activation: activation(withProviderReceipt({
        code: null, hash: null, layer: null, measured: true, member: "provider",
        reason: "claude is on PATH", ref: `credential/claude/env:${CREDENTIAL_VALUE}`,
      })),
    };
    render(<ResourcesScreen reads={poisoned} />);

    const rendered = renderedText();
    expect(rendered).not.toContain(CREDENTIAL_VALUE);
    // The grammar failed CLOSED: the row states a code where the source would have gone.
    for (const id of ["provider.cli", "provider.credential"]) {
      expect(screen.queryByTestId(`cr.resources.value.${id}`)).toBeNull();
      expect(screen.getByTestId(`cr.resources.refusal.${id}`).textContent)
        .toContain("RESOURCES_CREDENTIAL_SOURCE_UNRECOGNISED @ CONTROL_ROOM_RESOURCES");
    }
    // Every other fact still renders: failing closed on the provider blanks nothing else.
    expect(valueOf("store.path")).toBe(STORE_PATH);
  });

  it("renders a sign-in file as a source without naming any path beyond the daemon's word", () => {
    const reads = allRead();
    render(<ResourcesScreen reads={{
      ...reads,
      activation: activation(withProviderReceipt({
        code: null, hash: null, layer: null, measured: true, member: "provider",
        reason: `signed in; token ${CREDENTIAL_VALUE}`, ref: "credential/codex/login-file",
      })),
    }} />);

    expect(renderedText()).not.toContain(CREDENTIAL_VALUE);
    expect(valueOf("provider.cli")).toBe("codex");
    expect(valueOf("provider.credential")).toBe("a signed-in credential file on this host");
  });
});

/**
 * The grammar itself, against the production surface rather than a reimplementation.
 * The sweep asserts it actually generated cases, so a sweep that silently yields none
 * cannot pass.
 */
describe("the credential grammar fails closed", () => {
  it("accepts exactly the three forms the daemon writes", () => {
    expect(credentialSource("credential/claude/env:ANTHROPIC_AUTH_TOKEN"))
      .toEqual({ cli: "claude", source: "env:ANTHROPIC_AUTH_TOKEN" });
    expect(credentialSource("credential/codex/login-file"))
      .toEqual({ cli: "codex", source: "login-file" });
    expect(credentialSource("credential/some-cli/ungated"))
      .toEqual({ cli: "some-cli", source: "ungated" });
  });

  it("yields null for every shape that is not one of them, values included", () => {
    const rejected = [
      null,
      "",
      `credential/claude/env:${CREDENTIAL_VALUE}`,
      `credential/claude/${CREDENTIAL_VALUE}`,
      CREDENTIAL_VALUE,
      "credential/claude/env:ANTHROPIC_AUTH_TOKEN=secret",
      "credential/claude/env:lowercase",
      "credential/claude/login-file/extra",
      "credential/claude/env:TOKEN\nsecret",
      "prefix/credential/claude/login-file",
    ];
    expect(rejected.length).toBeGreaterThan(5);
    for (const ref of rejected) expect(credentialSource(ref), String(ref)).toBeNull();
  });

  it("words a source without ever echoing anything but the name it was given", () => {
    expect(credentialSourceWords("env:ANTHROPIC_AUTH_TOKEN"))
      .toBe("the ANTHROPIC_AUTH_TOKEN environment variable");
    expect(credentialSourceWords("login-file")).toBe("a signed-in credential file on this host");
    expect(credentialSourceWords("ungated")).toBe("no credential gate for this command");
  });
});

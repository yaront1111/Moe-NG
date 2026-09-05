/**
 * WHICH COMMAND SERVES THE PRODUCT, and where the browser is pointed.
 *
 * Every fallback arm asserts WHICH script ran (`plan.source`), never merely that resolution
 * succeeded: an arm that only checked "a command came back" passes on all six orderings of
 * `preview`/`dev`/`start` and would not notice the order being reversed. All three pairings are
 * covered, so no single swap survives.
 */
import { describe, expect, it } from "vitest";

import {
  PREVIEW_SCRIPT_ORDER, detectPreviewPort, previewOrigin, resolvePreviewCommand,
} from "./preview-command-resolution.js";
import type { PreviewContractFacts } from "./preview-command-resolution.js";
import { PREVIEW_CODE_LAYERS, isPreviewRefusal } from "./preview-contracts.js";

const run = (name: string): string => `npm run ${name}`;

const facts = (
  deploymentStatements: readonly string[],
  journeys: readonly { readonly journeyId: string; readonly statement: string }[] = [],
): PreviewContractFacts => ({ deploymentStatements, journeys });

/** The resolved plan, or a thrown refusal code so an arm cannot silently read `undefined`. */
function plan(
  contract: PreviewContractFacts | null, scripts: Readonly<Record<string, unknown>> | null,
): ReturnType<typeof resolvePreviewCommand> extends never ? never : {
  command: string; port: number | null; source: string;
} {
  const resolved = resolvePreviewCommand(contract, scripts, run);
  if (isPreviewRefusal(resolved)) throw new Error(`refused ${resolved.code}`);
  return resolved.plan;
}

describe("the preview command's fallback order", () => {
  it("prefers preview over dev when a workspace has both", () => {
    expect(plan(null, { dev: "vite", preview: "vite preview" }).source).toBe("SCRIPT:preview");
  });

  it("prefers dev over start when a workspace has both", () => {
    // `start` may serve production and may block on configuration the operator does not have.
    expect(plan(null, { dev: "vite", start: "node server.js" }).source).toBe("SCRIPT:dev");
  });

  it("prefers preview over start when a workspace has both", () => {
    expect(plan(null, { preview: "vite preview", start: "node server.js" }).source)
      .toBe("SCRIPT:preview");
  });

  it("falls all the way to start when it is the only script", () => {
    const resolved = plan(null, { build: "tsc", start: "node server.js" });
    expect(resolved.source).toBe("SCRIPT:start");
    expect(resolved.command).toBe("npm run start");
  });

  it("states the order in ONE place, so the three pairings above cannot drift from it", () => {
    expect([...PREVIEW_SCRIPT_ORDER]).toStrictEqual(["preview", "dev", "start"]);
  });

  it("treats a present-but-empty script as absent rather than spawning an empty command", () => {
    // `"preview": ""` runs nothing; spawning it would surface as a start TIMEOUT half an hour
    // later instead of falling through to the script that actually serves the product.
    expect(plan(null, { dev: "vite", preview: "   " }).source).toBe("SCRIPT:dev");
  });

  it("ignores a non-string script value", () => {
    expect(plan(null, { dev: "vite", preview: 42 }).source).toBe("SCRIPT:dev");
  });
});

describe("the contract outranks the workspace scripts", () => {
  it("takes a stated preview command over every script", () => {
    const resolved = plan(
      facts(["The product is served for review.\npreview command: pnpm run serve:built"]),
      { dev: "vite", preview: "vite preview", start: "node server.js" },
    );
    expect(resolved.source).toBe("CONTRACT");
    expect(resolved.command).toBe("pnpm run serve:built");
  });

  it("contributes NOTHING from prose that merely mentions previewing", () => {
    // Guessing a command out of English would let this sentence start the dev server.
    const resolved = plan(
      facts(["It must not be previewed with the dev server or with npm run start."]),
      { preview: "vite preview" },
    );
    expect(resolved.source).toBe("SCRIPT:preview");
  });

  it("lets the FIRST stated command decide when two statements disagree", () => {
    expect(plan(facts([
      "preview command: first-wins",
      "preview command: second-loses",
    ]), null).command).toBe("first-wins");
  });
});

describe("PREVIEW_COMMAND_MISSING", () => {
  it("refuses with its code AND its layer when nothing names a command", () => {
    const resolved = resolvePreviewCommand(facts(["Deploy to a container."]), { build: "tsc" }, run);
    if (!isPreviewRefusal(resolved)) throw new Error("expected a refusal");
    expect(resolved.code).toBe("PREVIEW_COMMAND_MISSING");
    expect(resolved.layer).toBe("RUNNER");
    // The layer is DERIVED from the vocabulary's closed map, never restated by the call site.
    expect(resolved.layer).toBe(PREVIEW_CODE_LAYERS.PREVIEW_COMMAND_MISSING);
  });

  it("refuses a workspace with no manifest at all", () => {
    const resolved = resolvePreviewCommand(null, null, run);
    if (!isPreviewRefusal(resolved)) throw new Error("expected a refusal");
    expect(resolved.code).toBe("PREVIEW_COMMAND_MISSING");
    expect(resolved.layer).toBe("RUNNER");
  });
});

describe("the port the contract states", () => {
  it("is carried onto the plan", () => {
    expect(plan(facts(["preview port: 4173"]), { preview: "vite preview" }).port).toBe(4173);
  });

  it("is null — meaning detect it — when the contract states none", () => {
    expect(plan(facts(["Serve it somehow."]), { preview: "vite preview" }).port).toBeNull();
  });

  it("is null for a number outside the port range, so a typo detects instead of misdirecting", () => {
    expect(plan(facts(["preview port: 99999"]), { preview: "vite preview" }).port).toBeNull();
    expect(plan(facts(["preview port: 0"]), { preview: "vite preview" }).port).toBeNull();
  });
});

describe("the journey entry paths", () => {
  it("takes a stated path per journey and defaults the rest to the root", () => {
    const resolved = plan(facts(["preview command: serve"], [
      { journeyId: "journey-checkout", statement: "Buy a thing.\npreview path: /checkout" },
      { journeyId: "journey-home", statement: "Arrive at the product." },
    ]), null);
    expect(resolved).toBeDefined();
    const entries = resolvePreviewCommand(facts(["preview command: serve"], [
      { journeyId: "journey-checkout", statement: "Buy a thing.\npreview path: /checkout" },
      { journeyId: "journey-home", statement: "Arrive at the product." },
    ]), null, run);
    if (isPreviewRefusal(entries)) throw new Error("expected a plan");
    expect(entries.plan.journeys).toStrictEqual([
      { journeyRef: "journey-checkout", path: "/checkout" },
      { journeyRef: "journey-home", path: "/" },
    ]);
  });

  it("refuses to escape the origin: a traversal or a relative path falls back to the root", () => {
    const resolved = resolvePreviewCommand(facts(["preview command: serve"], [
      { journeyId: "j-escape", statement: "preview path: /../../etc/passwd" },
      { journeyId: "j-relative", statement: "preview path: checkout" },
    ]), null, run);
    if (isPreviewRefusal(resolved)) throw new Error("expected a plan");
    expect(resolved.plan.journeys.map((entry) => entry.path)).toStrictEqual(["/", "/"]);
  });
});

describe("detecting the port a dev server announced", () => {
  it("reads the port out of a printed origin", () => {
    expect(detectPreviewPort("  ➜  Local:   http://localhost:5173/\n"))
      .toStrictEqual({ origin: "http://127.0.0.1:5173", port: 5173 });
  });

  it("normalises a 0.0.0.0 bind address to loopback, which is what can be navigated to", () => {
    expect(detectPreviewPort("listening on http://0.0.0.0:8080"))
      .toStrictEqual({ origin: "http://127.0.0.1:8080", port: 8080 });
  });

  it("reads NOTHING out of a bare number, so build chatter cannot become a port", () => {
    // A bare-number scan reads this as port 42 and drives the browser at whatever is there.
    expect(detectPreviewPort("compiled 42 modules in 1200ms")).toBeNull();
    expect(detectPreviewPort("Server ready on port 3000")).toBeNull();
  });

  it("reads nothing out of an origin with no explicit port", () => {
    expect(detectPreviewPort("open http://localhost/")).toBeNull();
  });

  it("agrees with previewOrigin about what a port's origin is", () => {
    const detected = detectPreviewPort("http://127.0.0.1:4173");
    expect(detected?.origin).toBe(previewOrigin(4173));
  });
});

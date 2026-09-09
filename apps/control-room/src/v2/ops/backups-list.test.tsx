import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { BackupsFrameView, BackupsOutcome } from "../../live/live-backups.js";
import { mapBackupsAnswer } from "../../live/live-backups.js";
import { EnvironmentsSection } from "./environments-section.js";

/**
 * THE BACKUPS LIST on the Health screen.
 *
 * Every fixture below is a REAL SERVED FRAME put through the production decoder
 * `mapBackupsAnswer` rather than a hand-built view object, so a daemon-side shape change reds
 * these arms instead of reaching production. `frameOf` throws rather than returning a refusal,
 * so a fixture that stops decoding cannot silently become a refusal arm.
 *
 * IT RENDERS THROUGH `EnvironmentsSection`, the component DoD 2 names, rather than through
 * `BackupsList` directly - the composition is part of what is being asserted, and an arm that
 * mounted the leaf alone would stay green if the section stopped rendering it at all.
 *
 * NO ARM COUNTS ROWS. Every state is asserted by the VALUE it renders - the `data-restore-proof`
 * attribute and the visible sentence - because a count survives the one mutation this whole
 * surface exists to prevent: not-yet-checked rendering as proven.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const DIGEST = "9f2c1b7a44e0d3f6a8b5c2e1907d4a63f0b8e5c27a19d4f36b0e8c5a2d719f4c3";

/** The three states as the daemon serves them, one backup each. */
const SERVED = {
  backups: [
    {
      checkedAt: "2026-09-07T09:04:00.000Z",
      environment: "production",
      ref: "20260907090400000.sqlite",
      restoreProof: "PROVEN",
      sha256: DIGEST,
    },
    {
      checkedAt: "2026-09-07T08:04:00.000Z",
      environment: "production",
      ref: "20260907080400000.sqlite",
      restoreProof: "FAILED",
      sha256: null,
    },
    {
      checkedAt: null,
      environment: "staging",
      ref: "20260907070400000.sql",
      restoreProof: "NOT_CHECKED",
      sha256: null,
    },
  ],
  ok: true,
};

function frameOf(body: Record<string, unknown>): BackupsFrameView {
  const answer = mapBackupsAnswer(200, body);
  if (answer.status !== "BACKUPS") {
    throw new Error(`fixture stopped decoding: ${answer.code} @ ${answer.layer}`);
  }
  return answer;
}

function renderBackups(backups: BackupsOutcome | null): void {
  render(<EnvironmentsSection backups={backups} environments={[]} nowMs={0} />);
}

const rowOf = (environment: string, ref: string): HTMLElement =>
  screen.getByTestId(`cr.backups.row.${environment}.${ref}`);
const proofTextOf = (environment: string, ref: string): string =>
  screen.getByTestId(`cr.backups.row.${environment}.${ref}.proof`).textContent ?? "";
const evidenceTextOf = (environment: string, ref: string): string =>
  screen.getByTestId(`cr.backups.row.${environment}.${ref}.evidence`).textContent ?? "";

const PROVEN_REF = "20260907090400000.sqlite";
const FAILED_REF = "20260907080400000.sqlite";
const NOT_CHECKED_REF = "20260907070400000.sql";

describe("each restore-proof state renders its own value, asserted separately", () => {
  it("renders PROVEN with its own attribute, mark and sentence", () => {
    renderBackups(frameOf(SERVED));

    expect(rowOf("production", PROVEN_REF).getAttribute("data-restore-proof")).toBe("PROVEN");
    expect(proofTextOf("production", PROVEN_REF)).toBe("\u2713 Restore PROVEN");
  });

  it("renders FAILED with its own attribute, mark and sentence", () => {
    renderBackups(frameOf(SERVED));

    expect(rowOf("production", FAILED_REF).getAttribute("data-restore-proof")).toBe("FAILED");
    expect(proofTextOf("production", FAILED_REF)).toBe("\u2717 Restore check FAILED");
  });

  it("renders NOT CHECKED with its own attribute, mark and sentence", () => {
    renderBackups(frameOf(SERVED));

    expect(rowOf("staging", NOT_CHECKED_REF).getAttribute("data-restore-proof")).toBe("NOT_CHECKED");
    expect(proofTextOf("staging", NOT_CHECKED_REF)).toBe("? Restore NOT CHECKED yet");
  });

  it("names the environment and the artifact basename on every row", () => {
    renderBackups(frameOf(SERVED));

    expect(screen.getByTestId(`cr.backups.row.staging.${NOT_CHECKED_REF}.ref`).textContent)
      .toBe(`staging \u00b7 ${NOT_CHECKED_REF}`);
  });
});

/**
 * THE ONE SAFETY PROPERTY THIS ROW EXISTS FOR. Asserted as its own arm, by VALUE on both
 * carriers, and drilled: making not-yet-checked render identically to proven reds this arm.
 * A row count would survive that mutation, which is why no arm here counts anything.
 */
describe("not-yet-checked never reads as proven", () => {
  it("shares neither the attribute nor a single word of its sentence with PROVEN", () => {
    renderBackups(frameOf(SERVED));

    const notChecked = rowOf("staging", NOT_CHECKED_REF);
    const proven = rowOf("production", PROVEN_REF);

    // THE ATTRIBUTE, by value and by inequality - both clauses matter. Equality alone would
    // pass against a component that emitted "NOT_CHECKED" on every row.
    expect(notChecked.getAttribute("data-restore-proof")).toBe("NOT_CHECKED");
    expect(notChecked.getAttribute("data-restore-proof"))
      .not.toBe(proven.getAttribute("data-restore-proof"));

    // THE SENTENCE, by value. It must say NOT CHECKED and must not contain the word PROVEN,
    // so neither a copy revision nor a mark swap can collapse the two.
    const notCheckedWords = proofTextOf("staging", NOT_CHECKED_REF);
    expect(notCheckedWords).toBe("? Restore NOT CHECKED yet");
    expect(notCheckedWords).not.toContain("PROVEN");
    expect(notCheckedWords).not.toBe(proofTextOf("production", PROVEN_REF));

    // AND THE MARK IS NOT THE PROVEN MARK - the non-colour carrier a monochrome reader uses.
    expect(notCheckedWords.startsWith("\u2713")).toBe(false);
  });

  it("keeps all three sentences distinct, so no pair of states can be confused", () => {
    renderBackups(frameOf(SERVED));

    const sentences = [
      proofTextOf("production", PROVEN_REF),
      proofTextOf("production", FAILED_REF),
      proofTextOf("staging", NOT_CHECKED_REF),
    ];

    expect(new Set(sentences).size).toBe(3);
    // MORE THAN COLOUR: every sentence carries a distinct leading mark AND distinct words, and
    // the three rows share one CSS class, so nothing here is signalled by styling alone.
    expect(new Set(sentences.map((sentence) => sentence.slice(0, 1))).size).toBe(3);
    expect(new Set([
      rowOf("production", PROVEN_REF).className,
      rowOf("staging", NOT_CHECKED_REF).className,
    ]).size).toBe(1);
  });
});

describe("a backup with no digest and no check time renders honestly", () => {
  it("states BOTH absences in words, never as blank, zero or a dash", () => {
    renderBackups(frameOf(SERVED));

    const evidence = evidenceTextOf("staging", NOT_CHECKED_REF);
    expect(evidence).toBe("No digest recorded \u00b7 never checked");
    // Nothing in it can be read as a value: no empty run, no bare zero, no lone dash.
    expect(evidence).not.toContain("null");
    expect(evidence).not.toMatch(/(?:^|\s)[-0](?:\s|$)/u);
    expect(evidence).not.toContain("PROVEN");
  });

  it("states the PRESENT case differently, asserted separately from the absent one", () => {
    renderBackups(frameOf(SERVED));

    expect(evidenceTextOf("production", PROVEN_REF))
      .toBe(`Digest ${DIGEST} \u00b7 checked 2026-09-07T09:04:00.000Z`);
  });

  it("states a HALF-absent row half-honestly: no digest, but a real check time", () => {
    renderBackups(frameOf(SERVED));

    expect(evidenceTextOf("production", FAILED_REF))
      .toBe("No digest recorded \u00b7 checked 2026-09-07T08:04:00.000Z");
  });
});

describe("a read that did not answer is never rendered as an empty list", () => {
  it("shows the refusal with its code and layer, and no rows at all", () => {
    renderBackups(mapBackupsAnswer(200, {
      code: "BACKUPS_READ_CAPABILITY_DENIED", layer: "CONTROL_ROOM_LISTENER", outcome: "REFUSED",
    }));

    expect(screen.getByTestId("cr.backups.refusal").textContent)
      .toContain("BACKUPS_READ_CAPABILITY_DENIED @ CONTROL_ROOM_LISTENER");
    expect(screen.queryByTestId("cr.backups.list")).toBeNull();
    expect(screen.queryByTestId("cr.backups.empty")).toBeNull();
  });

  it("shows a malformed frame as a refusal at THIS layer, not as no backups", () => {
    renderBackups(mapBackupsAnswer(200, { backups: [], generatedAt: "now", ok: true }));

    expect(screen.getByTestId("cr.backups.refusal").textContent)
      .toContain("BACKUPS_RESPONSE_INVALID @ CONTROL_ROOM_BACKUPS");
    expect(screen.queryByTestId("cr.backups.empty")).toBeNull();
  });

  it("distinguishes still-reading from nothing-recorded, which look alike if collapsed", () => {
    renderBackups(null);
    expect(screen.getByTestId("cr.backups.loading").textContent).toBe("Reading the backups...");
    expect(screen.queryByTestId("cr.backups.empty")).toBeNull();
    cleanup();

    renderBackups(frameOf({ backups: [], ok: true }));
    expect(screen.getByTestId("cr.backups.empty").textContent).toContain("No backup recorded.");
    expect(screen.queryByTestId("cr.backups.loading")).toBeNull();
    expect(screen.queryByTestId("cr.backups.list")).toBeNull();
  });
});

/**
 * DoD 6 at the RENDERED seam. The decoder arms cover the failure path; these cover what an
 * operator actually sees, with the same positive-control discipline.
 */
const CREDENTIAL_SHAPES: ReadonlyArray<readonly [string, RegExp]> = Object.freeze([
  ["connection-string", /\b(?:postgres(?:ql)?|mysql|mongodb|redis):\/\//iu],
  ["userinfo-at-host", /[A-Za-z0-9._%-]+:[^\s"/@]{6,}@[A-Za-z0-9.-]+/u],
  ["password-token", /password/iu],
  ["absolute-posix-path", /\/(?:var|etc|home|srv)\//u],
]);

function credentialShapesIn(text: string): readonly string[] {
  return CREDENTIAL_SHAPES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

describe("no credential-shaped material reaches the rendered output", () => {
  it("finds a planted credential, so the instrument is not vacuous", () => {
    expect(credentialShapesIn(
      "postgresql://deploy:hunter2correcthorse@db.internal:5432/app /var/lib/moe DB_PASSWORD",
    )).toStrictEqual([
      "connection-string", "userinfo-at-host", "password-token", "absolute-posix-path",
    ]);
  });

  it("renders none of it when the served frame carries one and the read FAILS", () => {
    // The frame hides a connection string where the artifact basename belongs. The decoder
    // refuses it, so what reaches the screen is the refusal - which must carry none of it.
    renderBackups(mapBackupsAnswer(200, {
      backups: [{
        checkedAt: null,
        environment: "production",
        ref: "postgresql://deploy:hunter2correcthorse@db.internal:5432/app",
        restoreProof: "NOT_CHECKED",
        sha256: null,
        sourcePath: "/var/lib/moe/backups/20260907090400000.sqlite",
      }],
      ok: true,
    }));

    const rendered = screen.getByTestId("cr.backups.root").textContent ?? "";
    expect(rendered).toContain("BACKUPS_RESPONSE_INVALID");
    expect(credentialShapesIn(rendered)).toStrictEqual([]);
    expect(rendered).not.toContain("hunter2correcthorse");
  });

  it("renders none of it on the clean frame either", () => {
    renderBackups(frameOf(SERVED));

    expect(credentialShapesIn(screen.getByTestId("cr.backups.root").textContent ?? ""))
      .toStrictEqual([]);
  });
});

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { readWireProtocolVersion, withDaemonBackedControlRoom } from "./daemon-ports.js";
import type { DaemonLane } from "./daemon-ports.js";

/**
 * NEW PRODUCT FROM A PRD, driven entirely in the browser against a REAL daemon on an EMPTY
 * store. This is the journey that makes "a fresh project cannot be started from the browser
 * alone" false.
 *
 * NO SCRATCHPAD SCRIPT AND NO SEED, ANYWHERE. The lane runs `seed: "NONE"` and asserts
 * `lane.seedPid` is null before the page is touched. Every step below is a browser action or a
 * READ of what the daemon and the filesystem now hold; nothing is set up on the side. A helper
 * anywhere in the path would keep this test green while making its claim false, which retires
 * the question instead of answering it.
 *
 * THE GITHUB FIELDS ARE LEFT EMPTY on purpose. The local-only path is the one an operator
 * without `gh` takes, and it is the path the row must prove works end to end. The GitHub half
 * is exercised by the live drive in step 8, not by a lane that would need a real account.
 *
 * ASSERTED ON THE DAEMON AND THE FILESYSTEM, never on the form's own render. The card reports
 * what it was told; `git log`, the durable receipt read back over the route, the affordance
 * surface and the manager catalog are what actually happened.
 */

const JOURNEY_MS = 420_000;
const CARD_MS = 120_000;
const RUN_MS = 240_000;
const PAIRING_BUDGET_MS = 90_000;
const PAIRING_LABEL = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u;
const PRODUCT_NAME = "browser-first-product";
const PRD_TEXT = "# Browser-first product\n\nThe operator never opens a terminal.\n";

/**
 * Every directory this spec creates, deleted in AFTEREACH so the failure paths are covered
 * too. A trailing `rmSync` after the assertions runs only when they all pass, which is the one
 * case where a leak would not matter (epic rail 4).
 */
const created: string[] = [];
test.afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { force: true, recursive: true });
});

const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Asks the DAEMON the same question the page asks, with the credentials the bundle carries. */
async function askDaemon(lane: DaemonLane, path: string, body: string): Promise<unknown> {
  const protocolVersion = await readWireProtocolVersion(lane.repoRoot);
  expect(protocolVersion, "the generated wire protocol version must load").not.toBeNull();
  const response = await fetch(`${lane.baseUrl}${path}`, {
    body,
    headers: {
      "content-type": "application/json",
      "x-moe-csrf": lane.csrfToken,
      "x-moe-protocol-version": protocolVersion ?? "",
      "x-moe-session-credential": lane.credential,
    },
    method: "POST",
  });
  expect(response.status, `${path} must answer 200`).toBe(200);
  return await response.json();
}

/** The operator's real pairing ritual, copied from activation-fresh-project.spec.ts:53-69. */
async function pairBrowser(page: Page, lane: DaemonLane): Promise<void> {
  const approve = lane.approvePairing;
  expect(approve, "the lane must expose an operator channel").not.toBeNull();
  const output = page.getByLabel("Pairing confirmation label");
  await expect(output).toBeVisible({ timeout: 30_000 });
  const label = (await output.textContent())?.trim() ?? "";
  expect(label, "the browser must be shown a real label").toMatch(PAIRING_LABEL);
  approve?.(label);
  const confirm = page.getByRole("button", { name: "I entered this label" });
  const deadline = Date.now() + PAIRING_BUDGET_MS;
  while (Date.now() < deadline) {
    if (await output.count() === 0) return;
    await confirm.click({ timeout: 5_000 }).catch(() => undefined);
    await sleep(1_000);
  }
  await expect(output, "the pairing card must close").toHaveCount(0, { timeout: 10_000 });
}

/** The committed decision kinds the daemon itself reports on the affordance surface. */
function committedKinds(surface: unknown): readonly string[] {
  if (!isRecord(surface) || !Array.isArray(surface["steps"])) return [];
  return (surface["steps"] as readonly unknown[])
    .filter((step): step is Readonly<Record<string, unknown>> =>
      isRecord(step) && step["status"] === "COMMITTED")
    .map((step) => String(step["kind"]));
}

test("a PRD and a directory become a bound repository and a goal, in the browser alone", async ({ page }) => {
  test.setTimeout(JOURNEY_MS);

  // OUTSIDE the repository and outside the lane's own scratch, so nothing this spec creates
  // can be mistaken for the checkout or for lane state. Registered for teardown immediately,
  // before anything can throw.
  const parentDir = mkdtempSync(join(tmpdir(), "moe-newproduct-"));
  created.push(parentDir);
  const productDir = join(parentDir, PRODUCT_NAME);
  expect(existsSync(productDir), "the browser must create the submitted directory").toBe(false);

  const outcome = await withDaemonBackedControlRoom({
    approval: "HUMAN",
    liveCredentials: "ATTACHED",
    operatorChannel: true,
    seed: "NONE",
  }, async (lane) => {
    // THE PREMISE. `seedPid` is null only for `seed: "NONE"`, so this is the lane's own
    // witness that no script populated the store the browser is about to drive.
    expect(lane.seedPid, "seed child pid (null proves the lane ran unseeded)").toBeNull();
    // And the manager catalog this daemon writes is the lane's, not the host's.
    expect(lane.catalogPath).not.toBe("");
    expect(existsSync(lane.catalogPath), "no catalog exists before the browser runs").toBe(false);

    await page.goto(lane.baseUrl);
    await pairBrowser(page, lane);

    // 1. THE FORM, FILLED AND SUBMITTED IN THE BROWSER, WITH THE GITHUB FIELDS EMPTY.
    const form = page.getByTestId("cr.newproduct.form");
    await expect(form, "the new-product card is mounted in the served app").toBeVisible({ timeout: CARD_MS });
    await page.getByTestId("cr.newproduct.dir").fill(productDir);
    await page.getByTestId("cr.newproduct.name").fill(PRODUCT_NAME);
    await page.getByTestId("cr.newproduct.prd").setInputFiles({
      buffer: Buffer.from(PRD_TEXT, "utf8"), mimeType: "text/markdown", name: "product-prd.md",
    });
    await expect(page.getByTestId("cr.newproduct.prd.file")).toHaveText("product-prd.md");
    // The local-only path: every GitHub field is left exactly as it mounted.
    await expect(page.getByTestId("cr.newproduct.github.owner")).toHaveValue("");
    await expect(page.getByTestId("cr.newproduct.github.visibility")).toHaveValue("private");
    await page.getByTestId("cr.newproduct.create").click();

    const state = page.getByTestId("cr.newproduct.outcome");
    await expect(state, "the run reported an outcome").toBeVisible({ timeout: RUN_MS });
    await expect(state, "a local-only bootstrap is a FULL success, not a partial one")
      .toHaveAttribute("data-state", "SUCCESS", { timeout: RUN_MS });

    // 2. THE DIRECTORY IS A REAL REPOSITORY ON DISK.
    expect(existsSync(join(productDir, ".git")), "the browser created a git repository").toBe(true);

    // 3. EXACTLY ONE COMMIT. The line COUNT is the assertion, not the presence of a commit: a
    // second line means the scaffold ran twice, which a "has a commit" check would call fine.
    const log = execFileSync("git", ["log", "--oneline"], { cwd: productDir, encoding: "utf8" });
    const lines = log.split("\n").filter((line) => line.trim() !== "");
    expect(lines, `git log --oneline in the new repository:\n${log}`).toHaveLength(1);
    const productHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: productDir, encoding: "utf8",
    }).trim();
    expect(productHead).toMatch(/^[0-9a-f]{40}$/u);

    // 4. BOUND, READ BACK THROUGH THE DAEMON rather than from the card's own state. The durable
    // receipt is written only after the bind succeeds - a failed bind answers
    // BOOTSTRAP_BIND_FAILED / BIND_FAILED_LOCAL_REPOSITORY_RETAINED and never reaches
    // BOOTSTRAPPED - and the affordance surface is the daemon's separate word on the same fact.
    const receiptBody = await askDaemon(lane, "/repository/bootstrap/read", "{}");
    expect(isRecord(receiptBody) && receiptBody["outcome"]).toBe("BOOTSTRAP_READ");
    const receipt = isRecord(receiptBody) ? receiptBody["receipt"] : null;
    expect(isRecord(receipt), `the daemon holds a durable receipt: ${JSON.stringify(receiptBody)}`).toBe(true);
    if (!isRecord(receipt)) throw new Error("bootstrap receipt missing");
    expect(receipt["outcome"], "the daemon's own verdict").toBe("BOOTSTRAPPED");
    expect(receipt["refusal"]).toBeNull();
    expect(receipt["githubRefusal"], "no GitHub half was requested, so none was refused").toBeNull();
    expect(receipt["remoteUrl"], "the local-only path binds no remote").toBeNull();
    expect(String(receipt["sha"]), "the receipt names the commit git reports").toBe(productHead);
    expect(String(receipt["dir"]).replaceAll("\\", "/"))
      .toBe(productDir.replaceAll("\\", "/"));

    const committed = committedKinds(await askDaemon(lane, "/affordances/read", "{}"));
    expect(committed, `committed kinds: ${committed.join(", ")}`)
      .toContain("project.bind_repository");
    expect(committed).toContain("repository.bootstrap");
    expect(committed).toContain("project.activate");

    // 5. THE PROJECT IS IN THE MANAGER CATALOG, read from the file the daemon wrote.
    expect(existsSync(lane.catalogPath), "the daemon wrote the manager catalog").toBe(true);
    const catalog: unknown = JSON.parse(readFileSync(lane.catalogPath, "utf8"));
    const entries: unknown = isRecord(catalog) ? catalog["entries"] : null;
    expect(Array.isArray(entries), "the manager catalog exposes its entries").toBe(true);
    if (!Array.isArray(entries)) throw new Error("manager catalog entries missing");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ projectId: lane.projectId, title: PRODUCT_NAME });
    expect(String((entries[0] as Record<string, unknown>)["root"]).replaceAll("\\", "/"))
      .toBe(productDir.replaceAll("\\", "/"));

    // 6. THE PRD GOAL EXISTS AND THE LANE CONTINUES. The card reports the goal the daemon
    // accepted, and /goals/read is the durable catalog behind it - the card alone would only
    // prove the browser thought so.
    await expect(page.getByTestId("cr.newproduct.goal"), "the PRD goal was created")
      .toHaveText(`Goal created: ${PRODUCT_NAME}`, { timeout: RUN_MS });
    const goals = await askDaemon(lane, "/goals/read", "{}");
    expect(isRecord(goals) && goals["outcome"]).toBe("GOALS");
    const rows: unknown = isRecord(goals) ? goals["goals"] : null;
    expect(Array.isArray(rows), "the goal is in the daemon durable catalog").toBe(true);
    if (!Array.isArray(rows)) throw new Error("goal catalog rows missing");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      brief: { title: PRODUCT_NAME },
      binding: {
        byteLength: Buffer.byteLength(PRD_TEXT, "utf8"),
        contentSha256: createHash("sha256").update(PRD_TEXT, "utf8").digest("hex"),
        sourceAggregateId: expect.any(String), sourceRef: expect.any(String),
      },
    });

    return {
      commits: lines.length, productHead, receiptDecidedAt: receipt["decidedAt"],
      receiptId: `${lane.projectId}-bootstrap`, remoteUrl: receipt["remoteUrl"],
      githubRefusal: receipt["githubRefusal"],
    };
  });

  expect(outcome.ok, `lane opened${outcome.ok ? "" : `: ${outcome.code} ${outcome.detail}`}`)
    .toBe(true);
  if (!outcome.ok) return;
  expect(outcome.value.commits, "exactly one commit in the new repository").toBe(1);
  // The receipt has no standalone id field: its durable key is the project bootstrap aggregate.
  // Only checked local facts are reported, after the lane teardown; no credential is included.
  console.info(`[new-product-local-receipt] ${JSON.stringify(outcome.value)}`);
});

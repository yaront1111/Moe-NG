import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { launchPreviewBrowser } from "./preview-browser.js";
import type { PreviewBrowser } from "./preview-browser.js";

import { previewCaptureDirectory } from "./preview-receipt-contracts.js";
import type { PreviewScreenshot } from "./preview-receipt-contracts.js";

/**
 * THE PICTURE THE OPERATOR JUDGES: one PNG per journey, taken by a real headless Chromium
 * against the product the runner just started.
 *
 * WHERE THE BYTES GO, and why the prefix is computed rather than concatenated here.
 * `previewCaptureDirectory(goalId, sha)` is the ONE statement of
 * `.moe-next/previews/<goalId>/<sha>` — the receipt decoder validates paths against the same
 * function (`preview-receipt-contracts.ts`), so a writer and a reader that disagreed about the
 * layout would be a compile-time impossibility rather than a runtime surprise.
 *
 * CONTAINMENT IS CHECKED BEFORE ANY JOIN, not after. A journey ref carrying a separator or a
 * `..` would put one journey's capture outside the run's own directory — or outside the project
 * — and the receipt would then advertise it as this run's. Such a ref is REFUSED (skipped, and
 * absent from the returned roster) rather than sanitised into something that looks fine, because
 * a silently rewritten path is how a capture ends up somewhere nobody looks for it. The runner
 * has already refused an escaping goalId or sha before this is ever called; this is the second
 * of the two checks, on the segment this module owns.
 *
 * THE BROWSER IS ALWAYS CLOSED. A leaked Chromium is the same failure as a leaked preview
 * server, one process further out, so the close sits in a `finally` and runs on the throwing
 * path too.
 *
 * WHY `waitUntil: "load"` AND NOT `networkidle`. A dev server with an open HMR websocket is
 * NEVER network-idle, so `networkidle` would hang every capture of exactly the products this
 * feature exists to preview until the navigation timeout.
 */

/** The 8-byte signature every PNG begins with. The tests decode against this, not a file stat. */
export const PNG_MAGIC = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const VIEWPORT = Object.freeze({ height: 720, width: 1280 });

export interface PreviewCaptureInput {
  /** Absolute path to the project root the captures are written under. */
  readonly directory: string;
  readonly goalId: string;
  readonly journeys: readonly { readonly journeyRef: string; readonly path: string }[];
  readonly origin: string;
  readonly sha: string;
}

export interface PreviewCaptureOptions {
  /** Injected in tests so an arm can drive a stub browser; production launches Chromium. */
  readonly launch?: () => Promise<PreviewBrowser>;
  readonly navigationTimeoutMs?: number;
}

/**
 * A journey ref is ONE path segment, and it names a file. Anything that could leave this run's
 * directory, or that the filesystem would refuse or silently rewrite, is not one:
 *   - a separator or `..` would escape the directory;
 *   - whitespace and control characters (NUL included) make a name a path hazard, and a NUL can
 *     truncate a path inside a syscall rather than failing it;
 *   - the Windows-reserved `<>:"|?*` set would make the write fail on one platform and succeed
 *     on another, which is worse than refusing on both.
 */
const UNSAFE_SEGMENT = /[\u0000-\u001f\s/\\<>:"|?*]/u;

function containedRef(journeyRef: string): boolean {
  return journeyRef.length > 0 && journeyRef.length <= 128
    && !journeyRef.includes("..") && !UNSAFE_SEGMENT.test(journeyRef)
    && journeyRef !== "." && journeyRef !== "..";
}

/**
 * Captures one PNG per journey and returns the roster of what was ACTUALLY written — a journey
 * whose navigation or shot failed contributes nothing, so the receipt can never advertise a
 * capture that is not on disk.
 */
export async function capturePreviewJourneys(
  input: PreviewCaptureInput, options: PreviewCaptureOptions = {},
): Promise<readonly PreviewScreenshot[]> {
  const relativeDirectory = previewCaptureDirectory(input.goalId, input.sha);
  const absoluteDirectory = join(input.directory, ...relativeDirectory.split("/"));
  const wanted = input.journeys.filter((journey) => containedRef(journey.journeyRef));
  if (wanted.length === 0) return [];
  mkdirSync(absoluteDirectory, { recursive: true });

  const launch = options.launch ?? launchPreviewBrowser;
  const navigationTimeout = options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
  const browser = await launch();
  const written: PreviewScreenshot[] = [];
  try {
    const context = await browser.newContext({ viewport: { ...VIEWPORT } });
    try {
      for (const journey of wanted) {
        const file = `${journey.journeyRef}.png`;
        const page = await context.newPage();
        try {
          await page.goto(`${input.origin}${journey.path}`, {
            timeout: navigationTimeout, waitUntil: "load",
          });
          await page.screenshot({ path: join(absoluteDirectory, file), type: "png" });
          written.push({ journeyRef: journey.journeyRef, path: `${relativeDirectory}/${file}` });
        } catch {
          // One journey that would not paint must not cost the operator the others.
        } finally {
          await page.close().catch(() => undefined);
        }
      }
    } finally {
      await context.close().catch(() => undefined);
    }
  } finally {
    // A leaked Chromium is a leaked process, which is this row's whole subject.
    await browser.close().catch(() => undefined);
  }
  return written;
}

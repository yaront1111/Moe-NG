import { afterEach, describe, expect, it, vi } from "vitest";

import {
  mapPreviewAnswer, previewCaptureUrl, readPreview,
} from "./live-preview.js";

/**
 * The raw frames are the DAEMON's, copied from preview-read.ts rather than invented here: the
 * PRESENT projection is exactly eight keys and deliberately omits `pid`, `projectId` and
 * `version`. A test that adds one of those would be asserting a shape the route never sends.
 */
const GOAL = "goal-1";
const SHA = "a".repeat(40);
const present = () => ({
  kind: "PRESENT",
  preview: {
    code: null,
    decidedAt: "2026-09-06T09:00:00.000Z",
    goalId: GOAL,
    outcome: "STARTED",
    receiptId: "preview-receipt/abc",
    screenshots: [{ journeyRef: "journey-1", path: `.moe-next/previews/${GOAL}/${SHA}/home.png` }],
    sha: SHA,
    url: "http://127.0.0.1:4173/",
  },
});
const absent = () => ({ goalId: GOAL, kind: "ABSENT" });
const invalid = {
  code: "PREVIEW_RESPONSE_INVALID", layer: "CONTROL_ROOM_LIVE_PREVIEW", status: "ERROR",
};
const response = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());

describe("mapPreviewAnswer", () => {
  it("copies a PRESENT projection verbatim and freezes it against later mutation", () => {
    const frame = present();
    const result = mapPreviewAnswer(200, frame);

    expect(result).toStrictEqual({ preview: frame.preview, status: "PREVIEW" });
    frame.preview.screenshots[0]!.journeyRef = "changed";
    expect(result).toMatchObject({ preview: { screenshots: [{ journeyRef: "journey-1" }] } });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("keeps ABSENT distinct from every failure, because no preview yet is not a fault", () => {
    expect(mapPreviewAnswer(200, absent())).toStrictEqual({ goalId: GOAL, status: "ABSENT" });
  });

  it("maps the route's own REFUSED envelope with its code and layer", () => {
    expect(mapPreviewAnswer(200, {
      code: "PREVIEW_READ_URL_UNSERVABLE", kind: "REFUSED", layer: "PREVIEW_READ",
    })).toStrictEqual({
      code: "PREVIEW_READ_URL_UNSERVABLE", layer: "PREVIEW_READ", status: "REFUSED",
    });
  });

  it("maps the listener refusal and both authentication refusal shapes", () => {
    expect(mapPreviewAnswer(404, { code: "LISTENER_PREVIEW_UNAVAILABLE", layer: "LISTENER" }))
      .toStrictEqual({ code: "LISTENER_PREVIEW_UNAVAILABLE", layer: "LISTENER", status: "REFUSED" });
    expect(mapPreviewAnswer(401, {
      error: { code: "CREDENTIAL_INVALID" }, httpStatus: 401, ok: false,
      outcome: "REFUSED", stage: "AUTHENTICATE",
    })).toStrictEqual({ code: "CREDENTIAL_INVALID", layer: "AUTHENTICATE", status: "REFUSED" });
    expect(mapPreviewAnswer(403, {
      httpStatus: 403, ok: false, outcome: "PORT_REFUSED",
      refusal: { code: "OPERATOR_PRINCIPAL_REQUIRED" }, stage: "DISPATCH",
    })).toStrictEqual({
      code: "OPERATOR_PRINCIPAL_REQUIRED", layer: "DISPATCH", status: "REFUSED",
    });
  });

  it("rejects an extra or missing key at EVERY nested record, envelope included", () => {
    const records: Record<string, unknown>[] = [];
    const build = (): void => {
      const frame = present();
      records.length = 0;
      records.push(frame, frame.preview, frame.preview.screenshots[0]!);
    };
    build();
    for (let index = 0; index < 3; index += 1) {
      build();
      const record = records[index]!;
      Object.defineProperty(record, "extra", { configurable: true, enumerable: true, value: 1 });
      expect(mapPreviewAnswer(200, records[0]), `extra key at ${String(index)}`)
        .toStrictEqual(invalid);
      build();
      const victim = records[index]!;
      const key = Object.keys(victim)[0]!;
      Reflect.deleteProperty(victim, key);
      expect(mapPreviewAnswer(200, records[0]), `missing ${key}`).toStrictEqual(invalid);
    }
  });

  it("rejects a wrong outcome word, a non-string code and a non-array screenshots", () => {
    const outcome = present();
    (outcome.preview as { outcome: string }).outcome = "RUNNING";
    expect(mapPreviewAnswer(200, outcome)).toStrictEqual(invalid);

    const code = present();
    (code.preview as unknown as { code: unknown }).code = 7;
    expect(mapPreviewAnswer(200, code)).toStrictEqual(invalid);

    const shots = present();
    (shots.preview as unknown as { screenshots: unknown }).screenshots = {};
    expect(mapPreviewAnswer(200, shots)).toStrictEqual(invalid);
  });

  it("never invokes a getter and never accepts a foreign prototype", () => {
    const getter = vi.fn(() => "STARTED");
    const frame = present();
    const accessor = Object.defineProperty({ ...frame.preview }, "outcome", { get: getter });
    expect(mapPreviewAnswer(200, { kind: "PRESENT", preview: accessor })).toStrictEqual(invalid);
    expect(getter).not.toHaveBeenCalled();

    const foreign = Object.assign(Object.create({ inherited: true }) as object, present());
    expect(mapPreviewAnswer(200, foreign)).toStrictEqual(invalid);
  });

  it("treats a non-200 with no refusal shape, and every non-record, as an ERROR", () => {
    expect(mapPreviewAnswer(500, present())).toStrictEqual(invalid);
    for (const value of [null, [], "PRESENT", 7, undefined]) {
      expect(mapPreviewAnswer(200, value)).toStrictEqual(invalid);
    }
  });
});

describe("previewCaptureUrl", () => {
  const preview = { goalId: GOAL, sha: SHA };

  it("builds the capture route path from the served project-relative path", () => {
    expect(previewCaptureUrl(preview, {
      journeyRef: "journey-1", path: `.moe-next/previews/${GOAL}/${SHA}/home.png`,
    })).toBe(`/preview/capture/${GOAL}/${SHA}/home.png`);
  });

  it("percent-encodes every segment rather than interpolating it raw", () => {
    expect(previewCaptureUrl({ goalId: "goal 1", sha: SHA }, {
      journeyRef: "journey-1", path: `.moe-next/previews/goal 1/${SHA}/first shot.png`,
    })).toBe(`/preview/capture/goal%201/${SHA}/first%20shot.png`);
  });

  it("refuses a path outside this receipt's own previews directory", () => {
    const outside = [
      `.moe-next/previews/other-goal/${SHA}/home.png`,
      `.moe-next/previews/${GOAL}/${"b".repeat(40)}/home.png`,
      ".moe-next/store/daemon.sqlite",
      `/etc/passwd`,
    ];
    for (const path of outside) {
      expect(previewCaptureUrl(preview, { journeyRef: "j", path }), path).toBeNull();
    }
  });

  it("refuses traversal, a backslash, a nested segment and an empty file name", () => {
    const prefix = `.moe-next/previews/${GOAL}/${SHA}`;
    for (const tail of ["../escape.png", "nested/home.png", "sub\\home.png", ""]) {
      expect(previewCaptureUrl(preview, { journeyRef: "j", path: `${prefix}/${tail}` }), tail)
        .toBeNull();
    }
  });
});

describe("readPreview", () => {
  it("POSTs EXACTLY {goalId} and maps the answer", async () => {
    const sent: string[] = [];
    const post = async (body: string): Promise<Response> => {
      sent.push(body);
      return Promise.resolve(response(200, present()));
    };
    const result = await readPreview(GOAL, {}, post);

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!) as unknown).toStrictEqual({ goalId: GOAL });
    expect(result).toMatchObject({ status: "PREVIEW" });
  });

  it("answers ERROR TRANSPORT_REQUEST_FAILED when the request never lands", async () => {
    const post = vi.fn(async () => Promise.reject(new Error("offline")));
    expect(await readPreview(GOAL, {}, post)).toStrictEqual({
      code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_LIVE_PREVIEW", status: "ERROR",
    });
  });

  it("answers ERROR when the body is not JSON at all", async () => {
    const post = vi.fn(async () => Promise.resolve(new Response("<html>", { status: 200 })));
    expect(await readPreview(GOAL, {}, post)).toStrictEqual(invalid);
  });
});

import { describe, expect, it } from "vitest";
import { readReleaseApprovalTarget } from "./release-approval-target.js";

describe("release browser remote opt-in", () => {
  it("keeps real publication disabled unless explicitly requested", () => {
    expect(readReleaseApprovalTarget({})).toEqual({ enabled: false });
    expect(readReleaseApprovalTarget({ MOE_E2E_RELEASE_REMOTE_URL: "https://example.com/repo.git" }))
      .toEqual({ enabled: false });
  });

  it.each(["", "C:/local/release.git", "file:///local/release.git", "http://localhost/repo.git"])(
    "rejects an unadmitted remote before starting the opted-in journey: %s", (remoteUrl) => {
      expect(() => readReleaseApprovalTarget({ MOE_E2E_RELEASE_REMOTE_TEST: "1", MOE_E2E_RELEASE_REMOTE_URL: remoteUrl }))
        .toThrow("RELEASE_REMOTE_URL_INVALID");
    },
  );

  it.each(["https://example.com/repo.git", "ssh://git@example.com/repo.git", "git@example.com:repo.git"])(
    "retains the exact admitted publication target: %s", (remoteUrl) => {
      expect(readReleaseApprovalTarget({ MOE_E2E_RELEASE_REMOTE_TEST: "1", MOE_E2E_RELEASE_REMOTE_URL: remoteUrl }))
        .toEqual({ enabled: true, remoteUrl });
    },
  );
});

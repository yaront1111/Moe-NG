import { afterEach, expect, it } from "vitest";
import { closeStores } from "../review/review-test-fixtures.js";
import { recoveryEvidenceFixture } from "./repository-recovery-test-fixtures.js";
import { finishRepositoryLandingNoEffect, startRepositoryLandingAttempt } from "./repository-landing-attempt.js";
afterEach(closeStores);
it("never starts a second effect until the preceding exact attempt has durable no-effect evidence", () => {
  const f = recoveryEvidenceFixture(); const intent = f.completed(false);
  const first = startRepositoryLandingAttempt(f.store, intent); expect(first).toEqual({ ok: true, version: 1 });
  expect(startRepositoryLandingAttempt(f.store, intent)).toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_REQUIRED" });
  expect(finishRepositoryLandingNoEffect(f.store, intent, 99)).toMatchObject({ ok: false });
  expect(startRepositoryLandingAttempt(f.store, intent)).toMatchObject({ ok: false });
  expect(finishRepositoryLandingNoEffect(f.store, intent, 1)).toEqual({ ok: true });
  expect(startRepositoryLandingAttempt(f.store, intent)).toEqual({ ok: true, version: 3 });
  expect(finishRepositoryLandingNoEffect(f.store, intent, 1)).toMatchObject({ ok: false });
  expect(startRepositoryLandingAttempt(f.store, intent)).toMatchObject({ ok: false });
});

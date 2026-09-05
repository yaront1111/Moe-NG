import { expect, it } from "vitest";
import { readPublicationCandidate } from "./live-publication-candidate.js";
const approval = { branch: "delivery", remoteUrl: "https://github.com/o/r.git", repositoryId: "a".repeat(64), sha: "b".repeat(40) };
it("prepares the exact goal and remote and accepts only a public approval tuple", async () => {
  let body = "";
  expect(await readPublicationCandidate({}, "goal-1", null, async (given) => {
    body = given; return new Response(JSON.stringify({ outcome: "PUBLICATION_CANDIDATE", goalId: "goal-1", approval }));
  })).toEqual({ ok: true, goalId: "goal-1", approval });
  expect(JSON.parse(body)).toEqual({ goalId: "goal-1", remoteUrl: null });
  for (const value of [{ outcome: "PUBLICATION_CANDIDATE", goalId: "other", approval },
    { outcome: "PUBLICATION_CANDIDATE", goalId: "goal-1", approval: { ...approval, token: "private" } },
    { outcome: "PUBLICATION_CANDIDATE", goalId: "goal-1", approval: { ...approval, sha: "HEAD" } }]) {
    expect(await readPublicationCandidate({}, "goal-1", null, async () => new Response(JSON.stringify(value))))
      .toMatchObject({ ok: false, code: "PUBLISH_CANDIDATE_UNREADABLE" });
  }
});

// Exact-SHA cross-host evidence gate.
//
// Answers one question: does GitHub Actions hold real Linux + macOS evidence
// for THIS git commit? Usage:
//
//   node tests/fault/cross-host/exact-sha-evidence-gate.mjs <40-char-sha>
//
// A commit is proven only when a single completed run at that exact `head_sha`
// carries BOTH:
//   * `host-evidence-linux`, `host-evidence-darwin` and `cross-host-aggregate`
//     all concluded `success`, and
//   * all three `cross-host-{linux,darwin,aggregate}-<sha>` artifacts present,
//     unexpired, non-empty and carrying a `sha256:` digest.
//
// WHY BOTH CONDITIONS LIVE IN ONE PREDICATE
//
// The workflow triggers on `push` AND `pull_request`, so one commit produces
// two completed runs that both report the same `head_sha`. Artifacts are named
// with `${{ github.sha }}`, which is the COMMIT on a push run but the ephemeral
// MERGE commit on a pull_request run. A gate that accepts the first run with
// three green jobs and only afterwards checks artifact names will select the
// pull_request run and then refuse it for "missing artifacts" -- while the real
// proof sits unexamined in the push run. Checking jobs and artifacts together,
// and continuing the search on failure, is what binds the evidence to the git
// commit rather than to a merge SHA that exists nowhere in history.
//
// The overall run conclusion is deliberately NOT consulted: the workflow also
// contains a broad `gate (ubuntu/macos)` matrix carrying unrelated parked-WIP
// red, so `run.conclusion` is `failure` even when every required job is green.
// Only the three named jobs may promote a row.

const sha = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(sha ?? "")) {
  throw Error(`pass a full 40-character commit SHA, got: ${sha}`);
}

const base = "https://api.github.com/repos/yaront1111/Moe-NG";
const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };

const get = async (path) => {
  const response = await fetch(base + path, { headers });
  if (!response.ok) throw Error(`${response.status} ${path}`);
  return response.json();
};

const requiredJobs = ["host-evidence-linux", "host-evidence-darwin", "cross-host-aggregate"];
const requiredArtifacts = ["linux", "darwin", "aggregate"].map((slot) => `cross-host-${slot}-${sha}`);

const describeArtifacts = (artifacts) =>
  requiredArtifacts.map((name) => {
    const found = artifacts.find((artifact) => artifact.name === name);
    return {
      name,
      ok:
        !!found &&
        !found.expired &&
        found.size_in_bytes > 0 &&
        typeof found.digest === "string" &&
        found.digest.startsWith("sha256:"),
      digest: found?.digest ?? null,
      sizeInBytes: found?.size_in_bytes ?? null,
    };
  });

const runs = (
  await get(`/actions/workflows/cross-host.yml/runs?head_sha=${sha}&per_page=20`)
).workflow_runs.filter((run) => run.head_sha === sha && run.status === "completed");

const rejected = [];
let proof = null;

for (const run of runs) {
  const { jobs } = await get(`/actions/runs/${run.id}/jobs?per_page=100`);
  const { artifacts } = await get(`/actions/runs/${run.id}/artifacts?per_page=100`);

  const jobsGreen = requiredJobs.every((name) =>
    jobs.some((job) => job.name === name && job.status === "completed" && job.conclusion === "success"),
  );
  const described = describeArtifacts(artifacts);

  if (jobsGreen && described.every((artifact) => artifact.ok)) {
    proof = { run, jobs, artifacts: described };
    break;
  }
  rejected.push({
    runId: run.id,
    event: run.event,
    jobsGreen,
    artifactNames: artifacts.map((artifact) => artifact.name),
  });
}

if (!proof) {
  console.error(JSON.stringify({ sha, rejected }, null, 2));
  throw Error(`no exact-SHA Linux/macOS/aggregate success with exact-SHA artifacts for ${sha}`);
}

console.log(
  JSON.stringify(
    {
      sha,
      runId: proof.run.id,
      event: proof.run.event,
      url: proof.run.html_url,
      runConclusionIgnored: proof.run.conclusion,
      requiredJobs: requiredJobs.map((name) => ({
        name,
        conclusion: proof.jobs.find((job) => job.name === name).conclusion,
      })),
      unrelatedJobs: proof.jobs
        .filter((job) => !requiredJobs.includes(job.name))
        .map((job) => ({ name: job.name, conclusion: job.conclusion })),
      artifacts: proof.artifacts,
      rejectedRuns: rejected,
    },
    null,
    2,
  ),
);

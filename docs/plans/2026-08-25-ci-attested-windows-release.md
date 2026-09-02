# CI-Attested Windows Release Implementation Plan

**Goal:** Produce and publish the Windows supervised-MVP artifact only from a protected
`main` commit, with GitHub-hosted job isolation, exact artifact attestations, explicit
human approval, and immutable release verification.

**Architecture:** Local packaging remains `LOCAL_OBSERVED` and never grants publication
authority. The reusable workflow admits only the exact protected manual caller, runs all
gates, and builds the ZIP in a Windows job with read-only repository authority; a fresh
job that never checks out or executes repository code independently validates and attests
the ZIP, detached observation, and release evidence. A separate manually dispatched
workflow, gated by the `windows-production-release` environment, verifies the candidate,
attests the fixed publication roster, proves an exact six-asset draft roster, publishes
the draft, then verifies the immutable release statement and every local asset.

**Tech stack:** GitHub Actions, Node 24.16.0, pnpm 11.0.8, Rust 1.96.0,
PowerShell 7, `actions/attest`, GitHub CLI, Vitest, actionlint.

---

## Authority contract

- `pnpm pack:windows` always embeds `moe-pack-provenance/1` with
  `mode: LOCAL_OBSERVED` and `publicationAuthorized: false`.
- The build job emits `moe-windows.zip.provenance.json` with
  `schemaVersion: moe-pack-observation/1`, the exact source SHA, ZIP SHA-256 and size,
  release-evidence digest, runner image identity, and
  `isolationClass: GITHUB_HOSTED_EPHEMERAL_JOB`. It remains local-observation authority.
- The exact release-evidence JSON is preserved beside the ZIP and detached observation;
  its bytes must match the digest in the observation before candidate admission.
- A candidate is `CI_ATTESTED` only when the ZIP, observation, and exact release evidence
  have a valid SLSA attestation from `reusable-windows-release.yml`, with the expected
  repository, exact manual caller, signer workflow/digest, source digest/ref, and a
  GitHub-hosted runner.
- `CI_ATTESTED` does not itself authorize publication.
- Publication authority exists only for a final `moe-windows.release.json` created after
  the `windows-production-release` environment gate, attested by
  `publish-windows-release.yml`, and included in a GitHub immutable release whose release
  attestation verifies.

Stable refusal layer: `WINDOWS_RELEASE_AUTHORITY`.

Stable codes:

- `WINDOWS_RELEASE_INPUT_INVALID`
- `WINDOWS_RELEASE_REF_UNPROTECTED`
- `WINDOWS_RELEASE_REQUIRED_GATE_MISSING`
- `WINDOWS_RELEASE_SOURCE_MISMATCH`
- `WINDOWS_RELEASE_VERSION_MISMATCH`
- `WINDOWS_RELEASE_CANDIDATE_MALFORMED`
- `WINDOWS_RELEASE_ARTIFACT_MISMATCH`
- `WINDOWS_RELEASE_ATTESTATION_INVALID`
- `WINDOWS_RELEASE_SIGNER_MISMATCH`
- `WINDOWS_RELEASE_PUBLICATION_CONFLICT`
- `WINDOWS_RELEASE_IMMUTABILITY_DISABLED`
- `WINDOWS_RELEASE_IMMUTABILITY_UNVERIFIED`

## Task 1: Freeze the workflow contract in red tests

**Files:**

- Create: `tests/integration/release/release-workflow-contract.test.ts`
- Modify: `tests/integration/portability/portability-workflow.test.ts`

- [x] Assert two workflow files and one reusable workflow exist.
- [x] Assert the candidate caller accepts an explicit 40/64-hex confirmation but checks
      out only `github.sha` from protected `refs/heads/main`.
- [x] Assert the reusable workflow has `required-gates`, `build-candidate`, and
      `attest-candidate` in dependency order.
- [x] Assert the build job has only `contents: read`; the signer has no checkout and no
      repository-script execution.
- [x] Assert the candidate signer has only `contents: read`, `id-token: write`,
      `attestations: write`, and `artifact-metadata: write`.
- [x] Assert the publish job alone has `contents: write`, references
      `windows-production-release`, performs offline bundle verification before release
      creation, and verifies the immutable release after publication.
- [x] Assert every third-party action is one of the reviewed full-length SHA pins.
- [x] Run the focused test and record RED because the workflows are absent.

## Task 2: Add the detached local observation

**Files:**

- Create: `scripts/release/windows-pack-observation.mjs`
- Create: `tests/integration/release/windows-pack-observation.test.mjs`
- Modify: `package.json`

- [x] Write hostile tests for missing/extra keys, malformed SHA/size, artifact substitution,
      source mismatch, false publication promotion, and noncanonical output.
- [x] Run the Node test and record RED because the observation command is absent.
- [x] Implement bounded exact inputs, SHA-256/size recomputation, canonical JSON, and a
      frozen `LOCAL_OBSERVED` receipt. No environment variable may promote its mode.
- [x] Add `release:observe-windows-pack` and include both files in `typecheck:release`.
- [x] Run the focused Node test and `pnpm typecheck:release`; expect nonzero green counts.

## Task 3: Build and attest a candidate without publication authority

**Files:**

- Create: `.github/workflows/reusable-windows-release.yml`
- Create: `.github/workflows/windows-release-candidate.yml`
- Modify: `.github/workflows/cross-host.yml`

- [x] Add `workflow_call` to `cross-host.yml` without changing its existing push, pull
      request, or manual gates.
- [x] The caller and reusable workflow must independently bind the human-entered source
      confirmation to `github.sha`.
- [x] The reusable workflow must rerun cross-host gates, then use a fresh `windows-2025`
      job to install pinned tools, build native prerequisites, run required repository
      gates with positive counts, run `release:evidence`, pack, smoke, and reverify HEAD.
- [x] Upload exactly the ZIP, detached observation, and observation-only evidence under a
      SHA-bound candidate name. Do not grant the build job OIDC, attestation, environment,
      secret, or contents-write authority.
- [x] A fresh signer job must download an exact ordinary-file roster, never extract or
      execute it, attest ZIP, observation, and evidence with pinned `actions/attest`, and
      immediately verify all three from the returned bundle with exact signer/source/ref flags and
      `--deny-self-hosted-runners`.
- [x] Upload the verified candidate and bundle. Do not create a tag or release.
- [x] Run workflow-contract tests and `actionlint`; expect green.

## Task 4: Publish only after independent environment approval

**Files:**

- Create: `.github/workflows/publish-windows-release.yml`
- Create: `scripts/release/verify-windows-release.mjs`
- Create: `tests/integration/release/verify-windows-release.test.mjs`
- Modify: `package.json`

- [x] Write verifier tests for wrong run/source/ref/repository/signer, missing paired
      attestation, ZIP/receipt substitution, release-tag/version mismatch, mutable release,
      and zero verified attestations.
- [x] Run the verifier test and record RED because the verifier is absent.
- [x] Implement a verifier that accepts protected policy as explicit arguments, invokes
      `gh attestation verify` with exact argv and `shell: false`, validates nonzero JSON
      results, recomputes file hashes, and never trusts receipt fields as policy.
- [x] The publish workflow must run only by manual dispatch from protected `main`, download
      one exact successful candidate run, and execute no candidate or repository bytes.
- [x] After the `windows-production-release` approval, create
      `moe-windows.release.json` with `PUBLICATION_APPROVED` mode and explicit publication
      authority, attest the four candidate files plus final manifest, and verify the
      returned bundle.
- [x] Refuse an existing tag or release. Create a draft with the fixed asset roster,
      require exact REST names/sizes/digests, bind its release ID, publish it, then require
      an exact release-attestation DSSE roster plus `gh release verify-asset` for all six
      files.
- [x] Run verifier tests, workflow-contract tests, typecheck, and actionlint; expect green.

## Task 5: Install the external repository authority

**External state:** `yaront1111/Moe-NG` repository settings.

- [x] Protect `main`: strict required cross-host checks, enforce administrators, no force
      pushes/deletion, linear history, and conversation resolution.
- [x] Create `windows-production-release`, restrict it to protected branches, and require
      reviewer `yaront1111`. Do not enable self-review prevention while this repository has
      only one collaborator because that would make release permanently impossible.
- [x] Disable administrator bypass for `windows-production-release`; the approval must be
      exercised through the review event, not the break-glass control.
- [x] Enable immutable releases.
- [ ] After the full-SHA workflow bytes land on `main`, enable repository-wide full-SHA
      action pinning. Do not enable it earlier because current remote workflows use mutable
      major tags and would stop running.
- [x] Re-read every setting through the GitHub API and save no token or response containing
      credentials in the repository.

Live authority installed on 2026-08-25: immutable releases are enabled; `main` is protected
with strict GitHub-Actions checks, administrator enforcement, pull-request-only updates,
linear history, resolved conversations, and no force-push/deletion; and the
`windows-production-release` environment is restricted to protected branches, requires
`yaront1111`, and forbids administrator bypass. Repository-wide action SHA enforcement is
intentionally deferred until the full-SHA workflow bytes reach `main`.

The release jobs fail closed unless the runner-provided GitHub CLI reports exactly
2.92.0, whose JSON and release-attestation shapes are covered by extracted-script
fixtures. That binary remains within the GitHub-hosted runner trust boundary.

## Task 6: Adversarial and regression verification

**Files:**

- Create: `docs/release-provenance.md`
- Modify: `README.md` only after live authority exists.

- [x] Run focused release/workflow tests and mutation drills.
- [x] Run `actionlint`, `pnpm typecheck`, `pnpm test`, daemon, control-room, security,
      integration, fault, property, migration, E2E, and browser E2E gates independently.
- [x] Run `git diff --check` and inspect only owned paths plus current-byte integration joins.
- [x] Perform an attacker-style review of permission flow, untrusted-file handling,
      workflow expressions, shell arguments, rerun conflicts, and publication ordering.
- [x] Preserve the local expected refusal `PACK_SOURCE_PACKER_DRIFT` until all packaging
      changes are one coherent commit.
- [ ] Do not call the release production-ready until the committed exact SHA has a live
      verified candidate, approved publication run, and immutable release verification.

Publication is not transactional. Failure after draft creation can leave a draft/tag
requiring explicit operator cleanup; failure after `draft=false` can leave an immutable
public release while the run reports red. The workflow detects and refuses mismatched
bytes but cannot revoke already-published state.

No task in this plan authorizes staging foreign WIP, pushing, merging, resetting, stashing,
or editing live `.moe`, `.codex`, or `.serena` state.

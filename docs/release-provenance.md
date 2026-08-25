# Windows release provenance

The Windows release path has three different claims. They are deliberately not
interchangeable.

| State | Meaning | Publication power |
|---|---|---|
| `LOCAL_OBSERVED` | A local packer measured a commit and ZIP. | None |
| `CI_ATTESTED` | GitHub verified the candidate's repository, source, signer workflow, and artifact digest. | None |
| `PUBLICATION_APPROVED` | The protected release job received human environment approval and its final manifest was attested. | One immutable release |

The ZIP's embedded `MANIFEST-PROVENANCE.json` always remains
`LOCAL_OBSERVED` with `publicationAuthorized: false`. This is intentional: an
archive cannot prove the external authority that signed it, and it cannot embed
its own final digest without a self-reference.

## Trust root

The production policy adopts these external authorities:

- repository `yaront1111/Moe-NG`;
- protected source ref `refs/heads/main`;
- the exact manual caller workflow
  `yaront1111/Moe-NG/.github/workflows/windows-release-candidate.yml`;
- the reusable signer workflow
  `yaront1111/Moe-NG/.github/workflows/reusable-windows-release.yml`;
- GitHub-hosted ephemeral runners only;
- GitHub OIDC and Sigstore artifact attestations;
- full-length reviewed action commit pins;
- GitHub immutable releases;
- the `windows-production-release` environment's human approval.

GitHub-hosted runner and pinned-action authority is not hermetic-build proof.
The release records the runner image and tool observations and keeps this
limitation explicit. Attestation proves provenance and integrity, not that the
program is defect-free.

## Candidate workflow

Run `windows-release-candidate` from protected `main` and enter the full source
SHA shown by GitHub. The workflow refuses if the typed SHA differs from
`github.sha`.

The manual workflow composes local reusable stages from the same reviewed commit:

1. Refuse every caller except the exact protected-main manual candidate workflow.
2. Rerun the cross-host and application gates at the exact SHA.
3. Build and smoke the Windows ZIP in
   `reusable-windows-candidate-build.yml`, the only candidate stage that checks
   out or executes repository code. Its fresh `windows-2025` job has only
   `contents: read` authority.
4. Emit `moe-windows.zip.provenance.json`. It remains `LOCAL_OBSERVED` and
   binds the ZIP, source SHA, observation-only release evidence, and runner.
5. Preserve the exact evidence as `moe-windows.zip.release-evidence.json` and
   require its bytes to match the observation's evidence digest.
6. Transfer the build artifact by immutable artifact ID into
   `reusable-windows-candidate-admit.yml`. This fresh read-only job performs no
   checkout or repository execution and independently validates the canonical
   schemas, authority flags, caps, source, and byte bindings.
7. Transfer the admitted artifact by immutable ID into
   `reusable-windows-release.yml`. This remains the signer workflow identity,
   has no checkout or repository execution, and is the only candidate stage
   with OIDC and attestation writes. It attests all three files, copies the
   returned bundle without overwrite, and re-observes the signed roster.
8. Transfer the signed artifact by immutable ID into
   `reusable-windows-candidate-verify.yml`. This fresh read-only job verifies the
   offline bundle against the exact repository, caller, signer/source digests,
   source ref, and hosted-runner policy at the final candidate path. It then
   re-observes all four files and uploads the stable candidate artifact consumed
   by publication.

The resulting workflow artifact is an attested candidate. It is not a release.

## Publication workflow

Run `publish-windows-release` from protected `main` with:

- the successful candidate workflow run ID;
- the exact source SHA;
- the package-matching release tag, such as `v0.1.0`.

The workflow first calls `reusable-windows-publication-authorize.yml`, a
read-only job that verifies the candidate run, bytes, signer policy, immutable
release setting, and absent tag/release state. It passes only explicit outputs
to the publisher.

The publisher remains inline in `publish-windows-release.yml`, preserving its
workflow signer identity and `windows-production-release` environment approval.
It runs in a fresh job and never checks out or executes candidate or repository
source. Together, the read-only authorizer and publisher:

1. verifies the candidate run identity, conclusion, source SHA, fixed file
   roster, hashes, and offline attestation bundle;
2. refuses if immutable releases are disabled or the tag/release exists;
3. creates `moe-windows.release.json` after human approval;
4. attests and verifies the ZIP, local observation, release evidence, candidate
   attestation bundle, and final release manifest;
5. creates a draft release, uploads exactly six assets, and requires the draft REST
   roster to contain exactly those names, sizes, and SHA-256 digests with no extras;
6. binds the draft release ID, uploads the exact six files as an immutable
   same-run verification handoff, and publishes the draft, making the release immutable.

After publication, `reusable-windows-publication-verify.yml` downloads that
handoff by exact artifact ID in a fresh read-only job. It:

7. requires `gh release verify`, decodes its release-attestation DSSE statement, and
   binds the exact release ID, repository, tag, source SHA, and six unique locally
   re-hashed asset subjects with no aliases or extras;
8. runs `gh release verify-asset` for every one of the six local assets as an
   additional published-byte check.

The workflows require the GitHub CLI 2.92.0 output contract and fail closed on a
different version. The runner-provided CLI remains part of the GitHub-hosted runner
trust boundary.

Any interrupted run that already created a tag or release returns
`WINDOWS_RELEASE_PUBLICATION_CONFLICT`. It never overwrites release bytes. A failure
after draft creation can leave a draft/tag that needs explicit inspection and cleanup.
A failure after publication can leave an immutable public release even though the job
is red; stop distribution, preserve the evidence, and use a new version after incident
review rather than attempting to mutate the release.

## Consumer verification

Download all six assets from one release: the ZIP, detached observation, release
evidence, candidate bundle, final release manifest, and publication bundle. Refuse
missing or extra names. First verify GitHub's immutable release:

```powershell
gh release verify v0.1.0 --repo yaront1111/Moe-NG
```

Then verify the artifact and observation against the exact final signer policy:

```powershell
gh attestation verify .\moe-windows.zip `
  --repo yaront1111/Moe-NG `
  --bundle .\moe-windows.release.attestation.json `
  --signer-workflow yaront1111/Moe-NG/.github/workflows/publish-windows-release.yml `
  --signer-digest <full-source-sha> `
  --source-digest <full-source-sha> `
  --source-ref refs/heads/main `
  --deny-self-hosted-runners
```

Run the same command for `moe-windows.zip.provenance.json`,
`moe-windows.zip.release-evidence.json`, `moe-windows.zip.attestation.json`, and
`moe-windows.release.json`. Use `gh release verify-asset` for each downloaded
asset. Finally, recompute the ZIP SHA-256 and byte length and compare them with
the attested final manifest.

## Required repository settings

Before the first candidate can be published:

- protect `main`, enforce required cross-host checks for administrators, and
  block force pushes and deletion;
- require linear history and resolved review conversations;
- create `windows-production-release`, restrict it to protected branches, and
  add the release reviewer, with administrator bypass disabled;
- enable immutable releases;
- require full-SHA action pins after the pinned workflow changes reach `main`.

The repository currently has one collaborator. Preventing self-review while
requiring that sole reviewer would make release approval impossible. Add a
second trusted collaborator before enabling two-person approval.

## Local refusal is expected

Packaging source code that differs from the selected commit must continue to
exit nonzero with `PACK_SOURCE_PACKER_DRIFT`. Do not bypass it with dirty-tree
flags or by copying working-tree bytes into a release candidate.

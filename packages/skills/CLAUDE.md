# @moe/skills

The versioned, content-addressed skill-bundle runtime: it turns manifest bytes into a
validated identity, reads exactly the files that manifest declares, and resolves an explicit
request list into a replayable snapshot. Its job in the wider system is to make advisory
provider text *inert and reproducible* — every artifact it emits carries `authority: "NONE"`
and `advisoryOnly: true`, and has no command, lease, approval, budget or effect field to
set. Nothing here writes to disk, reads a clock, or consults the environment.

## Seams

- Export map is `"." : "./src/index.ts"` only; the sole dependency is `@moe/contracts`
  (`decodeBoundedJsonBytes` / `BoundedJsonErrorCode`).
- `validateSkillManifestBytes(bytes)` → `{ ok, manifest, canonicalJson, identityDigest }`.
  Pure: no filesystem call happens anywhere in `skill-manifest.ts`.
- `loadSkillBundle(bundleRoot, manifest, fs = NODE_FS)` → `LoadedSkillBundle`
  (`bundleDigest`, `files[].contentBase64`). `SkillFsFacade` is injectable so containment is
  unit-testable without Windows Developer Mode.
- `resolveSkillSnapshot(bundles, requests)` → `SkillSnapshot` (`snapshotDigest`,
  `canonicalJson`); `toSkillRendererInput(snapshot)` → the shape a provider adapter renders.
- The only production caller in the repo is `tools/packaging/distribution-build.ts`, which
  runs `validateSkillManifestBytes` over `builtInSkillManifestBytes` and records
  `{ digest: identityDigest, skillId, version }` into the distribution manifest. **No module
  under `apps/daemon` or `packages/runner` imports this package.**
- `packages/runner/src/providers/claude/claude-render.ts` and
  `.../codex/codex-render-skills.ts` **mirror** `SkillRendererInput` structurally rather than
  importing it — each pins its own `MIRRORED_SKILL_RENDERER_INPUT_VERSION =
  "moe-skill-renderer-input/1"` plus `MAX_MIRRORED_SKILLS`/`MAX_MIRRORED_SKILL_FILES`, and
  re-checks the bounds because the snapshot crosses the boundary as untrusted data.

## The model

- **Three closed version strings** in `skill-contract.ts`: `SKILL_MANIFEST_VERSION`,
  `SKILL_SNAPSHOT_VERSION`, `SKILL_RENDERER_INPUT_VERSION` (all `.../1`). A consumer that does
  not recognise one must refuse the artifact, not guess at field meanings.
- **One rejection factory.** Every failure in the package is `skillFailure(code, message)` →
  a frozen `{ ok: false, code, message }`, drawn from the 16-entry `SKILL_ERROR_CODES`. The
  tests assert `Object.isFrozen(result)` alongside the code, so the shape cannot drift.
- **Bounded-decode codes collapse.** `BOUNDED_CODE_MAP` folds the nine `BoundedJsonErrorCode`
  values into three outcomes (`SKILL_UNICODE_INVALID`, `SKILL_LIMIT_EXCEEDED`,
  `SKILL_MANIFEST_BYTES_INVALID`); the message keeps the inner code as a prefix, and
  `skill-manifest.test.ts` pins that preservation.
- **Three digests, three scopes.** `canonicalJson` is sorted-key JSON with safe integers only
  (it *throws* on anything it cannot canonicalise, so an uncanonicalisable value can never
  reach a digest). `identityDigest` covers the whole manifest; `bundleDigest` covers
  `skillId/version/origin` plus `{path, sha256, byteLength}` — never file content, which is
  already hashed; `snapshotDigest` is taken over the snapshot body *before* the digest field
  is added to it.
- **Path hardening is Win32-shaped and runs before any fs call.** `pathRejection` refuses a
  backslash, a colon, a tilde, a leading `/`, an empty or dot segment, a segment ending in a
  dot or space, and every stem in `RESERVED_DEVICE_STEMS` (`con`, `prn`, `nul`, `com1..9`,
  `lpt1..9`). Text must be well-formed NFC (`isNormalizedText` also rejects lone surrogates,
  which `normalize()` preserves). An exact duplicate path is `SKILL_IDENTITY_DUPLICATE`; a
  case-folded collision is `SKILL_PATH_AMBIGUOUS` — two different codes on purpose.
- **Containment needs the trailing separator.** `isContained` appends `sep` to the realpath
  root, because a bare prefix test admits the sibling `/x/skills-evil` against root
  `/x/skills`. Every `realpathSync.native` throw — absent, device, revoked link — collapses
  to `SKILL_FILE_MISSING`; the loader never propagates an exception.
- **Checks run on the bytes just read**, never a re-stat or second read, so there is no TOCTOU
  window. Longer than declared → `SKILL_FILE_OVERSIZED`; *shorter* than declared →
  `SKILL_DIGEST_MISMATCH`, refused before the digest is computed so a collision over fewer
  bytes can never be admitted.
- **Content travels as base64, always.** `deepFreeze` documents why: `Object.freeze` throws
  `TypeError` on a non-empty `Uint8Array`, so bytes may never sit inside a frozen graph.
- **Snapshot resolution is all-or-nothing and order-free.** One `skillId` may be offered by at
  most one loaded bundle (`SKILL_REQUEST_AMBIGUOUS`), a request must match id *and* version
  *and* `bundleDigest` (`SKILL_REQUEST_UNKNOWN`), and the result is sorted by `skillId` so
  request order cannot move `snapshotDigest`. A dedicated test asserts the canonical JSON
  contains no ISO timestamp, `capturedat` or `timestamp`.
- **Limits** (`skill-contract.ts`): 64 files, 262144 bytes per file, 1048576 bytes total, 200
  path chars, 64 id chars, 16 requests. The comment ties the worst case to
  `MAX_JSON_BODY_BYTES` (1 MiB) so a manifest inside these caps is always decodable.

## Gotchas

- **`SKILL_SNAPSHOT_INVALID` is declared in `SKILL_ERROR_CODES` but emitted nowhere** in this
  package — it is reserved for a consumer that rejects a snapshot. Do not go hunting for the
  call site.
- **Sibling `.js` bridges are asserted byte-for-byte.** `skills-runtime-entrypoint.test.ts`
  compares each bridge to exactly `export * from "./<name>.ts";` plus one LF — a CRLF bridge
  lands in `wrongContent`, which `git diff --stat` would never show. It also pins the three
  excluded modules by name *and* reason (`skill-bundle.test.ts`, `skill-manifest.test.ts`,
  `skills-runtime-entrypoint.test.ts` → `"test-file"`), so **adding a test file here means
  editing that map**. `classify()` also excludes by content (`imports-vitest`), not only by
  filename suffix.
- That suite spawns a **real child Node** with `--experimental-strip-types`, cwd set to the
  package root so the bare specifier `@moe/skills` resolves through this package's own
  `exports` map via Node's self-reference rule. Vitest rewrites `./x.js` back to `.ts`, so no
  other suite in the repo can see a missing bridge.
- **`tests/integration/distribution/distribution-packaging.test.ts` pins the shipped built-in
  skill count at exactly zero** (`SHIPPED_BUILT_IN_SKILLS = []`). Registering a real built-in
  bundle reds that arm by design. Note that `.moe/skills/` in this repo is workspace state in
  a *different* schema (`moeGeneratedSha`/`skills[]`) and is not a `SkillManifest`.
- `tests/integration/release/release-version-surfaces.test.ts` pins
  `"packages/skills/package.json"` in `EXPECTED_JS_MANIFESTS`.
- Changing `SKILL_RENDERER_INPUT_VERSION` or the snapshot key set silently desyncs the two
  runner mirrors; `tests/security/runtime-provider-launch.security.ts` pins
  `CLAUDE_RENDER_SKILL_SNAPSHOT_VERSION_UNSUPPORTED` and the Codex twin.
- The real-symlink arm is `it.skipIf(!canSymlink())` — without Windows Developer Mode it
  silently does not run, and only the `SkillFsFacade` containment unit tests cover
  `SKILL_SYMLINK_ESCAPE`. Check for the skip before trusting a green run of that escape path.
- `skill-contract.ts` imports `node:crypto` and `skill-loader.ts` imports `node:fs`: unlike
  `@moe/control-room-client`, this package is **not** browser-loadable, and `tsconfig.json`
  sets `types: ["node"]`.
- Bundle fixtures are written under `os.tmpdir()` via `mkdtempSync` and reaped in `afterEach`;
  never write scratch bundles under the repo root.

## Testing

- Whole package: `pnpm --filter @moe/skills test` (which is `vitest run --root ../..
  packages/skills/src` — it borrows the root config, `environment: "node"`, `pool: "forks"`
  with bounded workers).
- One file, from the repo root: `pnpm vitest run packages/skills/src/skill-bundle.test.ts`.
- Typecheck alone: `pnpm --filter @moe/skills typecheck`.
- Outside coverage: `tests/integration/distribution/distribution-packaging.test.ts` (built-in
  skill identities come from this validator, and an external bundle substituting a shipped ID
  is refused rather than merged), `tests/integration/release/release-version-surfaces.test.ts`,
  and `pnpm test:security` `runtime-provider-launch` for the two renderer mirrors.

# Windows Project Control Implementation Plan

**Goal:** Let a Windows operator create or register projects, supervise one contained daemon stack per project, see exact lifecycle state, and open each project's isolated goals, tasks, and board from the control room.
**Architecture:** A singleton loopback project manager owns a non-secret atomic catalog and launches one stack-host process per catalog instance inside the existing native Windows Job boundary. The manager has a separate narrow browser session; a daemon-owned, short-lived handoff ticket attaches a new project tab, so the manager never receives a project session credential and the browser never receives an operator credential. Project lifecycle metadata stays in the manager while goals, tasks, and boards stay in each project's own daemon and SQLite store.
**Tech Stack:** Node 24 TypeScript, React 19, Vitest, Playwright, Node HTTP, SQLite-backed daemon sessions, Rust/Win32 Job Object broker, PowerShell packaging smoke.

---

## Implementation status — 2026-08-24

The catalog, native per-store stack boundary, stack host, runtime supervisor,
short-lived manager/project tickets, authenticated manager HTTP surface,
`moe projects`, manager UI, and the direct `moe start` compatibility entry are
now present in production paths. The packaged inventory requires the manager,
single-project entry, stack host, and native broker. Operator documentation and
the artifact smoke now use the manager-first/foreground contract and the
60-second one-use ticket window.

This plan is not completion evidence. The source Windows journey now proves two
same-basename projects receive distinct ids, ports, daemon sessions, stores, goal
catalogs, and setup boards, and proves manager termination reaps both daemons.
The packaged duplicate-store/crash-reaping/secret-containment matrix in Task 7
remains the final artifact gate. The unchecked task lists below preserve the
original red-green plan; use current test output and owned diffs, not those boxes,
as status authority.

## File map

- Create `apps/daemon/src/projects/project-catalog.ts`: exact catalog codec, canonical identity checks, atomic persistence.
- Create `apps/daemon/src/projects/project-stack-protocol.ts`: bounded JSON-line frames between manager and the contained stack host.
- Create `apps/daemon/src/projects/project-stack-host-main.ts`: config reader, store lock owner, daemon/wrapper composition, READY/ticket/terminal frames.
- Create `apps/daemon/src/projects/project-supervisor.ts`: lifecycle state machine over the curated Windows Job boundary.
- Create `apps/daemon/src/projects/project-manager-listener.ts`: authenticated loopback manager API and static host.
- Create `apps/daemon/src/projects/project-manager-main.ts`: catalog, supervisor, listener, signals, and shutdown composition.
- Modify `apps/daemon/src/cli/moe-cli-argv.ts` and `moe-cli-main.ts`: add `moe projects`; separate operator cwd from artifact root.
- Create `packages/runner/src/platform/windows/windows-project-stack-boundary.ts`: curated stack-only boundary and environment policy; keep the raw process boundary private.
- Modify `packages/runner/src/platform/windows/windows-launch-request.ts`: share encoding mechanics without widening the provider environment roster.
- Modify `packages/runner/src/platform/windows/windows-broker-path.ts`: resolve both checkout and packaged broker layouts.
- Modify `tools/packaging/pack-windows.ts` and `pack-inventory.ts`: build, stage, and require the native broker.
- Create `apps/control-room/src/v2/projects/project-manager-client.ts`: exact manager response decoders and calls.
- Create `apps/control-room/src/v2/projects/project-home.tsx` and CSS: first-project form, registry, exact lifecycle, actions.
- Modify `apps/control-room/src/main.tsx`, `v2/cordum-app.tsx`, and `v2/projects/project-boundary.tsx`: select manager mode and link project tabs back to the project home.
- Extend the hosted browser journey to prove two stores, two project tabs, and no goal/task/board bleed.

### Task 1: Package the containment authority

**Files:**
- Modify: `packages/runner/src/platform/windows/windows-broker-path.ts`
- Modify: `tools/packaging/pack-windows.ts`
- Modify: `tools/packaging/pack-inventory.ts`
- Test: focused sibling tests

- [ ] Write tests that expect `native/moe-windows-job-broker.exe` in a staged artifact and resolve it without `pnpm-workspace.yaml`.
- [ ] Run the focused runner/packaging tests; expect missing-path assertions to fail.
- [ ] Build with `cargo build --locked --release`, copy the regular file into the artifact, and add it to the required inventory.
- [ ] Run focused tests and packaging typecheck; expect exit 0 with nonzero test counts.

### Task 2: Add the non-secret project catalog

**Files:**
- Create: `apps/daemon/src/projects/project-catalog.ts`
- Test: `apps/daemon/src/projects/project-catalog.test.ts`

- [ ] Write tests for exact decoding, same-basename projects, root/config/store aliases, secret-key rejection, crash-safe replacement, and failed-write preservation.
- [ ] Run the focused test; expect failures because the catalog API is absent.
- [ ] Implement `loadProjectCatalog`, `registerCatalogProject`, and `saveProjectCatalogAtomic` with injected filesystem and UUID ports.
- [ ] Run the focused test and daemon typecheck; expect exit 0.

The persisted entry is deliberately metadata only:

```ts
interface ProjectCatalogEntry {
  readonly instanceId: string;
  readonly title: string;
  readonly root: string;
  readonly configPath: string;
  readonly projectId: string;
  readonly storePath: string;
}
```

### Task 3: Add a curated contained project stack

**Files:**
- Create: `packages/runner/src/platform/windows/windows-project-stack-boundary.ts`
- Create: `apps/daemon/src/projects/project-stack-protocol.ts`
- Create: `apps/daemon/src/projects/project-stack-host-main.ts`
- Create: `apps/daemon/src/projects/project-supervisor.ts`
- Test: focused siblings

- [ ] Write request-policy tests proving project variables are accepted only by the stack boundary and still rejected by the provider boundary.
- [ ] Write lifecycle tests for duplicate canonical store start, STARTING to RUNNING only after a matching READY frame, malformed/mismatched frames to UNKNOWN, stop to PROVEN STOPPED, and crash to FAILED/UNKNOWN according to the broker outcome.
- [ ] Run both focused tests and observe the expected missing-implementation failures.
- [ ] Implement the bounded stack request, protocol decoder, host, and state machine. Keep arbitrary executable launch and proof constructors private.
- [ ] Run focused tests, runner/daemon typechecks, and the native containment gate; expect exit 0.

### Task 4: Rotate project handoff tickets without logging them

**Files:**
- Extend: daemon pairing-token owner and handshake listener after the in-flight expiry work lands
- Extend: `apps/daemon/src/projects/project-stack-protocol.ts`
- Test: handshake and supervisor focused tests

- [ ] Write tests for fresh ticket rotation, invalidation, expiry, replay, concurrent redemption, wrong daemon incarnation, and zero token bytes in argv/log/catalog.
- [ ] Run tests; expect rotation cases to fail while the existing one-use expiry cases remain green.
- [ ] Add a private manager-to-stack request that asks the daemon to rotate its own ticket and returns one ticket frame. The manager may forward that fragment URL once but may not mint a session or read its credential.
- [ ] Re-run focused tests; expect exit 0.

### Task 5: Add the authenticated project-manager HTTP surface

**Files:**
- Create: `apps/daemon/src/projects/project-manager-listener.ts`
- Create: `apps/daemon/src/projects/project-manager-main.ts`
- Modify: `apps/daemon/src/cli/moe-cli-argv.ts`
- Modify: `apps/daemon/src/cli/moe-cli-main.ts`
- Test: focused siblings

- [ ] Write socket tests for loopback/Host/Origin/CSRF, one-use manager pairing, narrow manager cookie authority, bounded exact bodies, create/register/start/stop/open, and project-credential rejection.
- [ ] Run focused tests; expect route/CLI cases to fail.
- [ ] Implement `moe projects`, with the state directory under `%LOCALAPPDATA%\\Moe` by default and an explicit test override. Resolve project paths against `process.cwd()`, never the extracted artifact root.
- [ ] Run focused tests and daemon typecheck; expect exit 0.

### Task 6: Build the project home and switching UI

**Files:**
- Create: `apps/control-room/src/v2/projects/project-manager-client.ts`
- Create: `apps/control-room/src/v2/projects/project-home.tsx`
- Create: `apps/control-room/src/v2/projects/project-home.css`
- Modify: `apps/control-room/src/main.tsx`
- Modify: `apps/control-room/src/v2/cordum-app.tsx`
- Modify: `apps/control-room/src/v2/projects/project-boundary.tsx`
- Test: focused siblings

- [ ] Write component tests for the empty first-project state, exact lifecycle chips, create/register, start/stop/open, UNKNOWN refusal, secret-free errors, and returning from a project tab.
- [ ] Run focused tests; expect missing-component/integration failures.
- [ ] Implement the quiet project ledger: one row per catalog instance, one explicit selected project, and separate tabs opened with `noopener,noreferrer`. Do not aggregate or client-filter tasks across projects.
- [ ] Run focused tests, control-room typecheck, and build; expect exit 0.

### Task 7: Prove the real Windows journey

**Files:**
- Modify: `tests/e2e/control-room/prd-to-approval.spec.ts` or create a focused project-manager browser spec
- Modify: `tools/packaging/smoke-windows-artifact.ps1`
- Modify: operator documentation

- [ ] Write an end-to-end test that creates two different roots with the same basename, starts both, opens both through fresh tickets, creates distinct durable activity, and asserts each tab shows only its bound project/store feed.
- [ ] Run the browser test and observe the expected failure before final integration.
- [ ] Add packaged containment checks: broker resolution, duplicate-store refusal, manager crash reaping both process trees, and zero token/credential bytes in argv/log/catalog.
- [ ] Run the focused daemon, runner, control-room, browser, packaging, and regression gates independently; record exit code and test-count lines.

## Deliberate scope boundary

Project lifecycle and project-isolated UI are implementable here. Automatic repository binding, provider observation, activation witnesses, product-contract compilation, and goal-scoped projections require daemon-owned writers that current production code does not expose. Their buttons must remain disabled with exact missing-authority state; the manager must never reuse `live-dispatch.ts` development witnesses to make a fresh project look activated.

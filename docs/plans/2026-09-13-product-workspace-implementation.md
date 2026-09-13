# Product workspace implementation

Date: 2026-09-13. This records the implemented workspace replacement and the limits of its evidence. The full acceptance criteria in the [proposal](2026-09-13-prd-to-product-workspace-proposal.md) remain the product target.

Initial verification used the shared checkout at HEAD `8b80d247e2408c20333362d9d34ea3302540b2eb` with this task's changes uncommitted. The subsequent [integration audit](2026-09-13-control-room-integration-audit.md) records additional fixes and fresh gates before commit.

## Resulting behavior

Products is the ordinary project entry. Opening one product shows its recorded artifact, with Requirements, Readiness, and Production record available beside it. Technical tools are secondary navigation. The old `v1` entry and its dedicated development shim are removed; manager precedence, runtime pairing, and the production fixture fence are preserved.

The canvas distinguishes source text, a proposed/current definition, an authored design, implementation metadata, captured previews, and released source. A release receipt is not described as an environment deployment. Unsupported requirement-to-implementation or screen links remain explicitly absent; document-wide coverage cannot establish a graph/run-specific link.

The design canvas reads the goal's authored design independently of compilation, so a source-created draft run does not hide an existing design. The Build plan reads its own immutable design selection by planning run: a newer authored revision, an absent pinned design, or an unreadable binding never substitutes for that selection. Authored artifacts carry no inferred planning-run binding, and an already selected older design remains a historical observation when a newer revision arrives.

Public `product`, `artifact`, and `inspect` queries restore subject and selection through refresh and browser history. Product links resolve against the authenticated project catalog. Invalid or missing subjects remain unavailable rather than opening another product. An unavailable historical artifact retains its selected identity.

Initial artifact selection merges into the latest same-product query only while no artifact has been selected. It preserves an inspector opened during loading and cannot overwrite an explicit artifact, Back navigation, invalid links, another product, or a newer authenticated setup.

The workspace owns its surface feed. Opening Technical detail reuses that frame. Definition discovery runs before compilation exists and uses the daemon's authority plane. An actionable definition waits for an exact reference from the coordinator; an independent first read cannot expose an approval that a later coordinator answer remounts. A viewed definition refuses replacement by a different current revision. Plan approval requires the exact offered run and its complete sealed, reviewable body; an offer alone cannot enable approval.

Current actions are explicitly scoped to current work. Old or unbound previews/releases do not mount current plan, verification, or delivery controls. Switching session, run, contract, candidate, or selected artifact resets held action state. Payload identity is checked again at the canvas boundary.

Within that scope, visited action panels remain mounted while another record or inspector is shown. Hidden panels are inert and unvisited panels do not mount. A pending delivery therefore stays pending when the operator closes the inspector or returns from Checks; selected definitions retain one canvas review instance.

Temporary criterion or preview read failures also preserve visited pending actions. Their last established identity retains component lifetime only; unavailable observations disable and hide the controls. Recovery reveals the same pending or completed decision, while a real session, run, selection, contract or candidate change still resets the record.

Retained plan and pinned-design reads refresh when the same run's offered ledger version changes, including draft-to-review transitions. Rotating offer IDs do not cause rereads. The workspace Refresh button also retries these reads without remounting their panels; entered reasons, pending decisions and exact refusals survive.

When an approved proposal leaves the pending-definition read, the exact reviewed card and any outstanding decision remain mounted. Both the product canvas and the Original PRD's Definition record retain the accepted result or exact refusal. Historical display stays read-only, including guards in approval and clarification ports. An absent pending proposal alone never establishes approval.

## Preview execution

The daemon extracts and measures the requested Git commit before starting a preview. It does not execute the mutable checkout while stamping a different requested SHA onto the receipt. Capture storage remains separate from the source extraction, and source lifetime follows the supervised process. Missing/unmeasurable source refuses before process or browser effects.

Default package-script previews prepare dependencies from an unambiguous committed npm or pnpm lockfile inside the extracted directory, with install lifecycle scripts disabled and a local cache. Pnpm file hooks are also disabled, and its dependency and virtual-store directories are pinned inside the extraction. Automatic preparation refuses local dependency inputs or installed links that escape the extraction. Structured YAML parsing preserves pnpm importer-relative paths while refusing escaped local inputs. A selected `preview` script runs a recorded build script first when one exists. Explicit contract commands retain their own preparation behavior. Tracked source is verified after preparation, after startup before capture, and after capture before recording success. Failed preparation cuts off the product process and capture; observed startup/capture drift cannot produce a successful receipt.

This establishes the starting source tree, not a hermetic build or immutable runtime. Dependency preparation and arbitrary product scripts remain distinct from Git source identity. Lockfile-less dependency projects and unsupported preparation requirements need an explicit configured command.

The V2 command provider now forwards the configured preview runtime. Executable directives from the latest approved V2 definition are **not** substituted for a candidate's configuration: the current V2 planning path does not establish the necessary candidate-to-contract binding. See the [delivery policy audit](2026-09-13-product-delivery-policy-audit.md).

## Verification and coverage

Focused tests exercise subject/plane isolation, stale responses, complete-plan approval, exact artifact payloads, historical action cutoff, activation readback, and shared polling. Browser tests exercise desktop and 390px navigation, focus restoration, source/design distinctions, failed/corrected candidate examples, and refresh/Back without dispatching fixture work.

The migrated daemon browser lane retains actual pairing, observed board status/proof, and explicit refusal checks. The retired nine-click development command lane is replaced by the shipped activation and source-product creation journey; daemon planning invariants are tested separately. This is a coverage change, not evidence that those old development controls still exist.

The real-daemon definition approval, local PRD-to-repository/product, and preview approve/reject journeys have run. Preview fixtures contain their declared planner/operator assistance. The live-provider harness also supplies its scaffold, approved checks and assisted review submission; provider generation does not establish an autonomous review workflow. These journeys do not establish a wholly autonomous first-product journey or an external deployment.

The live-provider harness preserves the generated package manifest and lockfile inputs when adding its HTTP surface. An actual offline frozen-lock check passes for that fixture and refuses a deliberately changed dependency. Preview preparation retains its production lockfile checks. The criterion harness requires the accepted command's exact run, goal, plan and SHA, and waits for durable run completion as well as its receipt rows before stopping the wrapper. The last receipt alone does not establish completed coverage. A successful provider launcher remains alive until its assisted review is accepted and acknowledged with that invocation's nonce, with a 60-second bound; stale acknowledgments cannot retire the current seat before review.

An earlier live-provider run landed three nodes and reported 8/8 verified criteria on its integrated commit, then refused preview while the fixture manifest and lockfile disagreed. The final attempt with the corrected harness reached browser bootstrap, definition approval and plan approval, but its first real Claude subprocess exited 1 without producing a module. It stopped with `SEAT_PROVIDER_COMPLETION_UNPROVEN`. That attempt does not establish the complete generation-to-preview journey; the separately passing preview approval/rejection tests remain separate evidence.

Fresh completed gates at this checkpoint:

| Gate | Result |
|---|---|
| Workspace-wide typecheck | Passed |
| Control Room app tests | 230 files, 2,925 tests passed on the final navigation correction |
| Foundation | 35 files, 756 tests passed |
| Store | 54 files, 709 tests passed |
| Security | 12 files, 1,003 tests passed |
| Packaging and distribution integration | 6 files, 567 tests passed; preview runtime imports passed under Node |
| Browser harness and scheduler boundary tests | 10 files, 194 tests passed |
| Final live-provider harness corrections | 4 files, 27 tests passed; browser lane typecheck passed |
| Final workspace browser checks | Desktop at 1,440px and phone at 390px passed; screenshots visually checked, including the wrapped supplied-facts control |
| Final production bundle smoke | 2 tests passed; the last build left `apps/control-room/dist` in production mode |
| Original browser suite, reconciled across runs | 51 passed, 2 unresolved failures, 1 existing opt-in skip out of 54 cases |
| Daemon | 627 files, 11,179 passed, 21 skipped; final pnpm flags followed by 22 files and 276 affected tests passed |
| Root tests | 451 files passed, 10,591 tests passed, 50 skipped; one cutover census failure described below |

The original browser run passed 43 cases, failed 10 and skipped 1. Targeted reruns recovered 8 failures; the remaining two are the local release-remote harness and the live-provider failure described below. These are reconciled results across runs, not a fresh all-green run of 54 cases. Final workspace and production smoke reruns overlap that original roster. Shared-checkout verification is not a release, clean-checkout certification, or deployment claim.

## Remaining full-product acceptance

- Artifact observations are bounded, in-memory records. They do not provide a durable product-version catalog across browser restarts, nor immutable historical screenshot bytes. Unavailable selections remain honest after refresh.
- Durable product/revision membership, defect-versus-scope-change feedback, and cross-command recovery still need their backend workflow. Existing command controls retain their own reconciliation; there is no new durable end-to-end product workflow.
- V2 capability claims remain per reader/action. V1 criterion evidence is never promoted to V2 verification. Complete V2 compilation and candidate-bound preview directives remain outside the proven journey.
- Novice participant observations and a complete external release/deployment journey remain acceptance obligations. Fixture screenshots and local tests cannot replace them.
- The final live-provider journey is blocked by `SEAT_PROVIDER_COMPLETION_UNPROVEN` after the actual provider exited 1 with no module. The corrected full chain remains unproven beyond that seat.
- Positive publication browser evidence requires an admitted remote. The audit now tests the local-path refusal and downstream cutoff by default, while retaining the positive assertions behind an explicit remote opt-in. See [release browser coverage](../../tests/e2e/control-room/release-approval.md).
- The initial root cutover census failure was repaired in the audit by declaring an exact `.claude/worktrees` exclusion. The entry/depth limits and neighboring repository content remain covered; the fresh root suite passed.

The [engineering plan](2026-09-13-prd-to-product-workspace-engineering.md) distinguishes this working interface replacement from full P1-P12 acceptance. The remaining items above are not marked complete by the UI refactor.

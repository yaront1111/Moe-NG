# Moe Next: the PRD becoming the product

**Goal:** Make the transformation from an agreed PRD into a usable, checked product the organizing idea of Moe Next.

**Status:** Product concept accepted in the conversation on 2026-09-13. The interaction details and delivery sequence below are recommendations for review. This is a design proposal, not an implementation or a claim of validated usability.

**Architecture:** One persistent product workspace presents the agreed intent, concrete artifacts, and delivery evidence for an explicitly identified body of work. Existing execution and approval authorities remain responsible for effects; a shared presentation model explains their results.

**Tech stack:** Existing React, TypeScript, Vite, pnpm workspace, daemon, contracts, and presentation-model packages.

**Evidence:** Source inspection at `cb330a946312747499fe68812c6d9053546ea2d6`. No application changes or runtime gates were performed for this proposal. The [engineering companion](2026-09-13-prd-to-product-workspace-engineering.md) records verified seams, capability gaps, and implementation dependencies. The existing [product vision](../VISION.md) remains a separate source of product intent; its historical implementation notes require current-code verification.

The final source-delta check at `1bf17ae5d971b473f75dea39821a6b03f9a3085b` found only a concurrent activation-resume fix and its test. The identity, preview, release and deployment paths cited in this proposal were unchanged. Re-measure the source before implementation.

## 1. The product decision

Moe takes a PRD and produces software. The interface should make that transformation visible and inspectable.

The enduring object is **the product being made**. Its requirements, proposed design, current implementation, checks, and delivered versions belong together. The operator should be able to recognize the same product when returning tomorrow, when a build fails, and when a later version is being developed.

The physical-world property worth borrowing is a visible relationship between input, work in progress, and output. We should express it through concrete artifacts, stable locations, and meaningful changes. A literal factory illustration, new tutorial, or renamed collection of technical panels does not establish that relationship.

The intended feeling is:

> This is my product. I can see it taking shape. I can inspect how it matches what I asked for.

This gives the redesign a practical test: every prominent element should help someone understand the requested product, inspect the emerging result, make a product decision, or use the delivered result.

## 2. Decisions to carry into design

1. **One product, one workspace.** Keep the product name and viewed version visible across every artifact and decision.
2. **Give the product most of the screen.** Requirements and readiness are contextual views; they are not two permanent dense columns surrounding a tiny preview.
3. **Show real outputs at every stage.** Before runnable software exists, show the actual source, structured product definition, or authored design. Label each accurately.
4. **Keep intention connected to result.** A requirement should lead to its implementation and checks where those relationships are recorded. Missing relationships remain visible.
5. **Distinguish agreed scope, current work, and delivered software.** A new draft or failing candidate must not erase the last delivered version or inherit its approvals.
6. **Keep the product primary and its production record inspectable.** Selecting a stage in that record opens its artifacts. It does not authorize work or force the person through a wizard.
7. **Keep decisions with the thing being decided.** Review a design beside that design, and a release beside its candidate and destination.
8. **Represent iteration explicitly.** Refinements, defects, scope changes, and later releases have different consequences. They must not all become an undifferentiated retry.
9. **Use product changes as the default activity.** Report what became usable, what failed a check, or what changed in scope. Worker and command activity remains inspectable.
10. **Let unknowns remain understandable.** Say which result cannot currently be checked and retain the identity of the last known artifact. Do not manufacture reassuring progress.

## 3. The product workspace

### Products home

The front door contains recognizable products: name, short purpose, an actual design/preview image when available, current work, and the last delivered result. A product without an image uses a restrained text representation; the interface does not fabricate a screenshot.

The primary creation action is **New product**, beginning with the PRD. Existing work can be opened in the same workspace once its bindings are known. Machine setup appears when it is required for that product; it does not occupy the home of every already-running product.

A compact attention indicator can collect outstanding decisions across products. Opening one returns to the corresponding artifact in its product workspace. The collection is a shortcut, not a competing organizational model.

The current project manager lists local workspaces rather than durable products. A global Products home therefore requires a real product index and authorized summaries; it cannot be implemented by renaming every folder or collecting credentials from project tabs. The first implementation may remain within one project origin while the index is added.

Existing work without a source binding stays accessible as existing work. Adopting it into a product must preserve its goal IDs, evidence and history; missing PRD or lineage cannot be filled by guessing. Retirement of an old screen never means deletion or reinterpretation of its durable records.

### Workspace structure

Illustrative layout, not a production screenshot:

```text
Products / Bicycle-shop booking           Viewing: Current work
First release                            Delivered version: none

Product                       Requirements      Readiness
Production record: Checking the first release       View
------------------------------------------------------------
|                                                          |
|                  THE PRODUCT ARTIFACT                     |
|                                                          |
|     Authored design, real preview, or concrete output     |
|               belonging to the selected version          |
|                                                          |
------------------------------------------------------------
Current work: Checking appointment confirmation
Changed: Booking requests can now be submitted
```

Product is the persistent default destination. The compact production record supplies orientation and opens the stage artifacts when requested. The canvas dominates. Opening Requirements or Readiness reveals one contextual inspector beside the canvas. An explicit compare action can temporarily split two artifacts; closing the comparison restores the same place.

The selected artifact and the engine's current activity are distinct. A user can read the original PRD while Moe checks a candidate. Polling must not move the user to another stage, replace the version they are reviewing, reset scroll, or steal focus. When a newer artifact becomes available, show an explicit New working version available action. Retaining review context must not conceal progress.

Requirements opens the approved definition associated with the viewed artifact, with its original PRD source within reach. It does not silently switch to today's newest definition. Readiness shows applicable checks and decisions for that same artifact. Proposed scope changes and results for other candidates appear as separately identified context.

The header always identifies whether the canvas shows a **source**, **proposal**, **approved design**, **working preview**, or **delivered version**. A version remains visible even when its runtime becomes unavailable.

### Before a product can run

Use the most concrete relevant artifact that actually exists on the first visit. Thereafter preserve the user's selection.

| Available evidence | Canvas | Important boundary |
|---|---|---|
| Only the imported PRD | Readable source and its sections | Importing does not mean Moe has understood or approved it |
| Structured definition | Users, capabilities, relationships, constraints, and unresolved choices extracted into a proposal | Proposed interpretation remains distinguishable from the source and the approved definition |
| Authored design | Actual screens, journeys, or system design | A mockup is identified as a design; a structured design record is not advertised as an interactive prototype |
| Implementation without runnable output | Capabilities and their recorded implementation/check state | A completed task does not by itself establish a working user capability |
| Runnable candidate | Actual preview or a captured image with an explicit Open preview action | Captures identify their candidate and observation time; an image is not a live session |
| Delivered version | The verified delivery artifact and its destination | A pull request, downloadable package, deployed site, and healthy running service remain different outcomes |

A web product makes a useful first complete design case. The model must still support a backend service or library without inventing a website. Those products need truthful output renderers, such as their API definition, documented examples, or package artifact. They can arrive after the first web-product slice; unsupported renderers show the existing concrete artifact and links.

## 4. Stages produce objects

The production record contains six kinds of output. It is secondary to the persistent Product view, not six competing primary screens or a six-state global completion enum. Several kinds of work can overlap, and earlier outputs can receive revisions.

| Place | Object the user inspects | Product judgment | What establishes its status |
|---|---|---|---|
| PRD | Original source and source revisions | Is this the input I intended to give Moe? | Durable source binding and readable bytes |
| Definition | What the product must do, for whom, and under which constraints | Is this the product we intend to build? | Exact contract revision, clarification state, and its human decision |
| Design | Proposed appearance, interactions, and structure | Is this how the product should work? | Actual design version and the applicable design/plan approval |
| Build | Current implementation organized by product capability | What parts of my product exist now? | Recorded implementation relationships and available artifacts |
| Checks | Requirement results, functional checks, and required quality evidence | What has been demonstrated, and what remains uncertain? | Evidence applicable to the selected requirement and candidate |
| Release | Candidate, destination, release requirements, and delivery result | What exactly am I making available, and where? | Applicable release/deployment decisions and durable outcomes |

Preview is a primary product artifact on the Product canvas whenever available and selected. Build and Checks records provide its context; they are not places the user must discover to find their product. A preview is not a promise that all verification or release work is finished.

Stage labels can say Draft, Needs review, Accepted, Working, Needs checking again, or Unavailable when supported by facts. Selecting a completed stage remains possible. The required checks for a release remain visible even if the current activity happens elsewhere.

Where an existing explicit policy allows an automatic decision, preserve that authority and identify the result as a policy decision. It must not appear as a personal approval the user never gave.

## 5. The signature interaction: follow a requirement into the product

For an illustrative requirement, **Customers can request an appointment**, the inspector should connect:

```text
Agreed requirement
    -> design artifact, if explicitly linked
    -> implementation work
    -> applicable checks
    -> candidate containing that work
    -> delivery of that candidate
```

The user should be able to select the requirement and see what exists, try the relevant artifact when available, and inspect what has been checked. Selecting an explicitly mapped feature in the product should lead back to the same requirement.

Two levels of capability are necessary:

- **First:** show the relationships the current engine actually records, including criteria, implementation nodes, and evidence. If there is no design or preview-location link, say so and open the related artifact as a whole.
- **Later:** add durable artifact and interaction anchors, such as a named screen or journey in a particular design/preview version. Only then highlight the corresponding region or deep-link to the exact interaction.

Text similarity or an agent's suggestion can propose a relationship. It cannot silently become a verified link. Some requirements are nonvisual, such as access control or recovery; their destination is an appropriate check or artifact rather than a fabricated screen highlight.

Requirement state must distinguish **not implemented**, **implemented but not checked**, **passed the applicable checks**, **failed a check**, and **needs checking again**. Availability of a screen and quality of its behavior are separate facts.

Do not turn task counts into a product-completion percentage. If counts are displayed, name their denominator and applicability, for example: “8 of 12 required checks passed for this candidate.” This is neither elapsed-time progress nor a claim that eight user capabilities are complete.

## 6. Changes and versions

Maintain distinct references for:

1. The currently agreed product definition.
2. Any proposed change to that definition.
3. The approved scope under which current work was actually planned.
4. The candidate being inspected.
5. The last delivered artifact and each known environment's current deployment.

The interface should use comprehensible labels such as Current work, Delivered version, and Proposed changes. It should not invent semantic version numbers or treat the newest timestamp as evidence of ancestry.

The underlying engine has goals and exact contract bindings. It does not yet establish every cross-goal product/version relationship required by this concept. Initially, a workspace must use the existing project-instance and goal identity. A durable product/revision relationship is required before separate goals are shown as successive versions of one product. The engineering companion specifies that boundary.

### Three different kinds of feedback

| Feedback | Expected behavior |
|---|---|
| “The appointment form does not submit,” where submission is already required | Record a defect against the inspected version; route repair against the existing agreed requirement |
| “Make this button more prominent” | Bind feedback to the inspected artifact; determine whether it fits the approved design or requires a design revision |
| “Also take payments,” where payments are excluded | Propose a scope change with its consequences; preserve the currently approved scope until the required decision |

Not every correction creates a new PRD. Material scope changes must not be smuggled into repair work. Feedback records both the exact originating artifact and the proposed repair target. When an old delivery is inspected, its requirements remain visible, while the intended repair can target a separately named current candidate. Classify defect versus scope change against that repair target's approved scope. Where the target or classification is uncertain, the proposed interpretation remains visible before it changes authority.

A recorded rejection is not evidence that a repair has started. Feedback must show distinct outcomes: recorded, awaiting a decision or work assignment, repair in progress, and ready to inspect again. Refresh must recover those outcomes from durable state.

Inspecting an old version does not make it the working version. Comparing versions does not release or roll back anything. Release and rollback controls name the candidate, destination, and consequences separately.

## 7. A complete example to design and test

Use a bicycle repair shop's appointment-request product. The source explicitly asks for a request form and shop confirmation; online payment is excluded. These are illustrative prototype facts, not claims about a current Moe project.

### First arrival

The owner imports the PRD and opens the named product workspace. The document is visible as the actual input. There is no fake preview and no requirement to choose a worker, run, or node. Any required local setup is connected to this product and reports actual progress and partial outcomes.

### Definition and design

Moe's proposed definition shows the customer and shop journeys, required capabilities, excluded payment, and unanswered questions. The owner reviews the concrete definition. When a design exists, the same workspace shows its actual layout and interactions with the applicable decision nearby.

### Product taking shape

The appointment form becomes available in a candidate. The owner opens it from Build. The requirement inspector shows submission implemented and the remaining applicable checks. “Email confirmation is not connected” remains visible if that part is required; a successful screen render must not hide it.

### Failure and correction

A check finds that appointments near midnight use the wrong date. The requirement remains the same. The workspace shows the failed behavior, the candidate it belongs to, and the repair state. A later candidate can be compared with the earlier one, and fresh applicable checks establish whether the defect was repaired.

### Scope change

The owner asks to add payments. That request conflicts with the excluded scope. Moe presents a proposed scope/design change and preserves the approved appointment product and its existing delivery. The UI does not quietly reinterpret old approvals as permission for the new feature.

### Delivery and return

The release view identifies what is being delivered and the actual destination. A prepared pull request is described as such. A deployed version is described as deployed only after its receipt; present availability depends on current observations. Returning later shows the delivered appointment product separately from the payment work in progress.

This story must work across browser refresh, a lost connection, and a pending decision. A happy-path animation is insufficient evidence that the product model works.

## 8. Decisions, failure, and confidence

An approval belongs to its exact artifact and version. Show the thing, the material unresolved issues, the consequence of approving, and the decision controls together. Technical evidence is inspectable without requiring the user to read internal codes first.

The outstanding-decision count includes actions the person can actually take. Background rebuilding, a historical rejection, or an automatic retry is activity rather than a new decision. Unavailable decision reads must not be rendered as a confirmed count of zero.

Use a compact, product-specific problem statement: what is affected, what is known, who can act, and the supported next action. For example, a disconnected preview can remain an identifiable candidate with its last capture; it cannot claim the application is currently reachable.

Keep the exact refusal code and refusing layer in technical details. Unknown command outcomes require reconciliation before retry. A spinner ending or a request timing out does not establish that an operation was refused or did nothing.

If two tabs act on different versions, the older view should retain its review context, report that it is no longer current, and require the applicable fresh decision. It must not silently switch the target of an approval.

## 9. Visual and interaction direction

The distinctive element is the evolving product artifact. Everything around it should make that artifact easy to recognize and inspect.

- Use a stable, mostly unframed canvas, restrained separators, and generous readable spacing. Avoid giving every fact an identical card.
- Reuse the locally bundled IBM Plex Sans for body text and Space Grotesk for product identity. Reserve IBM Plex Mono for technical inspection. Raise ordinary reading text from the current compact dashboard scale toward 16px; validate rather than compress to fit panels.
- Start from six existing color tokens: surface `#fffaf2`, solid artifact surface `#ffffff`, ink `#1f2a2e`, teal action `#0f7f7a`, verified `#1f7a57`, and failure `#a83232`. Use the existing theme variants and test contrast. Remove decorative gradient/glow effects from the workspace so product screenshots carry the visual character.
- Keep the Product destination, inspector controls, and production-record entry in consistent locations. Motion should explain a user-requested comparison or artifact change; it must not imply work merely by animating.
- Preserve native keyboard behavior, readable labels, visible focus, reduced motion, and a logical reading order. Status never relies on color alone.
- At wide widths, allow one contextual inspector beside the artifact. At smaller widths, open the inspector as a dedicated view retaining product/version context. At 390px, the shell must not scroll horizontally; an intentionally fixed-size product preview needs its own clearly separated viewport.

The initial preview implementation should reuse safe captured artifacts and an explicit Open preview action. Embedding generated applications requires a separately verified origin, credential, content-security, and messaging boundary. It must not be achieved by relaxing Control Room isolation merely to fill the canvas.

Preview availability also needs its own lifecycle. The current supervisor stops the preview process on either approval or rejection. The proposed workspace must retain the artifact and decision while reporting actual runtime availability; a durable preview record is not proof that its process is still serving. Reliable reopening of a preview is a workflow obligation, not a refresh of its old link.

## 10. Scope and delivery sequence

The destination is a complete PRD-to-product experience. Implementation should arrive as coherent working slices with an explicit end condition for replacing the old composition.

The source audit found three particularly important gaps beneath the desired experience: a preview receipt names a commit without the inspected runner establishing that its workspace is that commit; the release dossier does not enforce an approved preview of the identical candidate; and the deployment service can record a missing release decision as a note. Those are observations about inspected paths, not live reproductions. They require regression tests and explicit server-side binding work before the new product release path can claim that the reviewed product is the delivered product. A more attractive readiness display cannot supply those guarantees.

1. **Design proof:** a clickable prototype of the example above, including incomplete, failed, revised, and delivered states. Evaluate the product model before polishing a theme.
2. **Presentation foundation:** separate required live reads from mounted technical panels; add explicit subject/version identity and a shared product presentation model. Existing screens can consume it during migration.
3. **First usable workspace:** use an existing source-bound goal with a pending Product Contract decision on one verified production authority plane. Show its actual proposed definition as the central artifact with the source and requirements alongside it. Review and approve that exact revision through the existing permitted human path; after daemon confirmation, the same artifact shows its accepted state. Refresh must recover the same decision, and a changed revision must refuse the stale action. This is a concrete definition-to-approved-definition slice, not an arbitrary evidence browser. Other recorded artifacts remain inspectable; exact-candidate preview claims remain unavailable until the preview binding gap is closed.
4. **Complete first-product journey:** connect product creation/setup, the real paired-browser approval path, trustworthy preview provenance, feedback-to-repair, and release/deployment. These are required workflow deliverables where current capabilities have gaps.
5. **Product continuity:** introduce the durable product/revision links and authorized catalog needed for later goals, version history, comparison, and a real Products home across projects. The existing delivered version stays identifiable.
6. **Advanced inspection and retirement:** retain useful task/agent/technical evidence views under the product context, then remove superseded ordinary screens and duplicate state derivation after equivalent journeys pass.

Do not build another permanent v3 shell alongside v1 and v2. Replace the current application's composition incrementally. The engineering companion names the dependency order and the points where an apparent UI task is actually a backend contract or workflow task.

A useful first live slice is deliberately smaller than the final promise. It demonstrates the new organizing model using real state. It is not called completion of the refactor until setup, review, feedback, delivery, and return visits also work.

## 11. How we will know it works

These are proposed acceptance targets, not measurements already obtained. A small formative study can reject a confusing concept; it cannot prove usability for every user.

| ID | Acceptance criterion | Evidence to collect |
|---|---|---|
| P1 | A first-time participant can identify the product, the artifact being shown, and whether it is delivered within ten seconds | Unprompted explanation; target at least four of five participants in an initial formative round |
| P2 | A requirement's supported artifact/evidence links or their explicit absence are reachable within two interactions | Recorded task completion, including a nonvisual requirement |
| P3 | A PRD, design, captured image, runnable preview, pull request, and live deployment are distinguishable | Correct explanations across mixed-state prototype examples |
| P4 | A user can inspect the agreed requirement and try the related available result without visiting a worker/task dashboard | Complete source-to-result journey |
| P5 | A defect repair preserves the agreed scope; a material feature addition exposes a proposed revision | Both feedback examples retain their exact version and decision history |
| P6 | The delivered version remains identifiable while a later candidate fails or scope changes | Current-work/delivered comparison and navigation test |
| P7 | Refresh, Back, and a direct product link preserve the correct subject and selected artifact | Browser tests with multiple goals and project instances |
| P8 | Different displays agree on outstanding decisions and applicable evidence | Model tests for incomplete, stale, mixed-version, and rejected states |
| P9 | Approval cannot spend a grant for another subject or silently switch to a newer version | Exact refusal code/layer and durable receipt assertions |
| P10 | A lost command response is reconciled without falsely claiming success, refusal, or a safe blind retry | Delayed response, refresh, duplicate click, and two-tab tests |
| P11 | A newcomer can inspect requirements, try a result, and review readiness at 390px using touch or keyboard | Visual and interaction checks; no shell overflow or lost focus |
| P12 | The complete first-product journey works through the shipped human session and actual delivery boundary | Real browser actions plus daemon receipts; injected-provider or fake-deployment evidence is labeled separately |

Ask participants to use the interface before explaining it. Useful prompts are “What do you think you have here?”, “Find what was requested for appointments”, “Show whether that works”, “Request this correction”, and “What would this release action make available?” Watch their actions and interpretation, not whether they like the factory metaphor.

## 12. The immediate implementation decision

Build and review **one product workspace across several real product states**, rather than designing the home screen in isolation. Use the booking example for the interaction prototype and one existing source-bound goal for the first live projection.

The first working artifact should establish the connection between PRD, product capability, concrete output, and applicable evidence. That is the foundation on which the rest of Moe Next becomes understandable.

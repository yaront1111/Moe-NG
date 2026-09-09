/**
 * RECORDED DAEMON FRAMES - the live UnAI loop, not hand-written.
 *
 * Captured on 2026-09-05 off a shipped `apps/daemon/src/daemon-main.ts` running on the LIVE
 * store D:/projexts/UnAI/.moe-next/store.sqlite (MOE_PROJECT_ID=unai), by the drive recorded in
 * row comment comment-41108de3b6b44efc844fec78a522bcee on task-8fdd81b8:
 *   COVERAGE_FRAME - POST /documents/coverage/read  { goalRef: "goal-c9d9850b-ccef-4c14-8893-a162e3aaf679" }  -> 200
 *   CATALOG_FRAME  - POST /goals/read               {}                                                        -> 200
 *
 * VERBATIM, WITH ONE DISCLOSED TRUNCATION. Every field is the daemon's own bytes except
 * `sections.entries`, cut from its real 431 advisory PRD-section rows to the first 3.
 * Nothing in `deriveGoalStatus` or `deriveGoalCatalog` reads `sections`; the full block is 38 KB
 * of advisory prose and carrying it would bury the 7 KB that decides the assertions. The count
 * is stated here so the truncation is a disclosed edit, never a silent one.
 *
 * These are fed through the REAL decoder (`mapDocumentCoverageAnswer`), so a frame that drifted
 * from the daemon's shape would fail at the decoder rather than pass a softened assertion.
 */

export const COVERAGE_FRAME: unknown = Object.freeze({
  "contracts": [
    {
      "contractId": "uai-contract-508a4f73",
      "gate1": "APPROVED",
      "plane": "V1",
      "requirements": [
        {
          "criteria": [
            {
              "criterionId": "crit-evidence-survives-throwing-extractor",
              "nodeKey": "node-uai-evidence-ledger",
              "statement": "With an injected extraction hook that throws, ingest() does not reject and getEvidence(evidenceId) still returns a record deep-equal to the one ingest() returned - a failed extraction removes nothing and invalidates nothing.",
              "status": "VERIFIED"
            }
          ],
          "requirementId": "req-evidence-durable-through-extraction-failure",
          "statement": "Failed extraction must not remove or invalidate evidence (PRD §40 FR-005): evidence MUST remain durable even if semantic processing fails (PRD §11.1)."
        },
        {
          "criteria": [
            {
              "criterionId": "crit-stored-record-is-frozen",
              "nodeKey": "node-uai-evidence-ledger",
              "statement": "Records returned by ingest() and getEvidence() are frozen (Object.isFrozen returns true) and a strict-mode field assignment on a returned record throws; a later getEvidence() returns the original field values unchanged.",
              "status": "VERIFIED"
            }
          ],
          "requirementId": "req-evidence-immutable",
          "statement": "Evidence is an immutable representation of what entered Uai (PRD §11.1): evidence is immutable while interpretation is versioned, and re-extraction creates new claims rather than mutating stored evidence (PRD §22.1)."
        },
        {
          "criteria": [
            {
              "criterionId": "crit-owner-scope-isolation",
              "nodeKey": "node-uai-evidence-ledger",
              "statement": "After the identical payload is ingested under owner scopes A and B, listEvidence(A) returns exactly one record whose ownerScopeId is A, and no record created under scope B appears in a scope-A read.",
              "status": "VERIFIED"
            }
          ],
          "requirementId": "req-evidence-owner-scoped",
          "statement": "Every evidence item belongs to an owner scope (PRD §30.1, §40 FR-100) and every owner-scoped read must enforce that scope (PRD §34 rule 1)."
        },
        {
          "criteria": [
            {
              "criterionId": "crit-ingest-persists-before-extraction",
              "nodeKey": "node-uai-evidence-ledger",
              "statement": "In src/kernel/evidence.test.ts, a ledger from createEvidenceLedger (src/kernel/evidence.ts) whose injected extraction hook returns a promise that never settles: ingest() still returns a record carrying an evidenceId, and getEvidence(evidenceId) returns that record in the same tick - persistence never waits on semantic processing.",
              "status": "VERIFIED"
            }
          ],
          "requirementId": "req-evidence-persisted-before-extraction",
          "statement": "The system must synchronously preserve raw evidence before semantic processing and return the evidence id and ingestion status before that processing (PRD §40 FR-001, §35.1); background extraction must never block raw evidence persistence (PRD §41)."
        },
        {
          "criteria": [
            {
              "criterionId": "crit-observed-at-is-ledger-assigned",
              "nodeKey": "node-uai-evidence-ledger",
              "statement": "observedAt is assigned by the ledger at ingest and is independent of the caller's occurredAt: a record ingested with occurredAt '2020-01-01T00:00:00Z' carries an observedAt inside the wall-clock window the test captures around the ingest call (PRD §11.1, §12.2).",
              "status": "VERIFIED"
            },
            {
              "criterionId": "crit-record-carries-minimum-fields",
              "nodeKey": "node-uai-evidence-ledger",
              "statement": "A record returned by ingest() has every §11.1 minimum field present and not undefined except the nullable actorEntityId: evidenceId, ownerScopeId, sourceType, sourceConnectorId, sourceExternalId, occurredAt, observedAt, rawObjectRef, contentHash, sensitivity (one of NORMAL / PRIVATE / RESTRICTED per §30.3), allowedPurposes, ingestionVersion.",
              "status": "VERIFIED"
            }
          ],
          "requirementId": "req-evidence-required-fields",
          "statement": "Evidence must retain source, actor, occurred time, observed time, sensitivity, and owner scope (PRD §40 FR-003), carrying the §11.1 minimum fields: evidenceId, ownerScopeId, sourceType, sourceConnectorId, sourceExternalId, actorEntityId, occurredAt, observedAt, rawObjectRef, contentHash, sensitivity, allowedPurposes, ingestionVersion."
        },
        {
          "criteria": [
            {
              "criterionId": "crit-changed-content-is-a-new-record",
              "nodeKey": "node-uai-evidence-ledger",
              "statement": "Ingesting the same externalId twice with different content and no idempotencyKey yields two distinct evidenceIds with different contentHash values, both retrievable through getEvidence, because the §33.2 uniqueness tuple includes contentHash.",
              "status": "VERIFIED"
            },
            {
              "criterionId": "crit-duplicate-ingest-is-one-record",
              "nodeKey": "node-uai-evidence-ledger",
              "statement": "Ingesting byte-identical input twice (same ownerScopeId, connectorId, sourceType, externalId and content) returns the same evidenceId both times, and listEvidence(ownerScopeId) still contains exactly one record.",
              "status": "VERIFIED"
            }
          ],
          "requirementId": "req-idempotent-ingestion",
          "statement": "Evidence ingestion must be idempotent (PRD §40 FR-002, §34 rule 2, §36.1): required uniqueness is (ownerScopeId, connectorId, sourceType, externalId, contentHash) (PRD §33.2), so redelivering an identical source item must not create a second evidence record."
        },
        {
          "criteria": [
            {
              "criterionId": "crit-anchor-attaches-to-existing-evidence",
              "nodeKey": "node-uai-evidence-ledger",
              "statement": "addSourceAnchor({ evidenceId, anchorKind, anchor, normalizedText }) returns an anchor with a fresh surrogate sourceAnchorId and the stored anchorKind, anchor and normalizedText; listSourceAnchors(evidenceId) returns it; addSourceAnchor for an unknown evidenceId throws instead of storing an orphan anchor.",
              "status": "VERIFIED"
            },
            {
              "criterionId": "crit-many-anchors-per-evidence",
              "nodeKey": "node-uai-evidence-ledger",
              "statement": "Two anchors added to one evidence record for different spans receive distinct sourceAnchorIds and both are returned by listSourceAnchors(evidenceId), so one evidence item carries many precise locations (PRD §11.2).",
              "status": "VERIFIED"
            }
          ],
          "requirementId": "req-source-anchors",
          "statement": "A source anchor is a precise location inside evidence - message-body span, email paragraph, document page range, calendar field, connector JSON path - that claims point to when feasible (PRD §11.2); source-anchor creation belongs to the evidence service (PRD §36.1) and each anchor references its source item (PRD §33.2)."
        }
      ],
      "revisionDigest": "88ed66d27771c0b721d7c723c0a0cb1934fa4af7d13210aca8e9d989e4fd766c",
      "revisionId": "uai-revision-1bec6f04"
    }
  ],
  "document": {
    "byteLength": 117563,
    "contentSha256": "e1033b0dbb2c5fb4d6b4fe7e7469001b36ae2f5643d8c062311d71e6c37fd93e",
    "displayPath": "PRD.md"
  },
  "goals": [
    {
      "goalId": "goal-c9d9850b-ccef-4c14-8893-a162e3aaf679",
      "lastActivityAt": "2026-09-04T08:20:15.195Z",
      "lifecycle": "EXECUTION_ENABLED",
      "planningRunRef": "run-c9d9850b-ccef-4c14-8893-a162e3aaf679",
      "title": "UnAI kernel from PRD (real seats)"
    },
    {
      "goalId": "goal-da4b8e1e-89df-46fe-9555-e58067af1f27",
      "lastActivityAt": "2026-09-02T18:21:43.203Z",
      "lifecycle": "EXECUTION_ENABLED",
      "planningRunRef": "run-da4b8e1e-89df-46fe-9555-e58067af1f27",
      "title": "Uai memory kernel from PRD"
    }
  ],
  "outcome": "COVERAGE",
  "sections": {
    "advisoryOnly": true,
    "entries": [
      {
        "cited": 0,
        "criteria": 0,
        "heading": "Uai — Personal AI Chief of Staff and Mentor",
        "number": null,
        "verified": 0
      },
      {
        "cited": 0,
        "criteria": 0,
        "heading": "Canonical Product Requirements Document and Memory Kernel Specification",
        "number": null,
        "verified": 0
      },
      {
        "cited": 0,
        "criteria": 0,
        "heading": "0. Instructions to the implementation agent",
        "number": "0",
        "verified": 0
      }
    ]
  },
  "totals": {
    "contracts": 1,
    "criteria": 10,
    "goals": 2,
    "planned": 0,
    "requirements": 7,
    "unattributable": 0,
    "verified": 10
  }
});

export const CATALOG_FRAME: unknown = Object.freeze({
  "goals": [
    {
      "binding": null,
      "brief": {
        "instructions": "Build the Uai memory kernel from prd.md, slice by slice. Each approved slice is delivered by an agent in D:/projexts/UnAI and verified with pnpm test.",
        "title": "Uai - Universal Memory System"
      },
      "goalId": "goal-live-1",
      "planningRunRef": "run-live-1",
      "truthClass": "DAEMON_VERIFIED"
    },
    {
      "binding": {
        "byteLength": 117563,
        "contentSha256": "e1033b0dbb2c5fb4d6b4fe7e7469001b36ae2f5643d8c062311d71e6c37fd93e",
        "sourceAggregateId": "document-source/81a65b18b962cd02705e981c62d80f6d193c56ee565e9d323d2eeb44652c6092",
        "sourceRef": "source:4a1aa4903df8f8e9ff2d3134b20ee91dc86753645f10f701def03136436717b4"
      },
      "brief": {
        "instructions": "Build the Uai memory kernel from PRD.md, slice by slice. Each approved slice is delivered by an agent in D:/projexts/UnAI and verified with pnpm test.\nPRD: PRD.md (117563 bytes) sha256 e1033b0dbb2c5fb4d6b4fe7e7469001b36ae2f5643d8c062311d71e6c37fd93e",
        "title": "Uai memory kernel from PRD"
      },
      "goalId": "goal-da4b8e1e-89df-46fe-9555-e58067af1f27",
      "planningRunRef": "run-da4b8e1e-89df-46fe-9555-e58067af1f27",
      "truthClass": "DAEMON_VERIFIED"
    },
    {
      "binding": {
        "byteLength": 117563,
        "contentSha256": "e1033b0dbb2c5fb4d6b4fe7e7469001b36ae2f5643d8c062311d71e6c37fd93e",
        "sourceAggregateId": "document-source/81a65b18b962cd02705e981c62d80f6d193c56ee565e9d323d2eeb44652c6092",
        "sourceRef": "source:4a1aa4903df8f8e9ff2d3134b20ee91dc86753645f10f701def03136436717b4"
      },
      "brief": {
        "instructions": "Build the Uai memory kernel from PRD.md, slice by slice. Each approved slice is delivered by an agent in D:/projexts/UnAI and verified with pnpm test.\nPRD: PRD.md (117563 bytes) sha256 e1033b0dbb2c5fb4d6b4fe7e7469001b36ae2f5643d8c062311d71e6c37fd93e",
        "title": "UnAI kernel from PRD (real seats)"
      },
      "goalId": "goal-c9d9850b-ccef-4c14-8893-a162e3aaf679",
      "planningRunRef": "run-c9d9850b-ccef-4c14-8893-a162e3aaf679",
      "truthClass": "DAEMON_VERIFIED"
    },
    {
      "binding": null,
      "brief": {
        "instructions": "Drill goal filed by the moe-next worker seat for task-5f5d873e (dead-seat reclaim live drive). Staff one planning seat so the wrapper can be killed mid-seat and the claim reclaimed on restart. No repository changes are expected from this goal.",
        "title": "Reclaim drill: prove a killed wrapper hands its claim back"
      },
      "goalId": "goal-173f92b1-6307-458b-a09d-64201880f2f0",
      "planningRunRef": "run-173f92b1-6307-458b-a09d-64201880f2f0",
      "truthClass": "DAEMON_VERIFIED"
    },
    {
      "binding": {
        "byteLength": 567,
        "contentSha256": "73b4d8960478b4c6aea238dd3bb2e33abba6d13ff0b6d703fbb6a59224e62608",
        "sourceAggregateId": "document-source/546fad21c55a00dbfd0050b7792a463710491f6cae9db0fe841cdeaa8431b6b6",
        "sourceRef": "source:d04634efc4a067a3581427201d6d3401b4ab4912f4ab2929f97ec8532dfa9175"
      },
      "brief": {
        "instructions": "Compile a product contract for the reclaim drill described in the bound source. Scope is deliberately tiny: this goal exists so the moe-next worker seat can staff one compiler seat, kill the wrapper mid-seat, and watch the boot reclaim hand the claim back.",
        "title": "Reclaim drill PRD: a killed wrapper hands its claim back"
      },
      "goalId": "goal-2c8c3615-2f9e-472a-b6bc-f94f513542e0",
      "planningRunRef": "run-2c8c3615-2f9e-472a-b6bc-f94f513542e0",
      "truthClass": "DAEMON_VERIFIED"
    }
  ],
  "nextCursor": null,
  "outcome": "GOALS"
});

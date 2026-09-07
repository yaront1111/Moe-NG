import { createHash } from "node:crypto";

import { ADMISSION_PURPOSES } from "@moe/scheduler";
import { describe, expect, it } from "vitest";

import {
  createDeliveryV2NodePlanningSourceRecord,
  decodeDeliveryV2NodePlanningSourceRecord,
  encodeDeliveryV2NodePlanningSourceRecord,
} from "../../delivery-v2/node-planning-source-record.js";
import { compilerNodePlanningAuthority } from "./compiler-scheduler-test-fixtures.js";
import { readNodePlanningDefinition } from "./scheduler-node-planning-authority.js";
import type { V2CompilerNodeAuthorityRequest } from "./authority-contracts.js";

/**
 * The FIRST test in the tree to drive `readNodePlanningDefinition`. Until this row
 * `git grep -ln readNodePlanningDefinition -- 'apps/**'` returned only the two
 * production modules, which is exactly why a source-owned member could be dropped
 * between the authored source and the authority draft without one arm noticing:
 * `compiler.test.ts` reaches this seam only through the whole compiler, where a
 * missing OPTIONAL member changes nothing it asserts.
 */
const digest = (label: string): string =>
  createHash("sha256").update(`node-planning-authority:${label}`).digest("hex");
const PRINCIPAL = "principal:planning-agent-a";

const request = (): V2CompilerNodeAuthorityRequest => ({
  admissionAmounts: [...ADMISSION_PURPOSES].sort().map((purpose, index) => ({
    meter: "attempt.count" as const, purpose, quantity: index + 1,
  })),
  admissionGatePolicy: "POLICY_ALLOWANCE",
  authorityKind: "BUILDER",
  budgetBindings: [],
  capability: "capability:migration-carrier",
  completionLinkage: null,
  constraints: [],
  contractBinding: {
    contractId: "contract:migration-carrier",
    revisionDigest: digest("contract-revision"),
    revisionId: "contract-revision:1",
  },
  contractRequirementIds: ["requirement-a"],
  criterionBindings: [{
    category: "FUNCTIONAL",
    criterionId: "criterion-a",
    ownerNodeId: "node-migration-carrier",
    requirementId: "requirement-a",
    statement: "The node carries the declaration its author stated.",
    verification: "AUTOMATED",
    verifierNodeId: "node-migration-carrier",
  }],
  directHardDependencies: [],
  graphId: "graph-migration-carrier",
  joinRole: "NONE",
  nodeKey: "node-migration-carrier",
  objective: "Carry a declared migration identifier into the compiled node.",
  policySliceHash: digest("policy-slice"),
  readScopes: ["packages/scheduler"],
  repositoryBaseTree: digest("repository-base-tree"),
  requiredImageDigests: [],
  requiredToolDigests: [],
  resources: [],
  roles: [],
  snapshotIdentity: digest("snapshot-identity"),
  verificationRecipeRevisions: ["recipe-a"],
  writeScopes: ["packages/scheduler"],
});

const definitionFor = (declaredMigrations?: readonly string[]) => {
  const built = request();
  return readNodePlanningDefinition((incoming) => {
    const authored = compilerNodePlanningAuthority(incoming);
    return declaredMigrations === undefined
      ? authored
      : { ...authored, declaredMigrations: [...declaredMigrations] };
  }, built);
};

describe("readNodePlanningDefinition carries an authored migration declaration", () => {
  it("forwards two identifiers by value, by count and in authored order", () => {
    // DoD 2, and the row's whole point: driven through the PRODUCTION reader with
    // a real authored source, asserted BY VALUE on the resulting NodeDefinition.
    // A hand-built draft here would prove the authority codec works and would prove
    // nothing about the carrier between the source and that codec.
    const definition = definitionFor(["migration-b", "migration-a"]);

    expect(definition).toBeDefined();
    expect(definition?.declaredMigrations).toEqual(["migration-b", "migration-a"]);
    expect(definition?.declaredMigrations?.length).toBe(2);
    // Order is content one layer down, so it must survive the forward unsorted: a
    // forward that normalized would restate what the author declared.
    expect(definition?.declaredMigrations?.[0]).toBe("migration-b");
  });

  it("still compiles a source that declares nothing, with the member absent", () => {
    // THE ROSTER ARM. `exact(value, keys)` is own-key COUNT equality plus
    // every-key-present, so a five-name SOURCE_KEYS roster would make the member
    // MANDATORY and refuse every authored source already in the store.
    const definition = definitionFor();

    expect(definition).toBeDefined();
    expect(definition === undefined || "declaredMigrations" in definition).toBe(false);
    expect(definition?.declaredMigrations).toBeUndefined();
  });

  it("mints a different schema version for a declaring source than for a silent one", () => {
    // THE DROP ARM. Without this, a forward that silently loses the member still
    // returns a valid definition and the by-value arm above is the only thing
    // standing between that and a green suite.
    const declaring = definitionFor(["migration-a"]);
    const silent = definitionFor();

    expect(declaring?.schemaVersion).toBe(3);
    expect(silent?.schemaVersion).toBe(2);
    expect(declaring?.schemaVersion).not.toBe(silent?.schemaVersion);
  });

  it("admits an explicit empty declaration as a stated fact, not as absence", () => {
    const empty = definitionFor([]);

    expect(empty).toBeDefined();
    expect(empty?.declaredMigrations).toEqual([]);
    expect(empty === undefined || "declaredMigrations" in empty).toBe(true);
    // Stated-none is a v3 body; only ABSENCE stays at the undeclared version.
    expect(empty?.schemaVersion).toBe(3);
  });

  it("refuses a source that names the member but states nothing", () => {
    // THE HAZARD, raised by adversarial review of this row's own diff: `exact` counts
    // the key whether it holds a value or `undefined`, so a five-key source carrying
    // an assigned `undefined` would pass the widened roster and then be dropped by
    // the conditional spread — returning a VALID definition with the member missing,
    // which is the silent drop this row exists to close, reintroduced by its own fix.
    //
    // THE REFUSER IS `snapshotCompilerInput`, NOT A GUARD IN THE SEAM. It visits every
    // own value and FAILS on `undefined` (snapshot.ts:21), so the source never reaches
    // the roster check. I wrote a local guard for this first; the mutation drill that
    // deleted it stayed GREEN, which proved it was dead code, and I removed it. This
    // arm therefore pins a real upstream property — a later relaxation of the snapshot
    // reds here — rather than a redundant check that made the arm look earned.
    const built = request();
    const silentlyDropped = readNodePlanningDefinition((incoming) => ({
      ...compilerNodePlanningAuthority(incoming), declaredMigrations: undefined,
    }), built);

    expect(silentlyDropped).toBeUndefined();
    // The control that makes the arm non-vacuous: the SAME five-key shape with a
    // stated declaration compiles, so the refusal is about the value, not the roster.
    expect(definitionFor(["migration-a"])?.declaredMigrations).toEqual(["migration-a"]);
  });

  it.each([
    ["a duplicated identifier", ["migration-a", "migration-a"]],
    ["a noncanonical identifier", [" migration-a "]],
  ])("refuses %s rather than repairing it", (_name, declared) => {
    // The compiler's contract on a refused source is `undefined`; the SPECIFIC code
    // and layer are asserted where they are minted, in the scheduler source-codec
    // arms. Asserting them again here would only re-test the layer below.
    expect(definitionFor(declared)).toBeUndefined();
  });

  it("forwards admitted planning-source bytes wholesale through the delivery record", () => {
    // DoD 5 as a COMMAND that survives the commit, not as a reading of the module.
    // `node-planning-source-record.ts` re-encodes `record.source` through the
    // Scheduler codec verbatim and enumerates nothing inside it, so the declaration
    // rides through only if that claim is true — which this arm measures rather
    // than asserts from a reading of :86-97 and :130-147.
    const authored = {
      ...compilerNodePlanningAuthority(request()),
      declaredMigrations: ["migration-b", "migration-a"],
    };
    const created = createDeliveryV2NodePlanningSourceRecord(PRINCIPAL, authored);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.record.source.declaredMigrations).toEqual(["migration-b", "migration-a"]);

    const encoded = encodeDeliveryV2NodePlanningSourceRecord(created.record);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeDeliveryV2NodePlanningSourceRecord(encoded.bytes, PRINCIPAL);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.record.source.declaredMigrations).toEqual(["migration-b", "migration-a"]);
    // The identity the store keys on must survive the round trip too, or a record
    // could carry the declaration while addressing a different revision.
    expect(decoded.record.revisionDigest).toBe(created.record.revisionDigest);
    // A record whose source declares NOTHING keeps a different identity, so the
    // forwarding above cannot be passing because both sides discard the member.
    const silent = createDeliveryV2NodePlanningSourceRecord(
      PRINCIPAL, compilerNodePlanningAuthority(request()),
    );
    expect(silent.ok).toBe(true);
    if (!silent.ok) return;
    expect("declaredMigrations" in silent.record.source).toBe(false);
    expect(silent.record.revisionDigest).not.toBe(created.record.revisionDigest);
  });
});

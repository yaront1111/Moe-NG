import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { DELIVERY_V2_MATERIAL_KINDS } from "./addresses.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const RUNTIME_EXPORTS = Object.freeze([
  "DELIVERY_V2_AUTHORITY_COMMAND_KINDS", "DELIVERY_V2_AUTHORITY_EVENT_TYPES",
  "DELIVERY_V2_AUTHORITY_EVIDENCE_VERSION", "DELIVERY_V2_AUTHORITY_KINDS",
  "DELIVERY_V2_AUTHORITY_LAYER", "DELIVERY_V2_CODES", "DELIVERY_V2_MATERIAL_COMMAND_KINDS",
  "DELIVERY_V2_MATERIAL_EVENT_TYPES", "DELIVERY_V2_MATERIAL_KINDS",
  "DELIVERY_V2_PERSISTENCE_LAYER", "DELIVERY_V2_QUALIFICATION_STATUS_VERSION",
  "DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_COMMAND_KIND",
  "DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_EVENT_TYPE",
  "DELIVERY_V2_READER_LAYER", "DELIVERY_V2_SOURCE_SNAPSHOT_COMMAND_KIND",
  "DELIVERY_V2_SOURCE_SNAPSHOT_EVENT_TYPE",
  "DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISH_COMMAND_ID_DOMAIN",
  "DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISH_CORRELATION_ID_DOMAIN",
  "DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER_CODES",
  "DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER_PRINCIPAL_DOMAIN",
  "DAEMON_DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER",
  "appendDeliveryV2PlannerAdmissionProfileRevision", "appendDeliveryV2SourceSnapshot",
  "createCapabilityCatalogRevisionIngress",
  "createDeliveryV2SourceSnapshotPublisher",
  "createDeliveryProfileQualificationIngress", "createDeliveryProfileRevisionIngress",
  "createExecutionIsolationProfileRevisionIngress",
  "createVerificationRecipeRevisionIngress", "createDeliveryProfileQualificationAuthority",
  "createDeliveryProfileBuilderIdentityIngress",
  "createDeliveryProfileOperatorApprovalIngress",
  "createDeliveryProfileProviderProfileIngress",
  "createDeliveryProfileQualificationStatusIngress",
  "createDeliveryProfileVerifierReceiptIngress",
  "deriveDeliveryV2AuthorityAggregateId", "deriveDeliveryV2MaterialAggregateId",
  "deriveDeliveryV2PlannerAdmissionProfileRevisionAggregateId",
  "deriveDeliveryV2SourceSnapshotPublishCommandId",
  "deriveDeliveryV2SourceSnapshotPublishCorrelationId",
  "deriveDeliveryV2SourceSnapshotPublisherPrincipalId",
  "deriveDeliveryV2SourceSnapshotAggregateId",
  "readCapabilityCatalogRevision",
  "readDeliveryProfileQualification", "readDeliveryProfileQualificationStatusFence",
  "readDeliveryProfileRevision",
  "readDeliveryV2ResolutionMaterials", "readExecutionIsolationProfileRevision",
  "readDeliveryV2PlannerAdmissionProfileRevision", "readDeliveryV2SourceSnapshot",
  "readVerificationRecipeRevision",
] as const);

it("keeps inert content-addressed records outside generic material topology", () => {
  expect(DELIVERY_V2_MATERIAL_KINDS as readonly string[]).not.toContain("SOURCE_SNAPSHOT");
  expect(DELIVERY_V2_MATERIAL_KINDS as readonly string[])
    .not.toContain("PLANNER_ADMISSION_PROFILE_REVISION");
});

it("has an exact bridge for every delivery-v2 runtime module", () => {
  const entries = readdirSync(ROOT);
  const modules = entries.filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"));
  const bridges = entries.filter((entry) => entry.endsWith(".js"));
  expect(modules.length).toBeGreaterThan(0);
  expect(bridges.sort()).toEqual(modules.map((entry) => entry.replace(/\.ts$/u, ".js")).sort());
  for (const module of modules) {
    expect(readFileSync(join(ROOT, module.replace(/\.ts$/u, ".js")), "utf8"))
      .toBe(`export * from "./${basename(module)}";\n`);
  }
});

it("loads the exact public delivery-v2 roster under plain Node", async () => {
  const source = [
    "const ns = await import('./src/delivery-v2/index.js');",
    "process.stdout.write(JSON.stringify(Object.keys(ns).sort()));",
  ].join("");
  const { stdout } = await execFileAsync(process.execPath, [
    "--experimental-strip-types", "--input-type=module", "-e", source,
  ], { cwd: join(ROOT, "../..") });
  expect(JSON.parse(stdout)).toEqual([...RUNTIME_EXPORTS].sort());
});

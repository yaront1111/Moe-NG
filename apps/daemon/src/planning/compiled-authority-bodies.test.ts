import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { encodeAcceptanceContract, encodePlanRevision } from "@moe/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  GOAL_ID, GRAPH_REVISION_REF, RUN_ID, closeStores, driveThrough, envelope,
  openStore, planningChain, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import * as compiledAuthorityNamespace from "./compiled-authority-bodies.js";
import { compiledPlanAuthority } from "./compiled-authority-bodies.js";
import { COMPILED_NODE_KEY_MAX_CHARS } from "./compiled-authority-contracts.js";
import type { CompiledPlanInput } from "./compiled-authority-contracts.js";

afterEach(closeStores);

const execFileAsync = promisify(execFile);
const PLANNING_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = resolve(PLANNING_DIRECTORY, "../..");
const CRITERIA = Object.freeze([
  { criterionId: "crit-api", statement: "The API answers a signed request with the record." },
  { criterionId: "crit-ui", statement: "The page renders the record the API answered." },
]);

const EXPECTED_GRAPH_BASE64 = "eyJzY2hlbWEiOiJNT0UtR1JBUEgtQ09OVEVOVC8zIiwiaGFzaCI6ImU5MDEyMzJjMGY1ZDVkYjVkYzNlNDRiNGUyNTViYjdmMzM3NGU0ZDg3ZDNhYzVlNWM4OGE4NGRkMzQ4N2VlNjUiLCJjb250ZW50Ijp7ImF1dGhvciI6ImNvbXBpbGVyLWFnZW50LTEiLCJjb21wbGV0aW9uTm9kZSI6Im5vZGUtdWkiLCJkZWNvbXBvc2l0aW9uQnVkZ2V0IjoyNCwibm9kZUF1dGhvcml0eSI6eyJhdXRob3JpdGllcyI6W3sibm9kZUF1dGhvcml0eUhhc2giOiIzZTdjZjg5ZjVlNzAxMDEwNmNlYWUwYjk0M2U0NmJkMzQxMmUxZGVhY2NlZDhlYTQyNjRiYzlmOGRkNjRkNDkzIiwibm9kZUtleSI6Im5vZGUtYXBpIn0seyJub2RlQXV0aG9yaXR5SGFzaCI6Ijg1NDAxM2UwNjA0ZDYwOGJiZDI5YmMzODg2NTlkYTU4NTJkZjYwMDU1MzgxNmU5Yjc1MDc3MWExM2VjOGI5ZDkiLCJub2RlS2V5Ijoibm9kZS11aSJ9XSwiZGVmaW5pdGlvbnMiOlt7ImFkbWlzc2lvbkFtb3VudHMiOlt7Im1ldGVyIjoicnVubmVyLmF1dGhvcml6ZWRfbXMiLCJwdXJwb3NlIjoiQ09OVElOR0VOQ1kiLCJxdWFudGl0eSI6MX0seyJtZXRlciI6InJ1bm5lci5hdXRob3JpemVkX21zIiwicHVycG9zZSI6IkVYRUNVVElPTiIsInF1YW50aXR5IjoyfSx7Im1ldGVyIjoicnVubmVyLmF1dGhvcml6ZWRfbXMiLCJwdXJwb3NlIjoiRklOQUxfQUNDRVBUQU5DRSIsInF1YW50aXR5IjozfSx7Im1ldGVyIjoicnVubmVyLmF1dGhvcml6ZWRfbXMiLCJwdXJwb3NlIjoiSU5ERVBFTkRFTlRfUkVWSUVXIiwicXVhbnRpdHkiOjR9LHsibWV0ZXIiOiJydW5uZXIuYXV0aG9yaXplZF9tcyIsInB1cnBvc2UiOiJWRVJJRklDQVRJT04iLCJxdWFudGl0eSI6NX1dLCJhZG1pc3Npb25HYXRlUG9saWN5IjoiSFVNQU5fQVBQUk9WQUwiLCJjYXBhYmlsaXR5IjoiY2FwYWJpbGl0eS1pbXBsZW1lbnQiLCJjb21wbGV0aW9uTGlua2FnZSI6bnVsbCwiY29uc3RyYWludHMiOltdLCJjcml0ZXJpb25CaW5kaW5ncyI6W3siY29udGVudERpZ2VzdCI6IjYxZGQxNzgyZDg2ZTYwY2M3MzlhYTE3OGI5ODkzNmM4NGFmYmZmMTg4OTIwYTg4N2ExMzExNGJlZjg1MjdjMjUiLCJjcml0ZXJpb25JZCI6ImNyaXQtYXBpIn1dLCJkaXJlY3RIYXJkRGVwZW5kZW5jaWVzIjpbXSwiam9pblJvbGUiOiJOT05FIiwibW9ub3RvbmljUHJlZGljYXRlUHJvb2ZzIjpbXSwibm9kZUtleSI6Im5vZGUtYXBpIiwib2JqZWN0aXZlIjoiTGFuZCB0aGUgQVBJIHJlYWQuIiwicGxhbkV4ZWN1dGlvbkNvbnRlbnREaWdlc3QiOiJlMGU3NmJmYWQ1MzY2YWFjMDVmNmY0NDllNGRjNWU3OGM5ZjExY2YxMjMzMzdlZjM4ZDVhMDljMzQzOTIyYWUzIiwicG9saWN5U2xpY2VIYXNoIjoiMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMyIsInJlYWRTY29wZXMiOlsic2VydmljZXMvYXBpL3NyYyJdLCJyZXBvc2l0b3J5QmFzZVRyZWUiOiI0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0IiwicmVzb3VyY2VzIjpbInJlc291cmNlLWEiXSwic2NoZW1hVmVyc2lvbiI6MiwidmVyaWZpY2F0aW9uUmVjaXBlUmV2aXNpb25zIjpbInJlY2lwZS1hIl0sIndyaXRlU2NvcGVzIjpbInNlcnZpY2VzL2FwaS9zcmMvcmVhZCJdfSx7ImFkbWlzc2lvbkFtb3VudHMiOlt7Im1ldGVyIjoicnVubmVyLmF1dGhvcml6ZWRfbXMiLCJwdXJwb3NlIjoiQ09OVElOR0VOQ1kiLCJxdWFudGl0eSI6MX0seyJtZXRlciI6InJ1bm5lci5hdXRob3JpemVkX21zIiwicHVycG9zZSI6IkVYRUNVVElPTiIsInF1YW50aXR5IjoyfSx7Im1ldGVyIjoicnVubmVyLmF1dGhvcml6ZWRfbXMiLCJwdXJwb3NlIjoiRklOQUxfQUNDRVBUQU5DRSIsInF1YW50aXR5IjozfSx7Im1ldGVyIjoicnVubmVyLmF1dGhvcml6ZWRfbXMiLCJwdXJwb3NlIjoiSU5ERVBFTkRFTlRfUkVWSUVXIiwicXVhbnRpdHkiOjR9LHsibWV0ZXIiOiJydW5uZXIuYXV0aG9yaXplZF9tcyIsInB1cnBvc2UiOiJWRVJJRklDQVRJT04iLCJxdWFudGl0eSI6NX1dLCJhZG1pc3Npb25HYXRlUG9saWN5IjoiSFVNQU5fQVBQUk9WQUwiLCJjYXBhYmlsaXR5IjoiY2FwYWJpbGl0eS1pbXBsZW1lbnQiLCJjb21wbGV0aW9uTGlua2FnZSI6Im5vZGUtdWkiLCJjb25zdHJhaW50cyI6W10sImNyaXRlcmlvbkJpbmRpbmdzIjpbeyJjb250ZW50RGlnZXN0IjoiMDgxN2Q2NDBiZTkxMzA2ODg1N2EzZjQ5YTQxOGJkMThlYjg1ZjVlZmJiYzYxMzZmYTAxYjRkYWJkYjU4N2Q4NyIsImNyaXRlcmlvbklkIjoiY3JpdC11aSJ9XSwiZGlyZWN0SGFyZERlcGVuZGVuY2llcyI6W3siY29udHJhY3QiOnsiYWx0ZXJuYXRlUHJvZHVjZXJzIjpbXSwiYWx0ZXJuYXRpdmVSdWxpbmciOnsia2luZCI6Ik5PVF9BUFBMSUNBQkxFIiwicmVhc29uIjoiTm8gYWx0ZXJuYXRlIHByb2R1Y2VyIGV4aXN0cy4ifSwiY29uc3VtZXIiOnsiY29udHJhY3RIYXNoIjoiY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjYyIsImNyaXRlcmlvblJlZiI6ImNyaXQtdWkiLCJraW5kIjoiUFJFQ09ORElUSU9OIn0sImNvbnN1bWVyTm9kZUtleSI6Im5vZGUtdWkiLCJjb25zdW1wdGlvbkhvcml6b24iOiJSRVNVTFRfU0VBTCIsImVkZ2VLaW5kIjoiQVJUSUZBQ1RfQ09OU1VNUFRJT04iLCJncmFwaEJpbmRpbmdEaWdlc3QiOiJiY2FiOWY3MzhmMDE4Zjg3YjQ0ZmI3Yjk4N2NmMDk1ZTRiYTdiOThiY2NkNDM0YzY3YzE5ZGFmZDFkNTQ0NzkyIiwiaW52YWxpZGF0aW9uRmFjdHMiOlt7InNvdXJjZUZhY3REaWdlc3QiOiJlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlIiwic291cmNlRmFjdFJlZiI6ImZhY3QtZGVwLW5vZGUtYXBpLS1ub2RlLXVpIiwic291cmNlRmFjdFZlcnNpb24iOjF9XSwibWluaW11bVF1YWxpZnlpbmdNaWxlc3RvbmUiOiJSRVNVTFRfU0VBTEVEIiwibmVjZXNzaXR5Ijp7ImZhaWxlZENvbnN1bWVyQ3JpdGVyaW9uUmVmIjoiY3JpdC11aSIsImZhaWx1cmVLaW5kIjoiTUlTU0lOR19BUlRJRkFDVCIsInRydXRoQ2xhc3MiOiJPQlNFUlZFRCJ9LCJwcm9kdWNlciI6eyJhcnRpZmFjdE9ySW50ZXJmYWNlUmVmIjoiYXJ0aWZhY3Qtbm9kZS1hcGkiLCJkaWdlc3QiOiJmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmIiwia2luZCI6IkFSVElGQUNUX0NPTlNVTVBUSU9OIn0sInByb2R1Y2VyTm9kZUtleSI6Im5vZGUtYXBpIiwicmVjaGVja1ByZWRpY2F0ZVJlZiI6InByZWRpY2F0ZS1hIiwic2F0aXNmYWN0aW9uUHJlZGljYXRlIjp7InBhcmFtZXRlcnNEaWdlc3QiOiIxMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExIiwicHJlZGljYXRlUmVmIjoicHJlZGljYXRlLWEiLCJzY2hlbWFJZCI6InNjaGVtYS1hIiwic2NoZW1hVmVyc2lvbiI6MX0sInNhdGlzZmFjdGlvbldpdG5lc3NlcyI6W3sic291cmNlT3BlcmF0aW9uQ2xhc3MiOiJBUlRJRkFDVF9TRUFMIiwid2l0bmVzc0RpZ2VzdCI6IjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIiLCJ3aXRuZXNzUmVmIjoid2l0bmVzcy1kZXAtbm9kZS1hcGktLW5vZGUtdWkiLCJ3aXRuZXNzVmVyc2lvbiI6MX1dLCJzdGFiaWxpdHkiOiJNT05PVE9OSUMiLCJ0cnV0aENsYXNzIjoiT0JTRVJWRUQifSwiZWRnZUtleSI6ImRlcC1ub2RlLWFwaS0tbm9kZS11aSJ9XSwiam9pblJvbGUiOiJDT01QTEVUSU9OIiwibW9ub3RvbmljUHJlZGljYXRlUHJvb2ZzIjpbeyJwYXJhbWV0ZXJTY2hlbWEiOnsiZGlnZXN0IjoiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYiIsImtpbmQiOiJKU09OX1NDSEVNQSJ9LCJwcmVkaWNhdGVSZWYiOiJwcmVkaWNhdGUtYSIsInByb29mUmF0aW9uYWxlIjoiQW4gYXJ0aWZhY3Qgc2VhbCBjYW5ub3QgYmVjb21lIHVuc2VhbGVkLiIsInNjaGVtYUlkIjoic2NoZW1hLWEiLCJzY2hlbWFWZXJzaW9uIjoxLCJzb3VyY2VPcGVyYXRpb25DbGFzcyI6IkFSVElGQUNUX1NFQUwifV0sIm5vZGVLZXkiOiJub2RlLXVpIiwib2JqZWN0aXZlIjoiUmVuZGVyIHRoZSByZWNvcmQuIiwicGxhbkV4ZWN1dGlvbkNvbnRlbnREaWdlc3QiOiJlMGRlMTM3NGEzYjQ1MDJiOWUwYmZkYjAwZDAyZWM4NWM2MjUzYjkyOTliOWU5ODEzZGJhMTMwM2UzYTY0NDExIiwicG9saWN5U2xpY2VIYXNoIjoiMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMyIsInJlYWRTY29wZXMiOlsiYXBwcy93ZWIvc3JjIl0sInJlcG9zaXRvcnlCYXNlVHJlZSI6IjQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQiLCJyZXNvdXJjZXMiOlsicmVzb3VyY2UtYSJdLCJzY2hlbWFWZXJzaW9uIjoyLCJ2ZXJpZmljYXRpb25SZWNpcGVSZXZpc2lvbnMiOlsicmVjaXBlLWEiXSwid3JpdGVTY29wZXMiOlsiYXBwcy93ZWIvc3JjL3JlY29yZCJdfV19LCJwYXJlbnRSZXZpc2lvbiI6bnVsbCwicG9saWN5UmV2aXNpb24iOiJwb2wtMDAwMDAwMDAwMDAxIiwicmVwb3NpdG9yeUJhc2VUcmVlIjoiNDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NCIsInNuYXBzaG90Ijp7Im5vZGVzIjpbeyJub2RlS2V5Ijoibm9kZS1hcGkiLCJleGVjdXRpb25CZWFyaW5nIjp0cnVlfSx7Im5vZGVLZXkiOiJub2RlLXVpIiwiZXhlY3V0aW9uQmVhcmluZyI6dHJ1ZX1dLCJlZGdlcyI6W3siZWRnZUtleSI6ImRlcC1ub2RlLWFwaS0tbm9kZS11aSIsInByb2R1Y2VyTm9kZUtleSI6Im5vZGUtYXBpIiwiY29uc3VtZXJOb2RlS2V5Ijoibm9kZS11aSIsImtpbmQiOiJIQVJEIn1dLCJjb21wbGV0aW9uTm9kZUtleSI6Im5vZGUtdWkifX19";
const EXPECTED_PLAN_BYTES = "{\"affectedCriterionIds\":[\"crit-api\",\"crit-ui\"],\"affectedNodeIds\":[\"node-api\",\"node-ui\"],\"approvalState\":\"PENDING_APPROVAL\",\"authorRef\":\"compiler-agent-1\",\"graphBinding\":{\"graphContentHash\":\"e901232c0f5d5db5dc3e44b4e255bb7f3374e4d87d3ac5e5c88a84dd3487ee65\",\"graphRevisionRef\":\"graph-revision-1\"},\"parentRevisionId\":null,\"planHash\":\"9cef1bde84d01f4483aac42d125a6315dabd5a151d7d9fcf9ff046541e5e07de\",\"rejectionRef\":null,\"revisionId\":\"run-1-revision\",\"steps\":[{\"description\":\"Land the API read.\",\"kind\":\"IMPLEMENTATION\",\"stepId\":\"step-00001\"},{\"description\":\"Render the record.\",\"kind\":\"IMPLEMENTATION\",\"stepId\":\"step-00002\"}],\"verificationRecipeRefs\":[\"run-1-recipe\"],\"version\":\"moe-plan-revision/1\"}";
const EXPECTED_ACCEPTANCE_BYTES = "{\"applicability\":{\"graphContentHash\":\"e901232c0f5d5db5dc3e44b4e255bb7f3374e4d87d3ac5e5c88a84dd3487ee65\",\"graphRevisionRef\":\"graph-revision-1\",\"nodeIds\":[\"node-api\",\"node-ui\"],\"nodeKind\":\"LEAF\"},\"authorRef\":\"compiler-agent-1\",\"contractId\":\"run-1-contract\",\"criteriaDigest\":\"307063f7745774952f86ba929e5960d5e6bd02f7312835131c434353da25a98f\",\"obligations\":[{\"criterionId\":\"crit-api\",\"evidenceRequirements\":[{\"evidenceRef\":\"crit-api-evidence\",\"kind\":\"VERIFICATION_RECEIPT\",\"requirementId\":\"crit-api-requirement\"}],\"statement\":\"The API answers a signed request with the record.\",\"verificationRecipeRefs\":[\"run-1-recipe\"]},{\"criterionId\":\"crit-ui\",\"evidenceRequirements\":[{\"evidenceRef\":\"crit-ui-evidence\",\"kind\":\"VERIFICATION_RECEIPT\",\"requirementId\":\"crit-ui-requirement\"}],\"statement\":\"The page renders the record the API answered.\",\"verificationRecipeRefs\":[\"run-1-recipe\"]}],\"version\":\"moe-acceptance-contract/1\"}";
const EXPECTED = Object.freeze({
  acceptanceBytes: 912,
  acceptanceSha256: "74b89a2b88ee09f736336f117b1f0ef6765308d625cd71e3995983ee1da5d061",
  criterionDigest: "307063f7745774952f86ba929e5960d5e6bd02f7312835131c434353da25a98f",
  graphBytes: 5019,
  graphHash: "e901232c0f5d5db5dc3e44b4e255bb7f3374e4d87d3ac5e5c88a84dd3487ee65",
  graphSha256: "044ffdb999635d283bfd637f9734ca6a3d1d8a57c5cbf8f29e910c5d6734f44b",
  planBytes: 697,
  planSha256: "4fd94baffa52c5c410c773c6c61701e0fd41ae99308aca79cf93f31a5a1075ce",
  resultBytes: 8563,
  resultSha256: "d86a47c1fa505e670bbb21c02a6dc19583803b347c8a102794ac4b88a9c5a9f5",
  submissionHash: "9cef1bde84d01f4483aac42d125a6315dabd5a151d7d9fcf9ff046541e5e07de",
});

interface AuthorityView {
  readonly acceptanceContract: Readonly<{
    criteriaDigest: string;
    obligations: readonly Readonly<{ criterionId: string; statement: string }>[];
  }>;
  readonly planRevision: Readonly<{ steps: readonly unknown[] }>;
}

function inputOf(overrides: Partial<CompiledPlanInput> = {}): CompiledPlanInput {
  return {
    authorRef: "compiler-agent-1",
    completionNodeKey: "node-ui",
    criteria: CRITERIA,
    graphRevisionRef: GRAPH_REVISION_REF,
    idPrefix: RUN_ID,
    knownCapabilities: ["capability-implement"],
    nodes: [
      {
        capability: "capability-implement", criterionIds: ["crit-api"], dependsOn: [],
        nodeKey: "node-api", objective: "Land the API read.", readScopes: ["services/api/src"],
        resources: ["resource-a"], verificationRecipeRefs: ["recipe-a"],
        writeScopes: ["services/api/src/read"],
      },
      {
        capability: "capability-implement", criterionIds: ["crit-ui"],
        dependsOn: ["node-api"], nodeKey: "node-ui", objective: "Render the record.",
        readScopes: ["apps/web/src"], resources: ["resource-a"],
        verificationRecipeRefs: ["recipe-a"], writeScopes: ["apps/web/src/record"],
      },
    ],
    ...overrides,
  };
}

function compiledOrThrow(input: CompiledPlanInput) {
  const compiled = compiledPlanAuthority(input);
  if (!compiled.ok) throw new Error(`compile refused: ${compiled.code} ${compiled.detail}`);
  return compiled as typeof compiled & Readonly<{ authority: AuthorityView }>;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("compiledPlanAuthority", () => {
  it("pins canonical bytes, digests, ordering, freezing, and its exact public surface", () => {
    const compiled = compiledOrThrow(inputOf());
    const graphBytes = Buffer.from(compiled.graphContentBytesBase64, "base64");
    const plan = encodePlanRevision(compiled.authority.planRevision);
    const acceptance = encodeAcceptanceContract(compiled.authority.acceptanceContract);
    if (!plan.ok || !acceptance.ok) throw new Error("compiled authority failed canonical encoding");

    expect(Object.keys(compiledAuthorityNamespace)).toEqual(["compiledPlanAuthority"]);
    expect(Object.keys(compiled)).toEqual([
      "authority", "graphContentBytesBase64", "graphContentHash", "ok", "submissionHash",
    ]);
    expect(Object.keys(compiled.authority)).toEqual(["acceptanceContract", "planRevision"]);
    expect(compiled.graphContentBytesBase64).toBe(EXPECTED_GRAPH_BASE64);
    expect([graphBytes.byteLength, sha256(graphBytes)]).toEqual([
      EXPECTED.graphBytes, EXPECTED.graphSha256,
    ]);
    expect(new TextDecoder().decode(plan.bytes)).toBe(EXPECTED_PLAN_BYTES);
    expect([plan.bytes.byteLength, sha256(plan.bytes)]).toEqual([
      EXPECTED.planBytes, EXPECTED.planSha256,
    ]);
    expect(new TextDecoder().decode(acceptance.bytes)).toBe(EXPECTED_ACCEPTANCE_BYTES);
    expect([acceptance.bytes.byteLength, sha256(acceptance.bytes)]).toEqual([
      EXPECTED.acceptanceBytes, EXPECTED.acceptanceSha256,
    ]);
    expect([
      compiled.graphContentHash, compiled.submissionHash,
      compiled.authority.acceptanceContract.criteriaDigest,
    ]).toEqual([EXPECTED.graphHash, EXPECTED.submissionHash, EXPECTED.criterionDigest]);
    expect([Buffer.byteLength(JSON.stringify(compiled)), sha256(JSON.stringify(compiled))]).toEqual([
      EXPECTED.resultBytes, EXPECTED.resultSha256,
    ]);
    expect([
      Object.isFrozen(compiled), Object.isFrozen(compiled.authority),
      Object.isFrozen(compiled.authority.acceptanceContract),
      Object.isFrozen(compiled.authority.acceptanceContract.obligations),
      Object.isFrozen(compiled.authority.planRevision),
      Object.isFrozen(compiled.authority.planRevision.steps),
    ]).toEqual([true, false, true, true, true, true]);
  });

  it("carries criterion statements byte-equal into the acceptance contract", () => {
    const compiled = compiledOrThrow(inputOf());
    for (const criterion of CRITERIA) {
      const obligation = compiled.authority.acceptanceContract.obligations.find(
        (entry) => entry.criterionId === criterion.criterionId,
      );
      expect(obligation?.statement).toBe(criterion.statement);
    }
    const prettified = compiledOrThrow(inputOf({ criteria: [
      { ...CRITERIA[0]!, statement: `${CRITERIA[0]!.statement} ` }, CRITERIA[1]!,
    ] }));
    expect(prettified.authority.acceptanceContract.obligations[0]?.statement)
      .not.toBe(CRITERIA[0]!.statement);
  });

  it("pins every local refusal fence with a nonzero nine-row denominator", () => {
    const nodes = inputOf().nodes;
    // One character past the bound: `dep-<key>--<key>` no longer fits the graph codec's key.
    const longKey = `node-${"x".repeat(COMPILED_NODE_KEY_MAX_CHARS - 4)}`;
    expect(longKey).toHaveLength(COMPILED_NODE_KEY_MAX_CHARS + 1);
    const many = Array.from({ length: 25 }, (_, index) => ({
      ...nodes[0]!, criterionIds: ["crit-api"], dependsOn: [], nodeKey: `node-${index}`,
    }));
    const cases = [
      [inputOf({ nodes: [] }), "COMPILED_PLAN_MALFORMED", "no nodes"],
      [inputOf({ completionNodeKey: "node-ghost" }), "COMPILED_PLAN_MALFORMED",
        "completion node is not a listed node"],
      [inputOf({ nodes: [nodes[0]!, { ...nodes[1]!, criterionIds: ["crit-ghost"] }] }),
        "COMPILED_PLAN_CRITERION_UNBOUND", "node node-ui cites unknown criterion crit-ghost"],
      [inputOf({ nodes: [nodes[0]!, { ...nodes[1]!, criterionIds: ["crit-api"] }] }),
        "COMPILED_PLAN_CRITERION_UNBOUND", "criterion crit-ui is satisfied by no node"],
      [inputOf({ knownCapabilities: ["capability-other"] }),
        "COMPILED_PLAN_CAPABILITY_UNCATALOGED",
        "no verification command for capability capability-implement (node node-api)"],
      [inputOf({ nodes: [nodes[0]!, { ...nodes[1]!, dependsOn: ["node-ghost"] }] }),
        "COMPILED_PLAN_MALFORMED", "dependsOn node-ghost of node-ui"],
      [inputOf({ completionNodeKey: "node-0", nodes: many }),
        "COMPILED_PLAN_BUDGET_EXCEEDED", "25 nodes exceed the compile budget of 24"],
      // Coverage holds (node-api binds both), so the join node's emptiness is the refusal —
      // the shape the approval codec used to reject as a producer THROW.
      [inputOf({ nodes: [
        { ...nodes[0]!, criterionIds: ["crit-api", "crit-ui"] }, { ...nodes[1]!, criterionIds: [] },
      ] }), "COMPILED_PLAN_MALFORMED", "node node-ui binds no criterion"],
      [inputOf({ nodes: [nodes[0]!, { ...nodes[1]!, nodeKey: longKey }] }),
        "COMPILED_PLAN_MALFORMED", `node key ${longKey}`],
    ] as const;
    expect(cases).toHaveLength(9);
    for (const [input, code, detail] of cases) {
      const refusal = compiledPlanAuthority(input);
      expect(refusal).toEqual({ code, detail, layer: "COMPILED_PLAN_PRODUCER", ok: false });
      expect(Object.isFrozen(refusal)).toBe(true);
    }
  });

  it("admits a node key AT the bound: the fence is the codec's, one character wide", () => {
    const nodes = inputOf().nodes;
    const key = `node-${"y".repeat(COMPILED_NODE_KEY_MAX_CHARS - 5)}`;
    expect(key).toHaveLength(COMPILED_NODE_KEY_MAX_CHARS);
    const compiled = compiledPlanAuthority(inputOf({
      completionNodeKey: key, nodes: [nodes[0]!, { ...nodes[1]!, nodeKey: key }],
    }));
    expect(compiled.ok, compiled.ok ? "" : `${compiled.code} ${compiled.detail}`).toBe(true);
  });

  it("keeps top approval, scheduler-limit, and plain node-plan failures distinct", () => {
    expect(compiledPlanAuthority(inputOf({ graphRevisionRef: "" }))).toEqual({
      code: "COMPILED_PLAN_ADMISSION_REFUSED",
      detail: "PLAN_REVISION_MALFORMED@PLAN_REVISION_ADMISSION",
      layer: "COMPILED_PLAN_PRODUCER", ok: false,
    });
    const nodes = inputOf().nodes;
    expect(compiledPlanAuthority(inputOf({
      nodes: [{ ...nodes[0]!, objective: "x".repeat(10_000) }, nodes[1]!],
    }))).toEqual({
      code: "COMPILED_PLAN_ADMISSION_REFUSED",
      detail: "node node-api: NODE_AUTHORITY_LIMIT_EXCEEDED@NODE_AUTHORITY_LIMITS",
      layer: "COMPILED_PLAN_PRODUCER", ok: false,
    });
    expect(() => compiledPlanAuthority(inputOf({ authorRef: "" })))
      .toThrowError("compiled node plan refused: PLAN_REVISION_MALFORMED@PLAN_REVISION_ADMISSION");
  });

  it("loads the unchanged public bridge in plain Node and reproduces the canonical digests", async () => {
    const childSource = [
      'import { createHash } from "node:crypto";',
      'import * as api from "./src/planning/compiled-authority-bodies.js";',
      `const input=${JSON.stringify(inputOf())};`,
      "const value=api.compiledPlanAuthority(input);",
      'if (!value.ok) throw new Error(`${value.code}:${value.detail}`);',
      'const bytes=Buffer.from(value.graphContentBytesBase64,"base64");',
      'const sha=(v)=>createHash("sha256").update(v).digest("hex");',
      "console.log(JSON.stringify({exports:Object.keys(api),graph:value.graphContentHash,",
      "submission:value.submissionHash,criterion:value.authority.acceptanceContract.criteriaDigest,",
      "graphBytes:bytes.length,graphSha:sha(bytes),resultBytes:Buffer.byteLength(JSON.stringify(value)),",
      "resultSha:sha(JSON.stringify(value))}));",
    ].join("");
    const { stdout } = await execFileAsync(process.execPath, [
      "--input-type=module", "--eval", childSource,
    ], { cwd: DAEMON_ROOT, shell: false, windowsHide: true });
    expect(JSON.parse(stdout) as unknown).toEqual({
      exports: ["compiledPlanAuthority"], graph: EXPECTED.graphHash,
      submission: EXPECTED.submissionHash, criterion: EXPECTED.criterionDigest,
      graphBytes: EXPECTED.graphBytes, graphSha: EXPECTED.graphSha256,
      resultBytes: EXPECTED.resultBytes, resultSha: EXPECTED.resultSha256,
    });
  });

  it("keeps every split production source below 250 physical lines", () => {
    const sources = [
      "compiled-authority-bodies.ts",
      "compiled-approval-authority-body.ts",
      "compiled-policy-authority-body.ts",
    ];
    for (const source of sources) {
      const text = readFileSync(resolve(PLANNING_DIRECTORY, source), "utf8");
      const physicalLines = text.split("\n").length - Number(text.endsWith("\n"));
      expect(physicalLines, source).toBeLessThan(250);
    }
  });

  it("pins both private bridges to exact LF bytes and imports them", async () => {
    const bridges = [
      ["compiled-approval-authority-body.js", "compiled-approval-authority-body.ts"],
      ["compiled-policy-authority-body.js", "compiled-policy-authority-body.ts"],
    ] as const;
    for (const [bridge, target] of bridges) {
      expect(readFileSync(resolve(PLANNING_DIRECTORY, bridge))).toEqual(
        Buffer.from(`export * from "./${target}";\n`),
      );
      const modulePath = `./${bridge}`;
      expect(Object.keys(await import(modulePath)).length).toBeGreaterThan(0);
    }
  });

  it("PARITY LANE: the real plan.propose seam admits the compiled two-node chain", () => {
    const store = openStore();
    driveThrough(store, "plan.propose");
    const compiled = compiledOrThrow(inputOf());
    const chain = [...planningChain()];
    chain[chain.length - 1] = {
      ...chain[chain.length - 1]!, authority: compiled.authority,
      graphContentBytesBase64: compiled.graphContentBytesBase64,
      submissionHash: compiled.submissionHash,
    };
    const outcome = send(store, envelope("plan.propose", 0, { commands: chain, runId: RUN_ID }));
    if (!outcome.ok) throw new Error(`propose refused: ${outcome.code}`);
    expect(outcome.ok).toBe(true);
    expect(GOAL_ID.length).toBeGreaterThan(0);
  });
});

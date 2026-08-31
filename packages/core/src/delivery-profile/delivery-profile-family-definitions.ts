import { createHash } from "node:crypto";

import { deepFreeze } from "../planning/planning-snapshot.js";
import type {
  DeliveryProfileFamilyDefinition,
} from "./delivery-profile-contract.js";

export const DELIVERY_PROFILE_FAMILY_DEFINITION_DIGEST_DOMAIN =
  "moe-delivery-profile-family-definition-digest/1" as const;

type DefinitionBody = Omit<DeliveryProfileFamilyDefinition, "definitionDigest">;
const encoder = new TextEncoder();

function canonicalText(value: unknown): string {
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalText(record[key])}`,
    ).join(",")}}`;
  }
  throw new TypeError("family definition canonicalization received non-definition data");
}

function define(body: DefinitionBody): DeliveryProfileFamilyDefinition {
  const definitionDigest = createHash("sha256")
    .update(DELIVERY_PROFILE_FAMILY_DEFINITION_DIGEST_DOMAIN, "utf8")
    .update(Uint8Array.of(0))
    .update(encoder.encode(canonicalText(body)))
    .digest("hex");
  return deepFreeze({ ...body, definitionDigest });
}

export const DELIVERY_PROFILE_FAMILY_DEFINITIONS = Object.freeze([
  define({
    components: [
      { componentId: "node-runtime", role: "RUNTIME", technology: "Node.js" },
      { componentId: "typescript-language", role: "LANGUAGE", technology: "TypeScript" },
      { componentId: "web-framework", role: "FRONTEND", technology: "Next.js" },
    ],
    dependencyEdges: [
      { consumerComponentId: "typescript-language", providerComponentId: "node-runtime" },
      { consumerComponentId: "web-framework", providerComponentId: "typescript-language" },
    ],
    imageRefRoster: ["image-web"],
    policyRefRoster: ["policy-budget", "policy-operations", "policy-resource", "policy-security"],
    profileFamilyId: "Next.js/TypeScript",
    services: [{ dependsOnServiceIds: [], imageRef: "image-web", serviceId: "web" }],
    templateRefRoster: ["template-next-typescript"],
    toolRefRoster: ["tool-docker", "tool-http-probe", "tool-node", "tool-pnpm"],
  }),
  define({
    components: [
      { componentId: "api-framework", role: "BACKEND", technology: "FastAPI" },
      { componentId: "node-runtime", role: "RUNTIME", technology: "Node.js" },
      { componentId: "python-runtime", role: "RUNTIME", technology: "Python" },
      { componentId: "react-framework", role: "FRONTEND", technology: "React" },
      { componentId: "typescript-language", role: "LANGUAGE", technology: "TypeScript" },
    ],
    dependencyEdges: [
      { consumerComponentId: "api-framework", providerComponentId: "python-runtime" },
      { consumerComponentId: "react-framework", providerComponentId: "typescript-language" },
      { consumerComponentId: "typescript-language", providerComponentId: "node-runtime" },
    ],
    imageRefRoster: ["image-api", "image-web"],
    policyRefRoster: ["policy-budget", "policy-operations", "policy-resource", "policy-security"],
    profileFamilyId: "React/FastAPI",
    services: [
      { dependsOnServiceIds: [], imageRef: "image-api", serviceId: "api" },
      { dependsOnServiceIds: ["api"], imageRef: "image-web", serviceId: "web" },
    ],
    templateRefRoster: ["template-react-fastapi"],
    toolRefRoster: [
      "tool-docker", "tool-http-probe", "tool-node", "tool-pnpm", "tool-python", "tool-uv",
    ],
  }),
  define({
    components: [
      { componentId: "go-runtime", role: "RUNTIME", technology: "Go" },
      { componentId: "htmx-framework", role: "FRONTEND", technology: "HTMX" },
    ],
    dependencyEdges: [
      { consumerComponentId: "htmx-framework", providerComponentId: "go-runtime" },
    ],
    imageRefRoster: ["image-web"],
    policyRefRoster: ["policy-budget", "policy-operations", "policy-resource", "policy-security"],
    profileFamilyId: "Go/HTMX",
    services: [{ dependsOnServiceIds: [], imageRef: "image-web", serviceId: "web" }],
    templateRefRoster: ["template-go-htmx"],
    toolRefRoster: ["tool-docker", "tool-go", "tool-http-probe"],
  }),
  define({
    components: [
      { componentId: "axum-framework", role: "BACKEND", technology: "Axum" },
      { componentId: "rust-runtime", role: "RUNTIME", technology: "Rust" },
    ],
    dependencyEdges: [
      { consumerComponentId: "axum-framework", providerComponentId: "rust-runtime" },
    ],
    imageRefRoster: ["image-web"],
    policyRefRoster: ["policy-budget", "policy-operations", "policy-resource", "policy-security"],
    profileFamilyId: "Rust/Axum",
    services: [{ dependsOnServiceIds: [], imageRef: "image-web", serviceId: "web" }],
    templateRefRoster: ["template-rust-axum"],
    toolRefRoster: ["tool-cargo", "tool-docker", "tool-http-probe"],
  }),
  define({
    components: [
      { componentId: "aspnet-framework", role: "BACKEND", technology: "ASP.NET Core" },
      { componentId: "blazor-framework", role: "FRONTEND", technology: "Blazor" },
      { componentId: "dotnet-runtime", role: "RUNTIME", technology: ".NET" },
    ],
    dependencyEdges: [
      { consumerComponentId: "aspnet-framework", providerComponentId: "dotnet-runtime" },
      { consumerComponentId: "blazor-framework", providerComponentId: "aspnet-framework" },
    ],
    imageRefRoster: ["image-web"],
    policyRefRoster: ["policy-budget", "policy-operations", "policy-resource", "policy-security"],
    profileFamilyId: "ASP.NET Core/Blazor",
    services: [{ dependsOnServiceIds: [], imageRef: "image-web", serviceId: "web" }],
    templateRefRoster: ["template-aspnet-blazor"],
    toolRefRoster: ["tool-docker", "tool-dotnet", "tool-http-probe"],
  }),
]);

export function deliveryProfileFamilyDefinition(
  familyId: string,
): DeliveryProfileFamilyDefinition | undefined {
  return DELIVERY_PROFILE_FAMILY_DEFINITIONS.find(
    (definition) => definition.profileFamilyId === familyId,
  );
}

export const DELIVERY_PROFILE_RESOURCE_CLASSES = Object.freeze([
  "BROWSER", "BUILD_CPU", "CONTAINER", "DATABASE", "PERSISTENT_STORAGE",
] as const);

export const DELIVERY_PROFILE_MODEL_PROVIDER_CAPABILITIES = Object.freeze([
  "CODE_GENERATION", "STRUCTURED_OUTPUT", "TOOL_CALLING", "VISION",
] as const);

export const DELIVERY_PROFILE_POLICY_KINDS = Object.freeze([
  "BUDGET", "OPERATIONS", "RESOURCE", "SECURITY",
] as const);

export type DeliveryProfileResourceClass =
  (typeof DELIVERY_PROFILE_RESOURCE_CLASSES)[number];
export type DeliveryProfileModelProviderCapability =
  (typeof DELIVERY_PROFILE_MODEL_PROVIDER_CAPABILITIES)[number];
export type DeliveryProfilePolicyKind = (typeof DELIVERY_PROFILE_POLICY_KINDS)[number];

export interface DeliveryProfileSupportedHostFacts {
  readonly architecture: "x86_64" | "arm64";
  readonly browserEngine: "Chromium" | "Firefox" | "WebKit";
  readonly composeImplementation: "Docker Compose" | "Podman Compose";
  readonly containerEngine: "Docker" | "Podman";
  readonly operatingSystem: "Linux" | "Windows" | "macOS";
}

export interface DeliveryProfileSupportedBackendFacts {
  readonly databaseEngine: "PostgreSQL";
  readonly healthProtocol: "HTTP";
  readonly migrationMode: "TRANSACTIONAL";
  readonly stateModel: "PERSISTENT";
}

export interface DeliveryProfileTypedPolicyRef<K extends DeliveryProfilePolicyKind> {
  readonly artifactDigest: string;
  readonly artifactRef: string;
  readonly policyKind: K;
}

export interface DeliveryProfilePolicyRefs {
  readonly budget: DeliveryProfileTypedPolicyRef<"BUDGET">;
  readonly operations: DeliveryProfileTypedPolicyRef<"OPERATIONS">;
  readonly resource: DeliveryProfileTypedPolicyRef<"RESOURCE">;
  readonly security: DeliveryProfileTypedPolicyRef<"SECURITY">;
}

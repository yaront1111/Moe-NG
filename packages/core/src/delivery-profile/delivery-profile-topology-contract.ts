import type {
  DeliveryProfileFamilyId, DeliveryProfileStackRole,
} from "./delivery-profile-contract.js";

export interface DeliveryProfileImmutableArtifactRef {
  readonly artifactDigest: string;
  readonly artifactRef: string;
}

export interface DeliveryProfileImmutableImageRef {
  readonly imageDigest: string;
  readonly imageRef: string;
}

export interface DeliveryProfileStackComponent {
  readonly artifactDigest: string;
  readonly componentId: string;
  readonly role: DeliveryProfileStackRole;
  readonly technology: string;
  readonly version: string;
}

export interface DeliveryProfileStackEdge {
  readonly consumerComponentId: string;
  readonly providerComponentId: string;
}

export interface DeliveryProfileStackGrammar {
  readonly components: readonly DeliveryProfileStackComponent[];
  readonly dependencyEdges: readonly DeliveryProfileStackEdge[];
}

export interface DeliveryProfileFamilyComponentDefinition {
  readonly componentId: string;
  readonly role: DeliveryProfileStackRole;
  readonly technology: string;
}

export interface DeliveryProfileFamilyServiceDefinition {
  readonly dependsOnServiceIds: readonly string[];
  readonly imageRef: string;
  readonly serviceId: string;
}

/** Closed source-controlled grammar. Revision-specific versions and bytes are bound separately. */
export interface DeliveryProfileFamilyDefinition {
  readonly components: readonly DeliveryProfileFamilyComponentDefinition[];
  readonly definitionDigest: string;
  readonly dependencyEdges: readonly DeliveryProfileStackEdge[];
  readonly imageRefRoster: readonly string[];
  readonly policyRefRoster: readonly string[];
  readonly profileFamilyId: DeliveryProfileFamilyId;
  readonly services: readonly DeliveryProfileFamilyServiceDefinition[];
  readonly templateRefRoster: readonly string[];
  readonly toolRefRoster: readonly string[];
}

/** The tool is resolved separately; argv is passed directly without a command shell. */
export interface DeliveryProfileRecipeRef {
  readonly argv: readonly string[];
  readonly executionMode: "DIRECT_ARGV";
  readonly recipeDigest: string;
  readonly recipeRef: string;
  readonly toolRef: string;
}

export interface DeliveryProfileRecipes {
  readonly activation: DeliveryProfileRecipeRef;
  readonly backup: DeliveryProfileRecipeRef;
  readonly browser: DeliveryProfileRecipeRef;
  readonly build: DeliveryProfileRecipeRef;
  readonly health: DeliveryProfileRecipeRef;
  readonly migration: DeliveryProfileRecipeRef;
  readonly restore: DeliveryProfileRecipeRef;
  readonly rollback: DeliveryProfileRecipeRef;
  readonly test: DeliveryProfileRecipeRef;
}

export interface DeliveryProfileComposeService {
  readonly dependsOnServiceIds: readonly string[];
  readonly healthRecipeRef: string;
  readonly imageRef: string;
  readonly secretIds: readonly string[];
  readonly serviceId: string;
}

export interface DeliveryProfileComposeTopology {
  readonly networkMode: "MANAGED_INTERNAL";
  readonly services: readonly DeliveryProfileComposeService[];
}

/** Schema only. Secret values never belong in a profile revision. */
export interface DeliveryProfileSecretSchemaEntry {
  readonly consumerServiceIds: readonly string[];
  readonly purpose: string;
  readonly required: boolean;
  readonly secretId: string;
}

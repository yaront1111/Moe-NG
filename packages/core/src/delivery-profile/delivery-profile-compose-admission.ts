import {
  DELIVERY_PROFILE_LIMITS,
  type DeliveryProfileComposeService, type DeliveryProfileComposeTopology,
  type DeliveryProfileFamilyDefinition, type DeliveryProfileRevisionDraft,
  type DeliveryProfileSecretSchemaEntry,
} from "./delivery-profile-contract.js";
import {
  badReference, exact, hasDirectedCycle, malformed, readSortedItems, readSortedRefs,
  readText, sameStrings, success, type ReadResult,
} from "./delivery-profile-admission-primitives.js";

const COMPOSE_KEYS = Object.freeze(["networkMode", "services"]);
const SERVICE_KEYS = Object.freeze([
  "dependsOnServiceIds", "healthRecipeRef", "imageRef", "secretIds", "serviceId",
]);
const SECRET_KEYS = Object.freeze([
  "consumerServiceIds", "purpose", "required", "secretId",
]);

function readService(value: unknown): ReadResult<DeliveryProfileComposeService> {
  if (!exact(value, SERVICE_KEYS)) return malformed();
  const serviceId = readText(value["serviceId"]); const imageRef = readText(value["imageRef"]);
  const healthRecipeRef = readText(value["healthRecipeRef"]);
  const dependencies = readSortedRefs(
    value["dependsOnServiceIds"], DELIVERY_PROFILE_LIMITS.maxServices,
  );
  const secrets = readSortedRefs(value["secretIds"], DELIVERY_PROFILE_LIMITS.maxSecrets);
  if (!serviceId.ok) return serviceId; if (!imageRef.ok) return imageRef;
  if (!healthRecipeRef.ok) return healthRecipeRef; if (!dependencies.ok) return dependencies;
  if (!secrets.ok) return secrets;
  if (dependencies.value.includes(serviceId.value)) return badReference();
  return success(Object.freeze({
    dependsOnServiceIds: dependencies.value, healthRecipeRef: healthRecipeRef.value,
    imageRef: imageRef.value, secretIds: secrets.value, serviceId: serviceId.value,
  }));
}

export function readCompose(value: unknown): ReadResult<DeliveryProfileComposeTopology> {
  if (!exact(value, COMPOSE_KEYS) || value["networkMode"] !== "MANAGED_INTERNAL") {
    return malformed();
  }
  const services = readSortedItems(
    value["services"], DELIVERY_PROFILE_LIMITS.maxServices, false, readService,
    (item) => item.serviceId,
  );
  return services.ok ? success(Object.freeze({
    networkMode: "MANAGED_INTERNAL" as const, services: services.value,
  })) : services;
}

function readSecret(value: unknown): ReadResult<DeliveryProfileSecretSchemaEntry> {
  if (!exact(value, SECRET_KEYS) || typeof value["required"] !== "boolean") return malformed();
  const id = readText(value["secretId"]);
  const purpose = readText(value["purpose"], DELIVERY_PROFILE_LIMITS.maxStatementBytes);
  const consumers = readSortedRefs(
    value["consumerServiceIds"], DELIVERY_PROFILE_LIMITS.maxServices, false,
  );
  if (!id.ok) return id; if (!purpose.ok) return purpose; if (!consumers.ok) return consumers;
  return success(Object.freeze({
    consumerServiceIds: consumers.value, purpose: purpose.value,
    required: value["required"], secretId: id.value,
  }));
}

export function readSecrets(
  value: unknown,
): ReadResult<readonly DeliveryProfileSecretSchemaEntry[]> {
  return readSortedItems(
    value, DELIVERY_PROFILE_LIMITS.maxSecrets, true, readSecret, (item) => item.secretId,
  );
}

export function matchesFamilyDefinition(
  profile: DeliveryProfileRevisionDraft,
  definition: DeliveryProfileFamilyDefinition,
): boolean {
  if (profile.familyDefinitionDigest !== definition.definitionDigest
    || profile.stackGrammar.components.length !== definition.components.length
    || profile.stackGrammar.dependencyEdges.length !== definition.dependencyEdges.length
    || profile.composeTopology.services.length !== definition.services.length) return false;
  if (!profile.stackGrammar.components.every((component, index) => {
    const expected = definition.components[index];
    return expected !== undefined && component.componentId === expected.componentId
      && component.role === expected.role && component.technology === expected.technology;
  })) return false;
  if (!profile.stackGrammar.dependencyEdges.every((edge, index) => {
    const expected = definition.dependencyEdges[index];
    return expected !== undefined && edge.consumerComponentId === expected.consumerComponentId
      && edge.providerComponentId === expected.providerComponentId;
  })) return false;
  if (!profile.composeTopology.services.every((service, index) => {
    const expected = definition.services[index];
    return expected !== undefined && service.serviceId === expected.serviceId
      && service.imageRef === expected.imageRef
      && sameStrings(service.dependsOnServiceIds, expected.dependsOnServiceIds);
  })) return false;
  return sameStrings(profile.templateRefs.map((item) => item.artifactRef), definition.templateRefRoster)
    && sameStrings(profile.toolRefs.map((item) => item.artifactRef), definition.toolRefRoster)
    && sameStrings(profile.imageRefs.map((item) => item.imageRef), definition.imageRefRoster)
    && sameStrings([
      profile.policyRefs.budget.artifactRef,
      profile.policyRefs.operations.artifactRef,
      profile.policyRefs.resource.artifactRef,
      profile.policyRefs.security.artifactRef,
    ], definition.policyRefRoster);
}

export function profileReferencesValid(profile: DeliveryProfileRevisionDraft): boolean {
  const componentIds = profile.stackGrammar.components.map((item) => item.componentId);
  const componentSet = new Set(componentIds);
  const stackEdges = profile.stackGrammar.dependencyEdges.map((edge) => ({
    consumer: edge.consumerComponentId, provider: edge.providerComponentId,
  }));
  if (stackEdges.some((edge) => !componentSet.has(edge.consumer) || !componentSet.has(edge.provider))
    || hasDirectedCycle(componentIds, stackEdges)) return false;

  const tools = new Set(profile.toolRefs.map((item) => item.artifactRef));
  const recipes = Object.values(profile.recipes); const recipeRefs = recipes.map((item) => item.recipeRef);
  if (new Set(recipeRefs).size !== recipeRefs.length
    || recipes.some((recipe) => !tools.has(recipe.toolRef))) return false;

  const services = profile.composeTopology.services;
  const serviceIds = services.map((item) => item.serviceId); const serviceSet = new Set(serviceIds);
  const images = new Set(profile.imageRefs.map((item) => item.imageRef));
  const serviceEdges = services.flatMap((service) => service.dependsOnServiceIds.map(
    (dependency) => ({ consumer: service.serviceId, provider: dependency }),
  ));
  if (serviceEdges.some((edge) => !serviceSet.has(edge.provider))
    || hasDirectedCycle(serviceIds, serviceEdges)) return false;
  if (services.some((service) => !images.has(service.imageRef)
    || service.healthRecipeRef !== profile.recipes.health.recipeRef
    || service.secretIds.some((secretId) => {
      const schema = profile.secretSchema.find((secret) => secret.secretId === secretId);
      return schema === undefined || !schema.consumerServiceIds.includes(service.serviceId);
    }))) return false;
  return !profile.secretSchema.some((secret) => secret.consumerServiceIds.some(
    (serviceId) => !serviceSet.has(serviceId)
      || !services.find((service) => service.serviceId === serviceId)?.secretIds.includes(secret.secretId),
  ));
}

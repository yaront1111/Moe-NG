import type {
  DeliveryProfileQualification, DeliveryProfileRevision,
} from "./delivery-profile-contract.js";

/** No materialized profile ships until its real content-addressed assets are installed. */
export const BUILT_IN_DELIVERY_PROFILE_REVISIONS: readonly DeliveryProfileRevision[] =
  Object.freeze([]);

/** Qualification can only arrive through durable operator and verifier authority. */
export const BUILT_IN_DELIVERY_PROFILE_QUALIFICATIONS: readonly DeliveryProfileQualification[] =
  Object.freeze([]);

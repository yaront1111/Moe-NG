import { MAX_BLOB_BYTES } from "./store-contracts.js";

/**
 * The store's OWN recovery binding row, deliberately not a copy of the daemon's
 * domain binding. Columns the store can police itself are columns; everything
 * the store must not interpret rides in one opaque blob. That is what keeps
 * @moe/store free of an upward dependency on the daemon or on @moe/core: the
 * daemon maps its RecoveryIncarnationBinding onto these columns, and lifecycle
 * reasoning stays where reduceProject already lives.
 *
 * `slot` is a bounded enum rather than free text so a third slot cannot appear
 * by accident. The two-slot INSTALLER PROTOCOL is not defined here — only the
 * rows it needs, and the guarantee that one incarnation cannot occupy both
 * slots at once.
 */
export const SCHEMA_V4_RECOVERY_OBJECT_SQL = Object.freeze({
  recovery_bindings: `
    CREATE TABLE recovery_bindings (
      slot TEXT PRIMARY KEY NOT NULL CHECK (slot IN ('ACTIVE', 'PENDING')),
      incarnation_ref TEXT NOT NULL UNIQUE CHECK (
        length(incarnation_ref) = 64 AND incarnation_ref NOT GLOB '*[^0-9a-f]*'
      ),
      key_epoch_ref TEXT NOT NULL CHECK (
        length(key_epoch_ref) = 64 AND key_epoch_ref NOT GLOB '*[^0-9a-f]*'
      ),
      binding_codec_version TEXT NOT NULL,
      binding_digest TEXT NOT NULL CHECK (
        length(binding_digest) = 64 AND binding_digest NOT GLOB '*[^0-9a-f]*'
      ),
      binding_bytes BLOB NOT NULL CHECK (
        length(binding_bytes) > 0 AND length(binding_bytes) <= ${MAX_BLOB_BYTES}
      ),
      installed_at TEXT NOT NULL
    ) STRICT
  `,
});

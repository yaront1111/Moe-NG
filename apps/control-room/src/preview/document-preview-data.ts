export interface PreviewDocumentSource {
  readonly excerpt: string;
  readonly id: string;
  readonly label: string;
  readonly path: string;
}

export interface PreviewWorkCandidate {
  readonly id: string;
  readonly role: "Docs" | "Implementation" | "Verification";
  readonly sourceIds: readonly string[];
  readonly title: string;
}

export const PREVIEW_DOCUMENT_SOURCES: readonly PreviewDocumentSource[] = Object.freeze([
  Object.freeze({
    excerpt: "A stale ownership record keeps the daemon from reclaiming its discovery port.",
    id: "incident-note",
    label: "Incident note",
    path: "docs/incidents/stale-port.md",
  }),
  Object.freeze({
    excerpt: "Startup must prove whether the recorded process still owns the configured port.",
    id: "startup-contract",
    label: "Startup contract",
    path: "docs/contracts/startup-ownership.md",
  }),
  Object.freeze({
    excerpt: "Restart succeeds with the old port occupied and preserves the live owner.",
    id: "recovery-acceptance",
    label: "Recovery acceptance",
    path: "docs/acceptance/recovery.md",
  }),
]);

export const PREVIEW_WORK_CANDIDATES: readonly PreviewWorkCandidate[] = Object.freeze([
  Object.freeze({
    id: "recovery-contract",
    role: "Docs",
    sourceIds: Object.freeze(["incident-note", "startup-contract"]),
    title: "Write the recovery contract",
  }),
  Object.freeze({
    id: "startup-ownership",
    role: "Implementation",
    sourceIds: Object.freeze(["recovery-acceptance", "startup-contract"]),
    title: "Guard startup ownership",
  }),
  Object.freeze({
    id: "stale-recovery-proof",
    role: "Verification",
    sourceIds: Object.freeze(["incident-note", "recovery-acceptance"]),
    title: "Prove stale-record recovery",
  }),
]);

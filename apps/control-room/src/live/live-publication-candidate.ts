export interface PublicationApproval { readonly branch: string; readonly remoteUrl: string; readonly repositoryId: string; readonly sha: string }
export type PublicationPreparation = Readonly<{ ok: true; goalId: string; approval: PublicationApproval }>
  | Readonly<{ ok: false; code: string; layer: string }>;
const refused = (code = "PUBLISH_CANDIDATE_UNREADABLE", layer = "CONTROL_ROOM_PUBLISH"): PublicationPreparation => ({ ok: false, code, layer });
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}
export async function readPublicationCandidate(headers: Readonly<Record<string, string>>, goalId: string,
  remoteUrl: string | null, post?: (body: string) => Promise<Response>): Promise<PublicationPreparation> {
  try {
    const send = post ?? ((body: string) => fetch("/repository/remote/read", {
      method: "POST", body, headers, signal: AbortSignal.timeout(15_000),
    }));
    const response = await send(JSON.stringify({ goalId, remoteUrl }));
    const value: unknown = await response.json();
    const refusal = exact(value, ["outcome", "code", "layer"]);
    if (refusal?.["outcome"] === "REFUSED" && typeof refusal["code"] === "string" && typeof refusal["layer"] === "string") {
      return refused(refusal["code"], refusal["layer"]);
    }
    const frame = exact(value, ["outcome", "goalId", "approval"]);
    const approval = exact(frame?.["approval"], ["branch", "remoteUrl", "repositoryId", "sha"]);
    if (response.status !== 200 || frame?.["outcome"] !== "PUBLICATION_CANDIDATE" || frame["goalId"] !== goalId
      || approval === null || typeof approval["branch"] !== "string" || approval["branch"] === ""
      || typeof approval["remoteUrl"] !== "string" || approval["remoteUrl"] === ""
      || (remoteUrl !== null && approval["remoteUrl"] !== remoteUrl)
      || typeof approval["repositoryId"] !== "string" || !/^[a-f0-9]{64}$/u.test(approval["repositoryId"])
      || typeof approval["sha"] !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(approval["sha"])) return refused();
    return Object.freeze({ ok: true, goalId, approval: Object.freeze({ branch: approval["branch"],
      remoteUrl: approval["remoteUrl"], repositoryId: approval["repositoryId"], sha: approval["sha"] }) });
  } catch { return refused(); }
}

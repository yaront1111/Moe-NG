import { effectList, effectRecord, effectRefusal, effectSha, effectText, readEffect } from "./live-effect-read.js";
import type { EffectReadFailure } from "./live-effect-read.js";

export interface DeploymentEnvironment {
  readonly environment: string; readonly target: string | null; readonly url: string | null;
  readonly outcome: "DEPLOYED" | "REFUSED" | null; readonly sha: string | null; readonly time: string | null;
  readonly code: string | null; readonly detail: string | null; readonly releaseDecision: string | null;
}
export type DeploymentsOutcome = EffectReadFailure | { readonly status: "DEPLOYMENTS";
  readonly goalRef: string; readonly sha: string | null; readonly releaseDecision: string | null;
  readonly environments: readonly DeploymentEnvironment[] };
const LAYER = "CONTROL_ROOM_DEPLOY";
const nullableText = (value: unknown): value is string | null => value === null || effectText(value);
const nullableSha = (value: unknown): value is string | null => value === null || effectSha(value);
const invalid = (): EffectReadFailure => ({ status: "ERROR", code: "DEPLOYMENTS_RESPONSE_INVALID", layer: LAYER });

function environmentOf(value: unknown): DeploymentEnvironment | null {
  const row = effectRecord(value, ["environment", "target", "url", "outcome", "sha", "time", "code", "detail", "releaseDecision"]);
  if (row === null || !effectText(row.environment) || !/^[a-z][a-z0-9-]{0,62}$/u.test(row.environment)
    || !nullableText(row.target) || !nullableText(row.url) || !nullableSha(row.sha)
    || !nullableText(row.time) || !nullableText(row.code) || !nullableText(row.detail)
    || !nullableText(row.releaseDecision) || (row.outcome !== null && row.outcome !== "DEPLOYED" && row.outcome !== "REFUSED")) return null;
  if (row.url !== null && !/^https?:\/\//u.test(row.url)) return null;
  if (row.outcome === "DEPLOYED" && (row.sha === null || row.time === null || row.code !== null)) return null;
  return { environment: row.environment, target: row.target, url: row.url, outcome: row.outcome,
    sha: row.sha, time: row.time, code: row.code, detail: row.detail, releaseDecision: row.releaseDecision };
}
export function mapDeploymentsAnswer(status: number, body: unknown): DeploymentsOutcome {
  const refusal = effectRefusal(body); if (refusal !== null) return refusal;
  const row = effectRecord(body, ["outcome", "goalRef", "sha", "releaseDecision", "environments"]);
  if (status !== 200 || row === null || row.outcome !== "DEPLOYMENTS" || !effectText(row.goalRef)
    || !nullableSha(row.sha) || !nullableText(row.releaseDecision)) return invalid();
  const environments = effectList(row.environments, environmentOf, 32);
  if (environments === null || new Set(environments.map((entry) => entry.environment)).size !== environments.length) return invalid();
  return { status: "DEPLOYMENTS", goalRef: row.goalRef, sha: row.sha, releaseDecision: row.releaseDecision, environments };
}
export async function readDeployments(headers: Readonly<Record<string, string>>, goalRef: string): Promise<DeploymentsOutcome> {
  const answer = await readEffect(headers, "/deployments/read", { goalRef }, mapDeploymentsAnswer, LAYER);
  return answer.status === "DEPLOYMENTS" && answer.goalRef !== goalRef ? invalid() : answer;
}

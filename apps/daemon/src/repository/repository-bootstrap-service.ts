import { BOOTSTRAP_PROFILE_VERSION_UNKNOWN, generateControlledProfile, isKnownProfileVersion,
  isValidProductName } from "./controlled-profile/controlled-profile-generator.js";
import { BOOTSTRAP_RECEIPT_VERSION, bootstrapRefusal, isBootstrapGithubRequest } from "./repository-bootstrap-contracts.js";
import type { BootstrapCode, BootstrapDetail, BootstrapPorts, BootstrapReceiptV1,
  BootstrapRefusal, BootstrapRepository, BootstrapRequest } from "./repository-bootstrap-contracts.js";

function refused(dir: string, decidedAt: string, refusal: BootstrapRefusal): BootstrapReceiptV1 {
  return { version: BOOTSTRAP_RECEIPT_VERSION, decidedAt, dir, outcome: "REFUSED",
    sha: null, remoteUrl: null, refusal, githubRefusal: null };
}

function validate(input: BootstrapRequest): BootstrapRefusal | null {
  if (!isKnownProfileVersion(input.profileVersion))
    return bootstrapRefusal(BOOTSTRAP_PROFILE_VERSION_UNKNOWN, "PROFILE_UNKNOWN");
  if (!isValidProductName(input.productName)) return bootstrapRefusal("BOOTSTRAP_PRODUCT_NAME_INVALID", "PRODUCT_NAME_INVALID");
  if (input.github !== undefined && !isBootstrapGithubRequest(input.github))
    return bootstrapRefusal("BOOTSTRAP_PAYLOAD_INVALID", "GITHUB_REQUEST_INVALID");
  return null;
}

async function githubHalf(input: BootstrapRequest, dir: string, ports: BootstrapPorts):
Promise<{ remoteUrl: string | null; githubRefusal: BootstrapRefusal | null }> {
  if (input.github === undefined) return { remoteUrl: null, githubRefusal: null };
  try {
    const result = await ports.gh.create(dir, input.github);
    if (!result.ok) return { remoteUrl: null, githubRefusal: result.refusal };
    // Exact canonical URL equality rejects userinfo, query tokens, fragments and alternative hosts.
    if (result.remoteUrl === `https://github.com/${input.github.owner}/${input.github.name}`)
      return { remoteUrl: result.remoteUrl, githubRefusal: null };
    return { remoteUrl: null, githubRefusal: bootstrapRefusal("BOOTSTRAP_GH_UNAVAILABLE", "REMOTE_URL_REJECTED") };
  } catch {
    return { remoteUrl: null, githubRefusal: bootstrapRefusal("BOOTSTRAP_GH_UNAVAILABLE", "GH_EXECUTION_FAILED") };
  }
}

/** The parent registers the project first, then supplies the EXISTING project.bind_repository
 * handler (bootstrap-services.ts bindRepository), then the project-catalog registration port.
 * This module never reduces/persists a command and does not claim to write a durable receipt.
 * It RETURNS a receipt on every effect failure; the parent's command edge owns persistence.
 * Partial failure retains the tree/.git for inspection. A retry refuses DIR_NOT_EMPTY, rather
 * than silently resuming or appending a commit to an operator's directory. */
export async function bootstrapRepository(input: BootstrapRequest, ports: BootstrapPorts): Promise<BootstrapReceiptV1> {
  const decidedAt = ports.now();
  let dir = input.dir;
  const invalid = validate(input);
  if (invalid !== null) return refused(dir, decidedAt, invalid);
  let failureCode: BootstrapCode = "BOOTSTRAP_DIR_INVALID";
  let failureDetail: BootstrapDetail = "DIRECTORY_INVALID";
  try {
    const prepared = await ports.tree.prepare(dir);
    if (!prepared.ok) return refused(dir, decidedAt, prepared.refusal);
    dir = prepared.dir;
    failureCode = "BOOTSTRAP_TREE_WRITE_FAILED"; failureDetail = "TREE_WRITE_FAILED";
    const tree = generateControlledProfile(input);
    if (!tree.ok) return refused(dir, decidedAt, bootstrapRefusal(tree.code, "PRODUCT_NAME_INVALID"));
    const written = await ports.tree.write(dir, tree.files);
    if (!written.ok) return refused(dir, decidedAt, written.refusal);
    failureCode = "BOOTSTRAP_GIT_UNAVAILABLE"; failureDetail = "GIT_COMMAND_FAILED";
    const committed = await ports.git.commit(dir);
    if (!committed.ok) return refused(dir, decidedAt, committed.refusal);
    const remote = await githubHalf(input, dir, ports);
    const repository: BootstrapRepository = { dir, sha: committed.sha, remoteUrl: remote.remoteUrl,
      projectId: input.projectId, productName: input.productName };
    failureCode = "BOOTSTRAP_BIND_FAILED"; failureDetail = "BIND_FAILED_LOCAL_REPOSITORY_RETAINED";
    await ports.bindRepository(repository);
    failureCode = "BOOTSTRAP_CATALOG_FAILED"; failureDetail = "CATALOG_FAILED_LOCAL_REPOSITORY_RETAINED";
    await ports.registerCatalog(repository);
    return { version: BOOTSTRAP_RECEIPT_VERSION, decidedAt, dir, outcome: "BOOTSTRAPPED",
      sha: committed.sha, refusal: null, ...remote };
  } catch { return refused(dir, decidedAt, bootstrapRefusal(failureCode, failureDetail)); }
}

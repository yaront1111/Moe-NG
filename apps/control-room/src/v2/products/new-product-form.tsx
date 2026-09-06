import { useState } from "react";
import type { ChangeEvent, JSX } from "react";

import { ActionButton } from "../components/primitives.js";
import type { GoalDraft } from "../goals/goal-model.js";
import { prdStatusText } from "../goals/new-goal-form-model.js";
import { useGoalPrd } from "../goals/use-goal-prd.js";
import type {
  BootstrapVisibility, NewProductRequest, NewProductRun,
} from "./live-new-product.js";

/** Presentation only: daemon codes stay verbatim. GitHub is optional, private by default,
 * and requires a typed owner. No credential field or authority is introduced here. */

export const VISIBILITY_OPTIONS: readonly BootstrapVisibility[] =
  Object.freeze(["private", "internal", "public"]);
/** Not public. Chosen, not inherited: a wrong default here cannot be taken back. */
export const DEFAULT_VISIBILITY: BootstrapVisibility = "private";

export type OutcomeState = "ERROR" | "PARTIAL" | "SUCCESS" | "UNKNOWN";

export interface OutcomeWords {
  /** Operator prose carrying the daemon codes VERBATIM inside it, never in place of them. */
  readonly detail: string;
  readonly headline: string;
  readonly state: OutcomeState;
}

const retained = (detail: string): boolean => detail.endsWith("_LOCAL_REPOSITORY_RETAINED");

function downstreamFailure(run: NewProductRun): string {
  const step = run.chain.find((item) => item.state === "ANSWERED" && !item.outcome.ok);
  if (step?.state === "ANSWERED" && !step.outcome.ok) {
    return `${step.kind} did not complete: ${step.outcome.code} @ ${step.outcome.layer}.`;
  }
  return run.goal?.ok === false ? `Goal creation did not complete: ${run.goal.report}.` : "";
}

/** Keep local success distinct from GitHub, activation and goal creation failures. */
export function newProductWords(run: NewProductRun | null): OutcomeWords | null {
  if (run === null) return null;
  const bootstrap = run.bootstrap;
  if (bootstrap === null) {
    return {
      detail: `The daemon answered ${run.dispatch.ok ? "OK" : `${run.dispatch.code} at ${run.dispatch.layer}`}`
        + ". No repository was reported, so nothing here says one was created.",
      headline: "The new product command did not go through.", state: "ERROR",
    };
  }
  if (bootstrap.state === "NO_RECEIPT") {
    return {
      detail: `The receipt could not be read: ${bootstrap.code} at ${bootstrap.layer}.`
        + " That is not a refusal. Read it again before you retry, because a retry over a"
        + " directory that is already set up is refused BOOTSTRAP_DIR_NOT_EMPTY.",
      headline: "No bootstrap receipt was read.", state: "UNKNOWN",
    };
  }
  if (bootstrap.state === "REFUSED") {
    const { code, detail, refusedBy } = bootstrap.refusal;
    return {
      detail: `${code} (${detail}) refused by ${refusedBy}.`
        + (retained(detail)
          ? " The local repository was created and is still on disk; it "
            + (code === "BOOTSTRAP_CATALOG_FAILED" ? "is already bound to this project. Keep it; catalog registration did not complete."
              : "is not bound to a project yet. Keep it and bind it, or remove it deliberately.")
          : " No repository was created."),
      headline: retained(detail) ? "Local repository retained. Setup did not complete." : "The product was not created.",
      state: "ERROR",
    };
  }
  const { dir, remoteUrl, sha } = bootstrap.receipt;
  const where = `The repository at ${dir} exists, is committed at ${sha ?? "an unread sha"}`
    + " and is bound to this project.";
  const stopped = downstreamFailure(run);
  if (bootstrap.state === "PARTIAL_SUCCESS") {
    const { code, detail } = bootstrap.githubRefusal;
    return {
      detail: `${where} Keep it. ${stopped === "" ? "Only the" : "The"} GitHub half did not happen: the daemon reported`
        + ` ${code} (${detail}). You can add a remote later; nothing local needs redoing.${stopped === "" ? "" : ` ${stopped}`}`,
      headline: "Product created here. GitHub was not reached.",
      state: "PARTIAL",
    };
  }
  return {
    detail: `${where}${remoteUrl === null ? "" : ` Remote: ${remoteUrl}.`}${stopped === "" ? "" : ` Keep it. ${stopped}`}`,
    headline: stopped === "" ? "Product created." : "Product created here. Setup did not complete.",
    state: stopped === "" ? "SUCCESS" : "PARTIAL",
  };
}

export interface NewProductFormProps {
  readonly busy?: boolean | undefined;
  readonly onCreate: (request: NewProductRequest, draft: GoalDraft | null) => void;
  /** The last run, rendered as operator words. Null before anything was submitted. */
  readonly run?: NewProductRun | null | undefined;
}

export function NewProductForm({ busy = false, onCreate, run = null }: NewProductFormProps): JSX.Element {
  const [dir, setDir] = useState("");
  const [productName, setProductName] = useState("");
  const [owner, setOwner] = useState("");
  const [repoName, setRepoName] = useState("");
  const [visibility, setVisibility] = useState<BootstrapVisibility>(DEFAULT_VISIBILITY);
  const { acceptFile, prd, read, submittedPrd } = useGoalPrd();
  const words = newProductWords(run);

  const unresolvedPrd = read !== null && (read === "READING" || read.status === "ERROR");
  const disabled = busy || unresolvedPrd || dir.trim() === "" || productName.trim() === "";
  const submit = (): void => {
    if (disabled) return;
    const name = productName.trim();
    // THE GITHUB HALF IS REQUESTED ONLY WHEN THE OPERATOR TYPED AN OWNER. Absent, not empty:
    // an empty object would ask for a repository named nothing under nobody.
    const github = owner.trim() === ""
      ? undefined
      : { name: repoName.trim() === "" ? name : repoName.trim(), owner: owner.trim(), visibility };
    onCreate(
      { dir: dir.trim(), productName: name, ...(github === undefined ? {} : { github }) },
      submittedPrd === undefined ? null : {
        acceptanceCriteria: [], budgetEnvelope: "", prd: submittedPrd, title: name,
        outcome: `Deliver ${name} as described in the attached PRD.`,
      },
    );
  };

  return (
    <form
      className="cr2-card"
      data-testid="cr.newproduct.form"
      onSubmit={(event) => { event.preventDefault(); }}
    >
      <h2 className="cr2-field-label">New product from a PRD</h2>
      <label className="cr2-field-label" htmlFor="cr2-newproduct-dir">
        Directory (new, or empty)
      </label>
      <input
        className="cr2-field-input"
        data-testid="cr.newproduct.dir"
        id="cr2-newproduct-dir"
        maxLength={4_096}
        onChange={(event) => setDir(event.target.value)}
        placeholder="D:\projects\my-product"
        value={dir}
      />
      <label className="cr2-field-label" htmlFor="cr2-newproduct-name">Product name</label>
      <input
        className="cr2-field-input"
        data-testid="cr.newproduct.name"
        id="cr2-newproduct-name"
        maxLength={100}
        onChange={(event) => setProductName(event.target.value)}
        placeholder="my-product"
        value={productName}
      />
      <label className="cr2-field-label" htmlFor="cr2-newproduct-prd">PRD file</label>
      <input
        className="cr2-field-input"
        data-testid="cr.newproduct.prd"
        id="cr2-newproduct-prd"
        onChange={(event: ChangeEvent<HTMLInputElement>) => acceptFile(event.target.files?.[0])}
        type="file"
      />
      {prd === null ? null : (
        <p className="cr2-prd-file" data-testid="cr.newproduct.prd.file">{prd.name}</p>
      )}
      {read === null ? null : <p role="status" data-testid="cr.newproduct.prd.status">{prdStatusText(read)}</p>}

      <fieldset className="cr2-newproduct-github" data-testid="cr.newproduct.github">
        <legend className="cr2-field-label">
          GitHub repository (optional) - leave the owner blank to stay local only
        </legend>
        <label className="cr2-field-label" htmlFor="cr2-newproduct-owner">
          GitHub owner (optional)
        </label>
        <input
          className="cr2-field-input"
          data-testid="cr.newproduct.github.owner"
          id="cr2-newproduct-owner"
          maxLength={39}
          onChange={(event) => setOwner(event.target.value)}
          placeholder="Blank means no GitHub repository is requested"
          value={owner}
        />
        <label className="cr2-field-label" htmlFor="cr2-newproduct-repo">
          GitHub repository name (optional, defaults to the product name)
        </label>
        <input
          className="cr2-field-input"
          data-testid="cr.newproduct.github.name"
          id="cr2-newproduct-repo"
          maxLength={100}
          onChange={(event) => setRepoName(event.target.value)}
          value={repoName}
        />
        <label className="cr2-field-label" htmlFor="cr2-newproduct-visibility">Visibility</label>
        <select
          className="cr2-field-select"
          data-testid="cr.newproduct.github.visibility"
          id="cr2-newproduct-visibility"
          onChange={(event) => setVisibility(event.target.value as BootstrapVisibility)}
          value={visibility}
        >
          {VISIBILITY_OPTIONS.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
        <p className="cr2-newgoal-caption" data-testid="cr.newproduct.github.note">
          Nothing is sent to GitHub unless you type an owner. Visibility starts at private and
          only you can change it.
        </p>
      </fieldset>

      <div className="cr2-newgoal-actions">
        <ActionButton
          disabled={disabled}
          onClick={submit}
          testId="cr.newproduct.create"
          variant="primary"
        >
          Create product
        </ActionButton>
      </div>

      {words === null ? null : (
        <div
          aria-live="polite"
          className="cr2-newproduct-outcome"
          data-state={words.state}
          data-testid="cr.newproduct.outcome"
          role="status"
        >
          <p data-testid="cr.newproduct.outcome.headline">{words.headline}</p>
          <p data-testid="cr.newproduct.outcome.detail">{words.detail}</p>
          {run?.goal === null || run?.goal === undefined ? null : (
            <p data-testid="cr.newproduct.goal">{run.goal.report}</p>
          )}
        </div>
      )}
    </form>
  );
}

import { useState } from "react";
import type { FormEvent, JSX } from "react";

import "./project-boundary.css";
import { validProjectOrigin } from "./project-manager-client.js";

const INVALID_LINK_DETAIL = "Paste the exact plain http://127.0.0.1 project origin from Moe.";
export const PROJECT_MANAGER_HOME = "http://127.0.0.2:39122" as const;

export interface ValidProjectPairingLink {
  readonly href: string;
  readonly ok: true;
}

export interface InvalidProjectPairingLink {
  readonly code: "PROJECT_PAIRING_LINK_INVALID";
  readonly detail: typeof INVALID_LINK_DETAIL;
  readonly ok: false;
}

export type ProjectPairingLink = InvalidProjectPairingLink | ValidProjectPairingLink;

/**
 * Accept only a daemon's exact plain project origin. Query strings and
 * fragments are rejected so switching cannot transport authority.
 */
export function validateProjectPairingLink(input: string): ProjectPairingLink {
  const href = input.trim();
  if (!validProjectOrigin(href)) {
    return { code: "PROJECT_PAIRING_LINK_INVALID", detail: INVALID_LINK_DETAIL, ok: false };
  }
  return { href, ok: true };
}

export type OpenProjectWindow = (
  href: string,
  target: "_blank",
  features: "noopener,noreferrer",
) => unknown;

export interface ProjectBoundaryProps {
  readonly projectId: string | null;
  readonly openWindow?: OpenProjectWindow | undefined;
}

/**
 * Names this tab's hard project boundary and offers an honest switch: a separately
 * confirmed loopback tab. It neither reads nor persists a client-side project list.
 */
export function ProjectBoundary({ projectId, openWindow }: ProjectBoundaryProps): JSX.Element {
  const [link, setLink] = useState("");
  const [refusal, setRefusal] = useState<InvalidProjectPairingLink | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const checked = validateProjectPairingLink(link);
    if (!checked.ok) {
      setLink("");
      setRefusal(checked);
      return;
    }
    setRefusal(null);
    setLink("");
    const open = openWindow ?? ((href, target, features) =>
      window.open(href, target, features));
    open(checked.href, "_blank", "noopener,noreferrer");
  };

  return (
    <section
      aria-label="Project boundary"
      className="cr2-project-boundary"
      data-project-id={projectId ?? undefined}
      data-testid="cr.project.boundary"
    >
      <div className="cr2-project-identity">
        <span className="cr2-project-kicker">BOUND PROJECT</span>
        <strong className="cr2-project-id" data-testid="cr.project.id">
          {projectId ?? "PAIRING REQUIRED"}
        </strong>
      </div>
      <div className="cr2-project-guidance">
        <p>
          One daemon and operator-confirmed session bind this tab to one project. Its isolated goals,
          tasks, and board never mix with another project.
        </p>
        <p>
          <a href={PROJECT_MANAGER_HOME} rel="noopener noreferrer" target="_blank">
            All projects
          </a>
          {" opens the manager where you can create, start, stop, and switch projects."}
        </p>
      </div>
      <details className="cr2-project-switch">
        <summary>Open another project</summary>
        <p>
          Paste that project&apos;s plain origin. It opens a new isolated pairing request;
          this project&apos;s session stays untouched.
        </p>
        <form className="cr2-project-switch-form" onSubmit={submit}>
          <label htmlFor="cr2-project-link">Another project&apos;s origin</label>
          <div className="cr2-project-switch-row">
            <input
              autoComplete="off"
              id="cr2-project-link"
              onChange={(event) => { setLink(event.currentTarget.value); setRefusal(null); }}
              placeholder="http://127.0.0.1:39123"
              spellCheck={false}
              type="url"
              value={link}
            />
            <button type="submit">Open isolated project</button>
          </div>
          {refusal === null ? null : (
            <p className="cr2-project-refusal" role="alert">
              <strong>{refusal.code}</strong> {refusal.detail}
            </p>
          )}
        </form>
      </details>
    </section>
  );
}

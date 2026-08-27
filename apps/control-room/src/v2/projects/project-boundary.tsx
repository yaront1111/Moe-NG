import { useState } from "react";
import type { FormEvent, JSX } from "react";

import "./project-boundary.css";
import { PROJECT_MANAGER_LOCAL_LAYER, validProjectOrigin } from "./project-manager-client.js";

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
 * Names this tab's hard project boundary in one quiet row and folds every
 * explanation into one disclosure: the panel sits above every live surface, so
 * anything it repeats is repeated on every screen. It offers an honest switch -
 * a separately confirmed loopback tab - and neither reads nor persists a
 * client-side project list. The project manager runs only when the operator
 * started it (`moe projects`); `moe up` never spawns it, so its address is
 * stated as a condition, never offered as a live destination.
 *
 * A null `projectId` is one bit standing for three daemon states - the handshake
 * still in flight, the session awaiting the operator's label, and a refused claim
 * - and only the middle one puts a pairing control under this panel. The panel
 * cannot see which, so it names the binding rule and its own missing binding, and
 * never points at a control that may not be on the page.
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
      data-state={projectId === null ? "unbound" : "bound"}
      data-testid="cr.project.boundary"
    >
      <div className="cr2-project-identity">
        <span className="cr2-project-kicker">PROJECT</span>
        <strong className="cr2-project-id" data-testid="cr.project.id">
          {projectId ?? "Not paired yet"}
        </strong>
      </div>
      {projectId === null ? (
        <p className="cr2-project-note" data-testid="cr.project.note">
          This tab is bound to one project once its session pairs.
        </p>
      ) : null}
      <details className="cr2-project-switch">
        <summary>Open another project</summary>
        <p>
          One daemon and operator-confirmed session bind this tab to one project. Its isolated goals,
          tasks, and board never mix with another project.
        </p>
        <p>
          Paste that project&apos;s plain origin - Moe prints it in the terminal when a project
          starts. It opens a new isolated pairing request; this project&apos;s session stays
          untouched.
        </p>
        <p className="cr2-project-manager">
          {"If you started Moe Projects (the "}
          <code>moe projects</code>
          {" command), its page is at "}
          <a href={PROJECT_MANAGER_HOME} rel="noopener noreferrer" target="_blank">
            127.0.0.2:39122
          </a>
          .
        </p>
        <form className="cr2-project-switch-form" onSubmit={submit}>
          <label htmlFor="cr2-project-link">Another project&apos;s origin</label>
          <div className="cr2-project-switch-row">
            <input
              autoComplete="off"
              id="cr2-project-link"
              inputMode="url"
              onChange={(event) => { setLink(event.currentTarget.value); setRefusal(null); }}
              placeholder="http://127.0.0.1:39123"
              spellCheck={false}
              type="text"
              value={link}
            />
            <button type="submit">Open isolated project</button>
          </div>
          {refusal === null ? null : (
            <div className="cr2-project-refusal" role="alert">
              <p>{refusal.detail}</p>
              <details className="cr2-project-refusal-details">
                <summary>Details</summary>
                <code>{refusal.code}@{PROJECT_MANAGER_LOCAL_LAYER}</code>
              </details>
            </div>
          )}
        </form>
      </details>
    </section>
  );
}

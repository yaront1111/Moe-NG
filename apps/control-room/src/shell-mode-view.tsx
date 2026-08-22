import type { JSX } from "react";

import { CONTROL_ROOM_FIXTURE_KIND } from "./fixtures.js";
import { ControlRoomScaffold } from "./kernel.js";
import { LiveControlRoom } from "./live/live-app.js";
import type { LiveSetupResult } from "./live/live-config.js";
import { LIVE_CREDENTIAL_ENV_VARS } from "./shell-mode.js";
import type { ShellMode } from "./shell-mode.js";

/**
 * What each shell mode paints. Split from `main.tsx` so the composition root
 * stays a mount and a decision, and so all three arms can be rendered by a test
 * without the module's mount-on-evaluation side effect.
 */

/** Where an operator is sent to fix an unconfigured build. */
const RUNBOOK_PATH = "docs/agent-stack-runbook.md";

/** The id `aria-labelledby` points at, so the notice is a NAMED landmark region. */
const NOTICE_HEADING_ID = "cr-config-notice-heading";

/**
 * Persistent, and deliberately not dismissible: an operator who followed a
 * `?fixtures=1` link on a fully credentialed build still needs to be told the
 * numbers under it are frozen. The label is composed from the fixture module's
 * OWN marker rather than restated here, so it cannot drift away from the thing
 * it labels — rename the marker and this sentence renames itself.
 */
export function FixtureBanner(): JSX.Element {
  return (
    <div aria-live="polite" data-testid="cr.banner.fixture" role="status">
      <span data-testid="cr.banner.fixture.text">
        {`Fixture board — ${CONTROL_ROOM_FIXTURE_KIND}. Every value below is a frozen
          literal, not the daemon. Drop the ?fixtures=1 parameter for the live board.`
          .replace(/\s+/gu, " ")}
      </span>
    </div>
  );
}

/**
 * The fail-closed arm. A build with no credentials gets THIS, never fixtures:
 * frozen data rendered where live data was expected is indistinguishable from a
 * working system with nothing to say, and that is the one failure an operator
 * cannot diagnose from the screen.
 *
 * It names both variables and the refusal's own stable code, so the sentence on
 * screen and the code in `live-config.ts` say the same thing.
 */
export function LiveConfigNotice(): JSX.Element {
  return (
    <section
      aria-labelledby={NOTICE_HEADING_ID}
      data-testid="cr.config.notice"
      role="region"
    >
      <h1 id={NOTICE_HEADING_ID}>The control room is not attached to a daemon</h1>
      <p>
        <code>LIVE_CONFIG_MISSING</code>: this build carries no daemon session, so there
        is nothing real to show. No fixture data is rendered in its place.
      </p>
      <p>Set both of these at build time and reload:</p>
      <ul data-testid="cr.config.notice.variables">
        {LIVE_CREDENTIAL_ENV_VARS.map((variable) => (
          <li key={variable}><code>{variable}</code></li>
        ))}
      </ul>
      <p>
        Serving story, daemon port and scratch-credential steps: <code>{RUNBOOK_PATH}</code>,
        section “Control room (serving story)”. To browse the frozen development
        fixtures instead, add <code>?fixtures=1</code>.
      </p>
    </section>
  );
}

export interface ShellModeRootProps {
  readonly mode: ShellMode;
  readonly setup: LiveSetupResult;
}

/**
 * One switch over the resolved mode. Exhaustive by construction: `ShellMode` is
 * a closed union, so a fourth arm cannot be added without this failing to
 * compile rather than falling through to whichever branch happens to be last.
 */
export function ShellModeRoot({ mode, setup }: ShellModeRootProps): JSX.Element {
  if (mode === "FIXTURES") {
    return (
      <>
        <FixtureBanner />
        <ControlRoomScaffold />
      </>
    );
  }
  if (mode === "CONFIG_NOTICE") return <LiveConfigNotice />;
  return <LiveControlRoom setup={setup} />;
}

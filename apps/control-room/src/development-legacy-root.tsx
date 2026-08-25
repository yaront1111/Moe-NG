import type { JSX } from "react";

import { resolveLiveSetupFromBuild } from "./live/live-app.js";
import { resolveShellMode } from "./shell-mode.js";
import { ShellModeRoot } from "./shell-mode-view.js";

/** Development-only adapter for the retired v1/demo control-room surface. */
export default function DevelopmentLegacyRoot({ search }: { readonly search: string }): JSX.Element {
  const setup = resolveLiveSetupFromBuild();
  return <ShellModeRoot mode={resolveShellMode(search, setup)} setup={setup} />;
}

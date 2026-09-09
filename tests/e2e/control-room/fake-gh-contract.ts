/**
 * THE SIDE-EFFECT-FREE HALF of the release lane's `gh` double, so a spec can name the url it
 * expects without importing the provider.
 *
 * `fake-gh-dependencies.ts` reads `MOE_STORE_PATH` AT MODULE LOAD and throws
 * STORE_DEPENDENCIES_ENV_MISSING outside a daemon child -- which is exactly what happens when
 * Playwright collects a spec that imports it. `daemon-ports.ts` sidesteps that for the docker
 * double by importing only its TYPE; a spec needs VALUES, so they live here instead.
 */

/** Test-only selection: no production module reads this key or imports this provider. */
export type FakeGhMode = "SUCCESS" | "RELEASE_PR_FAILED";

export const FAKE_GH_MODES: readonly FakeGhMode[] = Object.freeze(["SUCCESS", "RELEASE_PR_FAILED"]);

/** The url the SUCCESS mode answers with. A lane-local path, so nothing here can be mistaken
 *  for a pull request that exists on github.com. */
export const FAKE_PR_URL = "https://github.com/moe-lane/release-approval/pull/1";

/** The stderr `gh` really prints when the repository it is run in has no GitHub remote. It is
 *  quoted rather than invented so the refusal an operator reads is one gh actually emits. */
export const FAKE_GH_STDERR = "could not determine base repository: no git remotes found";

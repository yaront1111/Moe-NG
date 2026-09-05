import type { DesignRevision, DesignSkip } from "./design-contracts.js";

/**
 * INPUTS ONLY for the design suites. No `expect`, no `describe`, no `it`.
 *
 * WHY A MODULE RATHER THAN AN EXPORT FROM A TEST FILE. Importing a `*.test.ts` re-runs its
 * `describe`/`it` registrations inside the importing file, so the same arms are collected twice
 * and the run's test count silently doubles — which is exactly how a suite stops being able to
 * prove how many cases it executed. A fixture that judged an outcome would be a second authority
 * beside the one under test, so this module only supplies values.
 */

/** One complete, lawful revision: all five sections populated plus the open-decisions list. */
export function designRevisionFixture(): DesignRevision {
  return {
    apiSurface: [
      { payload: "{ email, password }", route: "POST /api/sessions" },
      { payload: "{ items: Item[] }", route: "GET /api/items" },
    ],
    componentList: ["AppShell", "ItemTable", "SignInForm"],
    dataModel: [
      { entity: "User", fields: ["email", "id", "passwordHash"], relations: ["Item.ownerId"] },
      { entity: "Item", fields: ["id", "ownerId", "title"], relations: ["User.id"] },
    ],
    nonFunctional: {
      accessibility: "WCAG 2.2 AA, keyboard-reachable on every screen",
      auth: "session cookie, argon2id password hash, 30 day idle expiry",
      performance: "p95 API 200ms, first contentful paint under 1.5s",
    },
    openDecisions: ["Does the operator want SSO in v1?"],
    screens: [
      {
        journey: "Sign in and reach the item list",
        screens: [
          { screen: "SignIn", states: ["EMPTY", "ERROR", "SUBMITTING"] },
          { screen: "ItemList", states: ["EMPTY", "LOADED", "LOADING"] },
        ],
      },
    ],
  };
}

/** One lawful DECLARED SKIP: the two-key shape, with the operator's stated reason. */
export function designSkipFixture(): DesignSkip {
  return {
    reason: "Internal CLI tool: the operator plans straight from the approved contract",
    skipped: true,
  };
}

/** Version 2's content, distinguishable from version 1 in EVERY section. */
export function secondDesignRevisionFixture(): DesignRevision {
  const base = designRevisionFixture();
  return {
    apiSurface: [...base.apiSurface, { payload: "{ id }", route: "DELETE /api/items/:id" }],
    componentList: [...base.componentList, "ConfirmDialog"],
    dataModel: [...base.dataModel, { entity: "Session", fields: ["id", "userId"], relations: [] }],
    nonFunctional: { ...base.nonFunctional, auth: "session cookie plus WebAuthn second factor" },
    openDecisions: ["Does the operator want SSO in v1?", "Soft delete or hard delete?"],
    screens: [...base.screens, {
      journey: "Delete an item",
      screens: [{ screen: "ConfirmDelete", states: ["CONFIRMING", "DELETED"] }],
    }],
  };
}

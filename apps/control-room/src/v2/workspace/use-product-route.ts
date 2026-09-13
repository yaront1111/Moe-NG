import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveSetup } from "../../live/live-config.js";
import { readGoalCatalog } from "../../live/live-goal-catalog.js";
import { boardRoute } from "../shell/shell-routes.js";
import type { BoardRoute } from "../shell/shell-routes.js";
import { readProductQuery, writeProductQuery } from "./product-query.js";
import type { ProductQueryUpdate } from "./product-query.js";
import type { GoalsData } from "../goals/goal-model.js";

/** Resolve public links against the authenticated inventory; a URL never provides identity evidence. */
export function useProductRoute(setup: LiveSetup | null, initialSearch: string, fixtures: GoalsData | null = null) {
  const [query, setQuery] = useState(() => readProductQuery(initialSearch || window.location.search));
  // Navigation writes become current immediately, before React flushes older render effects.
  const queryRef = useRef(query);
  const setupRef = useRef(setup);
  setupRef.current = setup;
  const [resolved, setResolved] = useState<{ setup: LiveSetup | null; route: BoardRoute } | null>(null);
  const [failure, setFailure] = useState<{ setup: LiveSetup | null; goalId: string; message: string } | null>(null);
  const goalId = query !== null && !("kind" in query) ? query.goalId : null;
  useEffect(() => {
    const restore = () => { const next = readProductQuery(window.location.search); queryRef.current = next; setQuery(next); };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const open = resolved?.setup === setup && resolved.route.goalId === goalId ? resolved.route : null;
  useEffect(() => {
    if (goalId === null || open !== null) return;
    if (fixtures !== null) {
      const goals = fixtures.goals.filter((goal) => goal.goalId === goalId);
      if (goals.length === 1) {
        const goal = goals[0]!;
        setResolved({ setup, route: boardRoute(goalId, goal.planningRunRef ?? "", goal.title) });
      } else setFailure({ setup, goalId, message: "This example product is not in the catalog." });
      return;
    }
    if (setup === null) return;
    let active = true;
    void readGoalCatalog({ headers: setup.headers }).then((catalog) => {
      if (!active) return;
      const entries = catalog.outcome === "GOALS" ? catalog.goals.filter((row) => row.goalId === goalId) : [];
      if (entries.length === 1) {
        const goal = entries[0]!;
        setResolved({ setup, route: boardRoute(goal.goalId, goal.planningRunRef, goal.brief?.title ?? "Untitled product") });
      } else setFailure({ setup, goalId, message: catalog.outcome === "GOALS"
        ? "This product is not in the connected project's catalog." : "The product catalog could not be read. Refresh to try again." });
    }, () => { if (active) setFailure({ setup, goalId, message: "The product catalog could not be read. Refresh to try again." }); });
    return () => { active = false; };
  }, [setup, goalId, open, fixtures]);
  const update = useCallback((change: ProductQueryUpdate, replace = false) => {
    if (setupRef.current !== setup) return;
    if (typeof change === "function" && queryRef.current !== null && "kind" in queryRef.current) return;
    const current = queryRef.current !== null && !("kind" in queryRef.current) ? queryRef.current : null;
    const next = typeof change === "function" ? change(current) : change;
    if (typeof change === "function" && next === current) return;
    const search = writeProductQuery(window.location.search, next);
    window.history[replace ? "replaceState" : "pushState"](null, "", window.location.pathname + search);
    queryRef.current = next;
    setQuery(next);
  }, [setup]);
  const openProduct = useCallback((goal: string, run: string, title: string) => {
    if (run !== "" || setup === null) setResolved({ setup, route: boardRoute(goal, run, title) });
    setFailure(null); update({ goalId: goal, artifactId: null, inspector: null });
  }, [setup, update]);
  const back = useCallback(() => { update(null); setFailure(null); }, [update]);
  const current = query !== null && !("kind" in query) ? query : null;
  return { open, query: current, requested: query !== null, update, openProduct, back,
    error: query !== null && "kind" in query ? "This product link is invalid."
      : failure?.setup === setup && failure.goalId === goalId ? failure.message : null };
}

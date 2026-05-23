import { findPiRoot } from "./pi.js";
import { loadState, saveState, type State } from "./state.js";

/**
 * The cross-cutting context threaded through every domain operation.
 * Produced by `withSession`, consumed by reconcile/operations/edits/status.
 */
export type Ctx = { piRoot: string; state: State };

/**
 * Opens a session: discovers pi, loads state, runs `fn`, saves state.
 * State is saved even if `fn` throws — partial progress is never lost.
 */
export function withSession<T>(fn: (ctx: Ctx) => T): T {
  const piRoot = findPiRoot();
  const state = loadState();
  state.piRoot = piRoot;
  try {
    return fn({ piRoot, state });
  } finally {
    saveState(state);
  }
}

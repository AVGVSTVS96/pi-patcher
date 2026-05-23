import { clearError, patchError } from "../state.js";
import type { Ctx } from "../session.js";
import * as ops from "./operations.js";
import { statusOf } from "./status.js";
import type { Patch } from "./types.js";

/**
 * Layer 3 — policy.
 *
 * Given a patch and the current world, pick the right Layer 2 operation
 * (apply / revert / heal) and run it. Returns void on success; throws if
 * the chosen operation failed and there is nothing more to try.
 */
export function reconcile(patch: Patch, ctx: Ctx): void {
  if (patch.tombstoned) return ops.revert(patch, ctx);

  switch (statusOf(patch, ctx)) {
    case "applied":
      clearError(ctx.state, patch.id);
      return;
    case "pending":
      return ops.apply(patch, ctx);
    case "drift":
      if (ops.heal(patch, ctx)) return;
      throw new Error(patchError(ctx.state, patch.id) ?? "heal failed");
    case "tombstoned":
      // Unreachable: handled above. Kept for exhaustiveness.
      return;
  }
}

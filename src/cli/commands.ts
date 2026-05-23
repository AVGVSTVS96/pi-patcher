import { withSession } from "../session.js";
import {
  allPatches,
  deletePatch,
  loadPatch,
  markTombstoned,
} from "../patch/io.js";
import { reconcile } from "../patch/reconcile.js";
import { heal } from "../patch/operations.js";
import { statusOf } from "../patch/status.js";
import { forgetPatch, lastSession, recordError } from "../state.js";
import { say, errorMessage } from "../log.js";

export function cmdReconcile(args: string[]): number {
  const afterUpdate = args.includes("--after-update");
  return withSession((ctx) => {
    ctx.state.lastRunAt = new Date().toISOString();
    let failed = 0;
    for (const patch of allPatches()) {
      try {
        reconcile(patch, ctx);
      } catch (error) {
        failed++;
        const message = errorMessage(error);
        recordError(ctx.state, patch.id, message);
        say(`pi-patcher: ${patch.id} failed: ${message}`);
      }
    }
    return failed && !afterUpdate ? 1 : 0;
  });
}

export function cmdHeal(id: string): number {
  return withSession((ctx) => (heal(loadPatch(id), ctx) ? 0 : 1));
}

export function cmdList(): number {
  return withSession((ctx) => {
    for (const patch of allPatches()) {
      const session = lastSession(ctx.state, patch.id);
      console.log(
        `${patch.id.padEnd(20)} ${statusOf(patch, ctx)}${session ? `\t${session}` : ""}`,
      );
    }
    return 0;
  });
}

export function cmdRemove(id: string): number {
  // Active remove = tombstone + reconcile (which reverts) + delete + forget.
  // If reconcile throws, the tombstone stays in place and the next call to
  // `pi-patcher reconcile` will retry the revert.
  return withSession((ctx) => {
    markTombstoned(id);
    reconcile(loadPatch(id), ctx);
    deletePatch(id);
    forgetPatch(ctx.state, id);
    say(`pi-patcher: removed ${id}`);
    return 0;
  });
}

#!/usr/bin/env node
import {
  type Patch,
  allPatches,
  applyEdits,
  ensureLayout,
  findPiRoot,
  loadPatch,
  removePatchDir,
  revertEdits,
  statusOf,
} from "./patches.js";
import {
  type State,
  forgetPatch,
  lastSession,
  loadState,
  patchError,
  recordApplied,
  recordError,
  recordReverted,
  saveState,
} from "./state.js";
import { heal } from "./heal.js";

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`pi-patcher: ${msg(error)}`);
  process.exitCode = 1;
}

function main(argv: string[]): number {
  const [cmd = "reconcile", ...rest] = argv;
  switch (cmd) {
    case "reconcile":
      return cmdReconcile();
    case "list":
      return cmdList();
    case "heal":
      return cmdHeal(requireArg(rest[0], "heal <id>"));
    case "remove":
      return cmdRemove(requireArg(rest[0], "remove <id>"));
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

/**
 * Bring every patch to its desired state. Newly-authored patches get
 * applied; already-applied patches are skipped; drifted patches are handed
 * to the AI heal flow. Exits non-zero if any patch fails so users notice
 * after `pi update`.
 */
function cmdReconcile(): number {
  return withSession((piRoot, state) => {
    let failed = 0;
    for (const patch of allPatches()) {
      try {
        reconcileOne(patch, piRoot, state);
      } catch (error) {
        failed++;
        const message = msg(error);
        recordError(state, patch.id, message);
        console.log(`pi-patcher: ${patch.id} failed: ${message}`);
      }
    }
    return failed ? 1 : 0;
  });
}

function reconcileOne(patch: Patch, piRoot: string, state: State): void {
  switch (statusOf(patch, piRoot)) {
    case "applied":
      delete state.patches[patch.id]?.lastError;
      return;
    case "pending": {
      const targetSha = applyEdits(patch, piRoot);
      if (targetSha) recordApplied(state, patch.id, targetSha);
      console.log(`pi-patcher: applied ${patch.id}`);
      return;
    }
    case "drift":
      if (!heal(patch, piRoot, state))
        throw new Error(patchError(state, patch.id) ?? "heal failed");
      return;
  }
}

function cmdList(): number {
  return withSession((piRoot, state) => {
    for (const patch of allPatches()) {
      const session = lastSession(state, patch.id);
      console.log(
        `${patch.id.padEnd(20)} ${statusOf(patch, piRoot)}${session ? `\t${session}` : ""}`,
      );
    }
    return 0;
  });
}

function cmdHeal(id: string): number {
  return withSession((piRoot, state) =>
    heal(loadPatch(id), piRoot, state) ? 0 : 1,
  );
}

/**
 * Revert the patch's mechanical edits, then delete the folder and forget
 * its state. If the file has drifted (newText no longer matches), bail out
 * with a non-zero exit so the user can resolve the file manually before
 * retrying. No AI revert — keep removal predictable.
 */
function cmdRemove(id: string): number {
  return withSession((piRoot, state) => {
    const patch = loadPatch(id);
    const status = statusOf(patch, piRoot);

    if (status === "drift")
      throw new Error(
        `${id} has drifted; the original edit isn't where we left it. ` +
          `Edit the target file by hand to remove the patch's effect, then re-run \`pi-patcher remove ${id}\`. ` +
          `If you just want the folder gone, \`rm -rf ~/.pi/patches/${id}\`.`,
      );

    if (status === "applied") {
      const targetSha = revertEdits(patch, piRoot);
      if (targetSha) recordReverted(state, patch.id, targetSha);
      console.log(`pi-patcher: reverted ${id}`);
    }

    removePatchDir(id);
    forgetPatch(state, id);
    console.log(`pi-patcher: removed ${id}`);
    return 0;
  });
}

// ── Session ──────────────────────────────────────────────────
function withSession<T>(fn: (piRoot: string, state: State) => T): T {
  ensureLayout();
  const piRoot = findPiRoot();
  const state = loadState();
  state.piRoot = piRoot;
  state.lastRunAt = new Date().toISOString();
  try {
    return fn(piRoot, state);
  } finally {
    saveState(state);
  }
}

function requireArg<T>(value: T | undefined, hint: string): T {
  if (value == null) throw new Error(`Usage: pi-patcher ${hint}`);
  return value;
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

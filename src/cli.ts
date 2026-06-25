#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  type Patch,
  type SyncEvent,
  ROOT,
  allPatches,
  applyEdits,
  ensureLayout,
  findPiRoot,
  isInternalPatch,
  loadPatch,
  removePatchDir,
  revertEdits,
  statusOf,
  syncInternalPatches,
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
import {
  logApplied,
  logFailure,
  logHeader,
  logInfo,
  logLabeledDetail,
  logSuccess,
  logWarn,
} from "./ui.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`pi-patcher: ${msg(error)}`);
    process.exitCode = 1;
  },
);

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    console.log(helpText());
    return 0;
  }
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "init":
      return await cmdInit();
    case "reconcile":
      return await cmdReconcile();
    case "list":
      return await cmdList();
    case "heal":
      return await cmdHeal(requireArg(rest[0], "heal <id>"));
    case "remove":
      return await cmdRemove(requireArg(rest[0], "remove <id>"));
    case "uninstall":
      return await cmdUninstall();
    case "help":
    case "--help":
    case "-h":
      console.log(helpText());
      return 0;
    case "version":
    case "--version":
    case "-v":
      console.log(version());
      return 0;
    default:
      console.error(`pi-patcher: unknown command: ${cmd}`);
      console.error(`Run \`pi-patcher --help\` for usage.`);
      return 1;
  }
}

function helpText(): string {
  return `pi-patcher ${version()}
Self-healing patches for pi.

Usage:
  pi-patcher init             Install bundled patches and wire into \`pi update\`
  pi-patcher reconcile        Apply pending patches; heal drifted ones
  pi-patcher list             Show status and most recent heal session
  pi-patcher heal <id>        Re-anchor a drifted patch via AI
  pi-patcher remove <id>      Revert edits and delete the patch folder
  pi-patcher uninstall        Revert every patch and uninstall the npm package

  pi-patcher --help, -h       Show this help
  pi-patcher --version, -v    Show version

First-run flow: \`npm install -g pi-patcher && pi-patcher init\`.
Docs: https://github.com/AVGVSTVS96/pi-patcher`;
}

function version(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Bring every patch to its desired state. Newly-authored patches get
 * applied; already-applied patches are skipped; drifted patches are handed
 * to the AI heal flow. Exits non-zero if any patch fails so users notice
 * after `pi update`.
 *
 * Internal (bundled) patches are refreshed first — refresh-only, so a bare
 * `reconcile` without a prior `init` stays a no-op, but a shipped fix lands
 * automatically the next time `pi update` runs reconcile.
 */
async function cmdReconcile(): Promise<number> {
  return await withSession(async (piRoot, state) => {
    logHeader();
    state.internalBaseShas ??= {};
    logSyncEvents(syncInternalPatches(state.internalBaseShas, "refresh-only"));
    const summary = await applyAll(piRoot, state);
    logSummary(summary);
    return summary.failed ? 1 : 0;
  });
}

type RunSummary = {
  applied: number;
  healed: number;
  current: number;
  failed: number;
};

class ReportedPatchFailure extends Error {}

/**
 * Reconcile every discovered patch, accumulating a summary. Always logs a
 * one-line result so a `pi update`-triggered reconcile shows what pi-patcher
 * did or found, even when everything is already up to date.
 */
async function applyAll(piRoot: string, state: State): Promise<RunSummary> {
  const summary: RunSummary = { applied: 0, healed: 0, current: 0, failed: 0 };
  for (const patch of allPatches()) {
    try {
      summary[await reconcileOne(patch, piRoot, state)]++;
    } catch (error) {
      summary.failed++;
      const message = msg(error);
      recordError(state, patch.id, message);
      if (!(error instanceof ReportedPatchFailure))
        logFailure(`${patch.id} failed: ${message}`);
    }
  }
  return summary;
}

async function reconcileOne(
  patch: Patch,
  piRoot: string,
  state: State,
): Promise<"applied" | "healed" | "current"> {
  switch (statusOf(patch, piRoot)) {
    case "applied":
      delete state.patches[patch.id]?.lastError;
      logSuccess(`${patch.id} already current`);
      return "current";
    case "pending": {
      if (applyEdits(patch, piRoot)) recordApplied(state, patch.id);
      logApplied(patch.id);
      return "applied";
    }
    case "drift":
      if (!(await heal(patch, piRoot, state)))
        throw new ReportedPatchFailure(patchError(state, patch.id) ?? "heal failed");
      return "healed";
  }
}

function logSyncEvents(events: SyncEvent[]): void {
  for (const e of events)
    logInfo(
      e.action === "seeded"
        ? `seeded internal patch ${e.id}`
        : `refreshed internal patch ${e.id} (shipped update)`,
    );
}

function logSummary(s: RunSummary): void {
  const parts: string[] = [];
  if (s.applied) parts.push(`${s.applied} applied`);
  if (s.healed) parts.push(`${s.healed} healed`);
  if (s.current) parts.push(`${s.current} already current`);
  if (s.failed) parts.push(`${s.failed} failed`);
  console.log(`  ${parts.length ? parts.join(", ") : "no patches to apply"}`);
}

async function cmdList(): Promise<number> {
  return await withSession((piRoot, state) => {
    logHeader();
    let found = false;
    for (const patch of allPatches()) {
      found = true;
      const status = statusOf(patch, piRoot);
      if (status === "applied") logSuccess(`${patch.id} applied`);
      else if (status === "pending") logInfo(`${patch.id} pending`);
      else logWarn(`${patch.id} drifted`);

      const session = lastSession(state, patch.id);
      if (session) logLabeledDetail("Last heal", `pi --session ${sessionArg(session)}`);
    }
    if (!found) console.log("  no patches found");
    return 0;
  });
}

function sessionArg(session: string): string {
  const base = path.basename(session).replace(/\.jsonl$/, "");
  return base.includes("_") ? base.slice(base.lastIndexOf("_") + 1) : base;
}

async function cmdHeal(id: string): Promise<number> {
  return await withSession(async (piRoot, state) =>
    (await heal(loadPatch(id), piRoot, state)) ? 0 : 1,
  );
}

/**
 * Revert the patch's mechanical edits, then delete the folder and forget
 * its state. If the file has drifted (newText no longer matches), bail out
 * with a non-zero exit so the user can resolve the file manually before
 * retrying. No AI revert — keep removal predictable.
 */
async function cmdRemove(id: string): Promise<number> {
  return await withSession((piRoot, state) => {
    if (isInternalPatch(id))
      throw new Error(
        `${id} is managed by pi-patcher; use \`pi-patcher uninstall\` to remove it`,
      );

    const patch = loadPatch(id);
    const status = statusOf(patch, piRoot);

    if (status === "drift")
      throw new Error(
        `${id} has drifted; the original edit isn't where we left it. ` +
          `Edit the target file by hand to remove the patch's effect, then re-run \`pi-patcher remove ${id}\`. ` +
          `If you just want the folder gone, \`rm -rf ~/.pi/patches/${id}\`.`,
      );

    if (status === "applied") {
      if (revertEdits(patch, piRoot)) recordReverted(state, patch.id);
      console.log(`pi-patcher: reverted ${id}`);
    }

    removePatchDir(id);
    forgetPatch(state, id);
    console.log(`pi-patcher: removed ${id}`);
    return 0;
  });
}

/**
 * `pi-patcher init` — the single user-facing command for opting into
 * pi-patcher's modifications to your pi install. Seeds the bundled patches
 * (currently just `bootstrap-hook`) into `~/.pi/pi-patcher/internal-patches/`,
 * then applies them. Idempotent: safe to re-run after upgrades to pick up
 * newly-bundled patches or shipped fixes (seed + refresh).
 *
 * No `postinstall` hook runs this automatically — we explicitly want the
 * user to opt in to mutating their pi install.
 */
async function cmdInit(): Promise<number> {
  return await withSession(async (piRoot, state) => {
    logHeader();
    state.internalBaseShas ??= {};
    logSyncEvents(syncInternalPatches(state.internalBaseShas, "seed"));
    const summary = await applyAll(piRoot, state);
    logSummary(summary);
    if (!summary.failed) {
      console.log("");
      console.log("pi-patcher is wired into pi update.");
      console.log("To remove cleanly later, run: pi-patcher uninstall");
    }
    return summary.failed ? 1 : 0;
  });
}

/**
 * `pi-patcher uninstall` — the single user-facing command for tearing
 * pi-patcher down. Reverts every applied patch (skipping drifted ones,
 * since the user has already modified those files), deletes every patch
 * folder — user patches under `~/.pi/patches/` and managed ones under
 * `~/.pi/pi-patcher/internal-patches/` alike — forgets state, then runs
 * `npm uninstall -g pi-patcher`.
 *
 * Drift is not a hard error: if the user has a custom patch whose target
 * file has been rewritten upstream, we can't safely revert it. We delete
 * the patch folder anyway and tell the user. They explicitly asked to
 * uninstall; we shouldn't block on a broken patch.
 */
async function cmdUninstall(): Promise<number> {
  const cleanupExit = await withSession((piRoot, state) => {
    let issues = 0;
    for (const patch of allPatches()) {
      try {
        const status = statusOf(patch, piRoot);
        if (status === "applied") {
          revertEdits(patch, piRoot);
          logSuccess(`${patch.id} reverted`);
        } else if (status === "drift") {
          issues++;
          logWarn(`${patch.id} skipped (drifted; file already modified upstream, left as-is)`);
        }
      } catch (error) {
        issues++;
        logFailure(`${patch.id} revert failed: ${msg(error)} (continuing)`);
      }
      // Remove by the patch's actual directory so managed patches are deleted
      // from internal-patches/, not just user patches from ~/.pi/patches/.
      fs.rmSync(patch.dir, { recursive: true, force: true });
      delete state.patches[patch.id];
    }
    delete state.internalBaseShas;
    console.log(
      issues
        ? `pi-patcher: removed ${issues === 1 ? "1 patch with caveats" : `patches (${issues} with caveats)`}; running \`npm uninstall -g pi-patcher\`…`
        : `pi-patcher: all patches cleaned up; running \`npm uninstall -g pi-patcher\`…`,
    );
    return 0;
  });
  if (cleanupExit !== 0) return cleanupExit;

  // Spawn npm. On Mac/Linux npm unlinks our binary while we're running;
  // the inode persists until we exit, so this is safe.
  const result = spawnSync("npm", ["uninstall", "-g", "pi-patcher"], {
    stdio: "inherit",
  });
  return result.status ?? 1;
}

// ── Session ──────────────────────────────────────────────────
async function withSession<T>(
  fn: (piRoot: string, state: State) => T | Promise<T>,
): Promise<T> {
  ensureLayout();
  const piRoot = findPiRoot();
  const state = loadState();
  state.piRoot = piRoot;
  state.lastRunAt = new Date().toISOString();
  try {
    return await fn(piRoot, state);
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

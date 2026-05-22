#!/usr/bin/env node
import { findPiRoot } from "./paths.js";
import {
  allPatches,
  loadPatch,
  status,
  apply,
  reverse,
  tombstone,
  type Patch,
} from "./patches.js";
import { heal } from "./heal.js";
import {
  loadState,
  saveState,
  patchEntry,
  errorMessage,
  say,
  type State,
} from "./util.js";

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`pi-patcher: ${errorMessage(error)}`);
  process.exitCode = 1;
}

function main(argv: string[]): number {
  const [cmd = "reconcile", ...args] = argv;

  switch (cmd) {
    case "reconcile":
      return reconcile(args.includes("--after-update"));
    case "heal":
      return healPatch(requireArg(args[0], "heal <id>"));
    case "list":
      return listPatches();
    case "remove":
      tombstone(requireArg(args[0], "remove <id>"));
      return 0;
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

// ── Commands ─────────────────────────────────────────────────

function reconcile(afterUpdate: boolean): number {
  return withSession((ctx) => {
    ctx.state.lastRunAt = new Date().toISOString();
    let failed = 0;
    for (const patch of allPatches()) {
      if (!reconcileEach(patch, ctx)) failed++;
    }
    return failed && !afterUpdate ? 1 : 0;
  });
}

function healPatch(id: string): number {
  return withSession(({ piRoot, state }) =>
    heal(loadPatch(id), piRoot, state) ? 0 : 1,
  );
}

function listPatches(): number {
  return withSession(({ piRoot, state }) => {
    for (const patch of allPatches()) {
      const session = state.patches[patch.id]?.lastSessions?.[0];
      console.log(
        `${patch.id.padEnd(20)} ${status(patch, piRoot)}${session ? `\t${session}` : ""}`,
      );
    }
    return 0;
  });
}

// ── Per-patch reconcile policy ───────────────────────────────

function reconcileEach(patch: Patch, { piRoot, state }: Session): boolean {
  try {
    applyPatch(patch, piRoot, state);
    return true;
  } catch (error) {
    patchEntry(state, patch.id).lastError = errorMessage(error);
    say(`pi-patcher: ${patch.id} failed: ${errorMessage(error)}`);
    return false;
  }
}

function applyPatch(patch: Patch, piRoot: string, state: State): void {
  if (patch.tombstoned) return reverse(patch, piRoot, state);

  switch (status(patch, piRoot)) {
    case "applied":
      delete patchEntry(state, patch.id).lastError;
      return;
    case "pending":
      return apply(patch, piRoot, state);
    case "drift":
      if (heal(patch, piRoot, state)) return;
      throw new Error(patchEntry(state, patch.id).lastError ?? "heal failed");
  }
}

// ── Session plumbing ─────────────────────────────────────────

type Session = { piRoot: string; state: State };

function withSession<T>(fn: (ctx: Session) => T): T {
  const piRoot = findPiRoot();
  const state = loadState();
  state.piRoot = piRoot;
  try {
    return fn({ piRoot, state });
  } finally {
    saveState(state);
  }
}

function requireArg<T>(value: T | undefined, hint: string): T {
  if (value == null) throw new Error(`Usage: pi-patcher ${hint}`);
  return value;
}

#!/usr/bin/env node
import { findPiRoot } from "./paths.js";
import {
  allPatches,
  loadPatch,
  isApplied,
  canApplyCleanly,
  apply,
  reverse,
  status,
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

const [cmd = "reconcile", ...args] = process.argv.slice(2);

try {
  if (cmd === "reconcile") reconcile(args.includes("--after-update"));
  else if (cmd === "heal")
    heal(
      loadPatch(requireArg(args[0], "heal <id>")),
      findPiRoot(),
      loadState(),
    );
  else if (cmd === "list") listAll();
  else if (cmd === "remove") tombstone(requireArg(args[0], "remove <id>"));
  else throw new Error(`Unknown command: ${cmd}`);
} catch (error) {
  console.error(`pi-patcher: ${errorMessage(error)}`);
  process.exit(1);
}

function reconcile(afterUpdate: boolean) {
  const piRoot = findPiRoot();
  const state = loadState();
  state.piRoot = piRoot;
  state.lastRunAt = new Date().toISOString();

  let failed = 0;
  for (const patch of allPatches()) {
    try {
      reconcileEach(patch, piRoot, state);
    } catch (error) {
      failed++;
      patchEntry(state, patch.id).lastError = errorMessage(error);
      say(`pi-patcher: ${patch.id} failed: ${errorMessage(error)}`);
    }
  }

  saveState(state);
  if (failed && !afterUpdate) process.exit(1);
}

function reconcileEach(patch: Patch, piRoot: string, state: State) {
  if (patch.tombstoned) return reverse(patch, piRoot, state);
  if (isApplied(patch, piRoot)) return;
  if (canApplyCleanly(patch, piRoot)) return apply(patch, piRoot, state);
  return heal(patch, piRoot, state);
}

function listAll() {
  const piRoot = findPiRoot();
  const state = loadState();
  for (const patch of allPatches()) {
    const session = state.patches[patch.id]?.lastSessions?.[0];
    console.log(
      `${patch.id.padEnd(20)} ${status(patch, piRoot)}${session ? `\t${session}` : ""}`,
    );
  }
}

function requireArg<T>(value: T | undefined, hint: string): T {
  if (value == null) throw new Error(`Usage: pi-patcher ${hint}`);
  return value;
}

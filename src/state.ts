import fs from "node:fs";
import path from "node:path";
import { STATE } from "./paths.js";

// ── Shape ────────────────────────────────────────────────────
//
// Per-patch state. Field writers (the only mutators outside this file):
//   lastAppliedAt   ← recordApplied        (a clean apply of the spec)
//   lastHealedAt    ← recordHealed         (an LLM-driven re-anchor + apply)
//   lastRevertedAt  ← recordReverted       (tombstone reverse-applied)
//   lastTargetSha   ← recordApplied/Healed/Reverted (sha after the write)
//   lastError       ← recordError; cleared by recordApplied/Healed/Reverted/clearError
//   lastSessions    ← rememberHealSession  (capped at 10, most recent first)
//   removed         ← recordApplied=false, recordReverted=true, recordHealed=false
//
// `state.json` is internal to pi-patcher (~/.pi/pi-patcher/state.json). It is
// not a public API; field shape may evolve. Earlier versions wrote
// `lastAppliedAt` on revert with `removed: true` — that was misleading and
// has been replaced by `lastRevertedAt`.
export type PatchState = {
  lastAppliedAt?: string;
  lastHealedAt?: string;
  lastRevertedAt?: string;
  lastTargetSha?: string;
  lastError?: string;
  lastSessions?: string[];
  removed?: boolean;
};

export type State = {
  piRoot?: string;
  piVersion?: string;
  lastRunAt?: string;
  patches: Record<string, PatchState>;
};

// ── Load / save ──────────────────────────────────────────────
export function loadState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8")) as State;
  } catch {
    return { patches: {} };
  }
}

export function saveState(state: State): void {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
}

// ── Explicit writers (the only mutators outside of this file) ─
export function recordApplied(state: State, id: string, sha: string): void {
  const entry = entryFor(state, id);
  entry.lastAppliedAt = new Date().toISOString();
  entry.lastTargetSha = sha;
  entry.removed = false;
  delete entry.lastError;
}

export function recordReverted(state: State, id: string, sha: string): void {
  const entry = entryFor(state, id);
  entry.lastRevertedAt = new Date().toISOString();
  entry.lastTargetSha = sha;
  entry.removed = true;
  delete entry.lastError;
}

export function recordHealed(state: State, id: string, sha: string): void {
  // Session path is recorded separately via rememberHealSession so failure
  // paths also retain the pointer for `pi --session` inspection.
  const entry = entryFor(state, id);
  entry.lastHealedAt = new Date().toISOString();
  entry.lastTargetSha = sha;
  entry.removed = false;
  delete entry.lastError;
}

export function recordError(state: State, id: string, message: string): void {
  entryFor(state, id).lastError = message;
}

export function rememberHealSession(
  state: State,
  id: string,
  sessionPath: string,
): void {
  rememberSession(entryFor(state, id), sessionPath);
}

export function clearError(state: State, id: string): void {
  delete entryFor(state, id).lastError;
}

export function forgetPatch(state: State, id: string): void {
  delete state.patches[id];
}

// ── Readers ──────────────────────────────────────────────────
export function patchError(state: State, id: string): string | undefined {
  return state.patches[id]?.lastError;
}

export function lastSession(state: State, id: string): string | undefined {
  return state.patches[id]?.lastSessions?.[0];
}

// ── Internal ─────────────────────────────────────────────────
function entryFor(state: State, id: string): PatchState {
  state.patches[id] ??= {};
  return state.patches[id]!;
}

function rememberSession(entry: PatchState, sessionPath: string): void {
  entry.lastSessions = [sessionPath, ...(entry.lastSessions ?? [])].slice(0, 10);
}

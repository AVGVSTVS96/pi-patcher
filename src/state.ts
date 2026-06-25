import fs from "node:fs";
import path from "node:path";
import { STATE } from "./patches.js";

export type PatchState = {
  lastAppliedAt?: string;
  lastHealedAt?: string;
  lastRevertedAt?: string;
  lastError?: string;
  lastSessions?: string[];
};

export type State = {
  piRoot?: string;
  lastRunAt?: string;
  patches: Record<string, PatchState>;
  // Per internal-patch id: the sha of the bundled spec last synced into
  // ~/.pi/pi-patcher/internal-patches/. Lets sync tell "untouched since seed"
  // (refreshable when a fix ships) from "healed locally" (preserve).
  internalBaseShas?: Record<string, string>;
};

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

export function recordApplied(state: State, id: string): void {
  const entry = entryFor(state, id);
  entry.lastAppliedAt = new Date().toISOString();
  delete entry.lastError;
}

export function recordReverted(state: State, id: string): void {
  const entry = entryFor(state, id);
  entry.lastRevertedAt = new Date().toISOString();
  delete entry.lastError;
}

export function recordHealed(state: State, id: string): void {
  const entry = entryFor(state, id);
  entry.lastHealedAt = new Date().toISOString();
  delete entry.lastError;
}

export function recordError(state: State, id: string, message: string): void {
  entryFor(state, id).lastError = message;
}

export function rememberSession(
  state: State,
  id: string,
  sessionId: string,
): void {
  const entry = entryFor(state, id);
  entry.lastSessions = [sessionId, ...(entry.lastSessions ?? [])].slice(0, 10);
}

export function forgetPatch(state: State, id: string): void {
  delete state.patches[id];
}

export function patchError(state: State, id: string): string | undefined {
  return state.patches[id]?.lastError;
}

export function lastSession(state: State, id: string): string | undefined {
  return state.patches[id]?.lastSessions?.[0];
}

function entryFor(state: State, id: string): PatchState {
  state.patches[id] ??= {};
  return state.patches[id]!;
}

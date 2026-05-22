import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { LOGS, STATE } from "./paths.js";

// ── State shape ──────────────────────────────────────────────
export type PatchState = {
  lastAppliedAt?: string;
  lastHealedAt?: string;
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

// ── Logging ──────────────────────────────────────────────────
export function log(message: string): void {
  fs.mkdirSync(LOGS, { recursive: true });
  fs.appendFileSync(
    path.join(LOGS, "reconcile.log"),
    `[${new Date().toISOString()}] ${message}\n`,
  );
}

export function say(message: string): void {
  console.log(message);
  log(message);
}

// ── JSON I/O ─────────────────────────────────────────────────
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// ── State load/save ──────────────────────────────────────────
export function loadState(): State {
  return readJson<State>(STATE, { patches: {} });
}

export function saveState(state: State): void {
  writeJson(STATE, state);
}

export function patchEntry(state: State, id: string): PatchState {
  state.patches[id] ??= {};
  return state.patches[id]!;
}

// ── Small primitives ─────────────────────────────────────────
export function sha(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function count(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0,
    i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++;
    i += Math.max(needle.length, 1);
  }
  return n;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

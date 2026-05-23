import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Locations ────────────────────────────────────────────────
export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const HOME = path.join(os.homedir(), ".pi", "pi-patcher");
export const PATCHES_DIR = path.join(HOME, "patches");
export const LOGS = path.join(HOME, "logs");
export const BACKUPS = path.join(HOME, "backups");
export const HEAL_SESSIONS = path.join(HOME, "heal-sessions");
export const STATE = path.join(HOME, "state.json");
export const PROMPTS_DIR = path.join(ROOT, "prompts");
export const BUNDLED_PATCHES = path.join(ROOT, "patches");

export const HEAL_MODEL =
  process.env.PI_PATCHER_HEAL_MODEL ?? "openai-codex/gpt-5.5:low";

// ── Layout bootstrap ─────────────────────────────────────────
export function ensureLayout(): void {
  for (const dir of [PATCHES_DIR, LOGS, BACKUPS, HEAL_SESSIONS]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(BUNDLED_PATCHES)) return;

  for (const entry of fs.readdirSync(BUNDLED_PATCHES, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const active = path.join(PATCHES_DIR, entry.name);
    const tombstone = path.join(PATCHES_DIR, `_${entry.name}`);
    if (!fs.existsSync(active) && !fs.existsSync(tombstone)) {
      copyDir(path.join(BUNDLED_PATCHES, entry.name), active);
    }
  }
}

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (!fs.existsSync(d)) fs.copyFileSync(s, d);
  }
}

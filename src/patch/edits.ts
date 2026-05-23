import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { BACKUPS } from "../paths.js";
import { piVersion, resolveTarget } from "../pi.js";
import type { Ctx } from "../session.js";
import { type Patch, type Replacement, filesOf } from "./types.js";

// ── Mechanical text application ──────────────────────────────
//
// applyEdits / revertEdits are PURE in the sense that they don't touch state
// or logging. They mutate files on disk, validate with node --check, and
// return the sha of the last successfully-changed file (or null for no-op).
// If any step fails mid-loop, every modified file is restored from its
// in-memory snapshot before the error is rethrown.

export function applyEdits(patch: Patch, ctx: Ctx): string | null {
  return runEdits(patch, ctx, false);
}

export function revertEdits(patch: Patch, ctx: Ctx): string | null {
  return runEdits(patch, ctx, true);
}

function runEdits(patch: Patch, ctx: Ctx, reverse: boolean): string | null {
  const version = piVersion();
  const originals = new Map<string, string>();
  let lastSha: string | null = null;

  try {
    for (const file of filesOf(patch.spec)) {
      const target = resolveTarget(ctx.piRoot, file.target);
      const original = fs.readFileSync(target, "utf8");
      let text = original;
      backupFile(target, version);
      for (const r of file.replacements ?? []) {
        const from = reverse ? r.newText : r.oldText;
        const to = reverse ? r.oldText : r.newText;
        if (count(text, from) !== 1) continue;
        text = text.replace(from, to);
      }
      if (text === original) continue;
      if (!originals.has(target)) originals.set(target, original);
      fs.writeFileSync(target, text);
      nodeCheck(target);
      lastSha = sha(text);
    }
  } catch (error) {
    for (const [target, original] of originals)
      fs.writeFileSync(target, original);
    throw error;
  }

  return lastSha;
}

// ── Filesystem helpers (used by operations.heal too) ─────────
export function backupFile(target: string, version: string): string {
  const safe = target.replaceAll(path.sep, "__");
  const dst = path.join(
    BACKUPS,
    version.replace(/[^a-zA-Z0-9._-]/g, "_"),
    safe,
  );
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (!fs.existsSync(dst)) fs.copyFileSync(target, dst);
  return dst;
}

export function nodeCheck(target: string): void {
  execFileSync(process.execPath, ["--check", target], { stdio: "pipe" });
}

// ── Text primitives ──────────────────────────────────────────
export function count(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++;
    i += Math.max(needle.length, 1);
  }
  return n;
}

export function sha(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// ── Derive a minimal unique replacement from a heal edit ─────
export function derivePatch(
  before: string,
  after: string,
): Replacement | null {
  if (before === after) return null;

  // Common prefix / suffix
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++;
  let endBefore = before.length - 1;
  let endAfter = after.length - 1;
  while (
    endBefore >= start &&
    endAfter >= start &&
    before[endBefore] === after[endAfter]
  ) {
    endBefore--;
    endAfter--;
  }

  // Expand each side to nearest newlines
  let a = start;
  while (a > 0 && before[a - 1] !== "\n") a--;
  let b = endBefore + 1;
  while (b < before.length && before[b] !== "\n") b++;
  if (b < before.length) b++;
  let c = start;
  while (c > 0 && after[c - 1] !== "\n") c--;
  let d = endAfter + 1;
  while (d < after.length && after[d] !== "\n") d++;
  if (d < after.length) d++;

  let oldText = before.slice(a, b);
  let newText = after.slice(c, d);

  // Grow window until both sides are uniquely locatable
  while (
    (count(before, oldText) !== 1 || count(after, newText) !== 1) &&
    (a > 0 || b < before.length || c > 0 || d < after.length)
  ) {
    if (a > 0) {
      a--;
      while (a > 0 && before[a - 1] !== "\n") a--;
    }
    if (c > 0) {
      c--;
      while (c > 0 && after[c - 1] !== "\n") c--;
    }
    if (b < before.length) {
      while (b < before.length && before[b] !== "\n") b++;
      if (b < before.length) b++;
    }
    if (d < after.length) {
      while (d < after.length && after[d] !== "\n") d++;
      if (d < after.length) d++;
    }
    oldText = before.slice(a, b);
    newText = after.slice(c, d);
  }

  return { oldText, newText };
}

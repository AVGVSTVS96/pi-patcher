import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  BACKUPS,
  PATCHES_DIR,
  ensureLayout,
  piVersion,
  resolveTarget,
} from "./paths.js";
import { count, patchEntry, readJson, sha, say, type State } from "./util.js";

// ── Patch types ──────────────────────────────────────────────
export type Replacement = { oldText: string; newText: string };
export type FileEntry = { target: string; replacements: Replacement[] };
export type PatchSpec = {
  files?: FileEntry[];
  target?: string;
  replacements?: Replacement[];
};
export type Patch = {
  id: string;
  dir: string;
  tombstoned: boolean;
  intent: string;
  spec: PatchSpec;
};

export type Status = "applied" | "pending" | "drift" | "tombstoned";

// ── Loading ──────────────────────────────────────────────────
export function allPatches(): Patch[] {
  ensureLayout();
  return fs
    .readdirSync(PATCHES_DIR, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        fs.existsSync(path.join(PATCHES_DIR, e.name, "spec.json")),
    )
    .map((e) => loadPatchFromDir(path.join(PATCHES_DIR, e.name)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function loadPatch(id: string): Patch {
  ensureLayout();
  const active = path.join(PATCHES_DIR, id);
  const tombstone = path.join(PATCHES_DIR, `_${id}`);
  const dir = fs.existsSync(active)
    ? active
    : fs.existsSync(tombstone)
      ? tombstone
      : null;
  if (!dir) throw new Error(`No patch named ${id}`);
  return loadPatchFromDir(dir);
}

function loadPatchFromDir(dir: string): Patch {
  const base = path.basename(dir);
  return {
    id: base.replace(/^_/, ""),
    dir,
    tombstoned: base.startsWith("_"),
    intent: fs.existsSync(path.join(dir, "intent.md"))
      ? fs.readFileSync(path.join(dir, "intent.md"), "utf8")
      : "",
    spec: readJson<PatchSpec>(path.join(dir, "spec.json"), { files: [] }),
  };
}

export function filesOf(spec: PatchSpec): FileEntry[] {
  if (Array.isArray(spec.files)) return spec.files;
  if (spec.target && Array.isArray(spec.replacements))
    return [{ target: spec.target, replacements: spec.replacements }];
  return [];
}

// ── Status queries ───────────────────────────────────────────
export function status(patch: Patch, piRoot: string): Status {
  if (patch.tombstoned) return "tombstoned";
  return computeStatus(patch, piRoot);
}

export const isApplied = (patch: Patch, piRoot: string) =>
  computeStatus(patch, piRoot) === "applied";
export const canApplyCleanly = (patch: Patch, piRoot: string) =>
  computeStatus(patch, piRoot) === "pending";

function computeStatus(
  patch: Patch,
  piRoot: string,
): Exclude<Status, "tombstoned"> {
  const seen = new Set<Exclude<Status, "tombstoned">>();
  for (const file of filesOf(patch.spec)) {
    const target = resolveTarget(piRoot, file.target);
    if (!fs.existsSync(target)) {
      seen.add("drift");
      continue;
    }
    const text = fs.readFileSync(target, "utf8");
    for (const r of file.replacements ?? []) seen.add(classifyOne(r, text));
  }
  if (seen.has("drift")) return "drift";
  if (seen.has("pending")) return "pending";
  return "applied";
}

function classifyOne(
  r: Replacement,
  text: string,
): Exclude<Status, "tombstoned"> {
  const newCount = count(text, r.newText);
  if (newCount === 1) return "applied";
  if (newCount > 1) return "drift";
  const oldCount = count(text, r.oldText);
  if (oldCount === 1) return "pending";
  return "drift";
}

// ── Apply / reverse / tombstone ──────────────────────────────
export function apply(patch: Patch, piRoot: string, state: State): void {
  if (mutate(patch, piRoot, state, false))
    say(`pi-patcher: applied ${patch.id}`);
}

export function reverse(patch: Patch, piRoot: string, state: State): void {
  if (mutate(patch, piRoot, state, true))
    say(`pi-patcher: reversed ${patch.id}`);
}

export function tombstone(id: string): void {
  if (!id) throw new Error("Usage: pi-patcher remove <patch-id>");
  ensureLayout();
  const src = path.join(PATCHES_DIR, id);
  const dst = path.join(PATCHES_DIR, `_${id}`);
  if (!fs.existsSync(src)) throw new Error(`No active patch named ${id}`);
  fs.renameSync(src, dst);
  console.log(`Tombstoned ${id}. It will be reversed on next reconcile.`);
}

function mutate(
  patch: Patch,
  piRoot: string,
  state: State,
  reverse: boolean,
): boolean {
  const version = piVersion();
  let changed = false;
  for (const file of filesOf(patch.spec)) {
    const target = resolveTarget(piRoot, file.target);
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
    fs.writeFileSync(target, text);
    nodeCheck(target);
    changed = true;
    const entry = patchEntry(state, patch.id);
    entry.lastAppliedAt = new Date().toISOString();
    entry.lastTargetSha = sha(text);
    entry.removed = reverse;
  }
  return changed;
}

// ── Filesystem helpers (exported for heal.ts) ────────────────
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

// ── Derive a minimal-unique replacement from a heal edit ─────
export function deriveSingleReplacement(
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

  // Grow window until both are uniquely locatable
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

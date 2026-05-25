import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ── Locations ────────────────────────────────────────────────
export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const PATCHES_DIR = path.join(os.homedir(), ".pi", "patches");
const HOME = path.join(os.homedir(), ".pi", "pi-patcher");
export const BACKUPS = path.join(HOME, "backups");
export const HEAL_SESSIONS = path.join(HOME, "heal-sessions");
export const STATE = path.join(HOME, "state.json");
export const PROMPTS_DIR = path.join(ROOT, "prompts");
const BUNDLED_PATCHES = path.join(ROOT, "patches");

export const HEAL_MODEL =
  process.env.PI_PATCHER_HEAL_MODEL ?? "openai-codex/gpt-5.5:low";

// ── Types ────────────────────────────────────────────────────
export type Replacement = {
  oldText: string;
  newText: string;
  anchorHint?: string;
};

export type FileEntry = { target: string; replacements: Replacement[] };

export type PatchSpec = { version?: number; files: FileEntry[] };

export type Patch = {
  id: string;
  dir: string;
  intent: string;
  spec: PatchSpec;
};

export type Status = "applied" | "pending" | "drift";

// ── Layout / discovery ───────────────────────────────────────
/**
 * Create the runtime directories pi-patcher needs (`~/.pi/patches/` for
 * user-authored patches, `~/.pi/pi-patcher/` for state, backups, and heal
 * sessions). This does NOT install bundled patches — that's an explicit
 * opt-in via `pi-patcher init`, so plain `npm install -g pi-patcher`
 * never silently mutates the user's pi install.
 */
export function ensureLayout(): void {
  for (const dir of [PATCHES_DIR, BACKUPS, HEAL_SESSIONS])
    fs.mkdirSync(dir, { recursive: true });
}

/**
 * Copy any bundled patches into `~/.pi/patches/`. Idempotent: existing
 * patches (and their `_<id>/` tombstones) are left alone, so re-running
 * `init` after an upgrade picks up newly-bundled patches without
 * clobbering user state. Called only by `pi-patcher init`.
 */
export function installBundledPatches(): void {
  ensureLayout();
  if (!fs.existsSync(BUNDLED_PATCHES)) return;
  for (const entry of fs.readdirSync(BUNDLED_PATCHES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const active = path.join(PATCHES_DIR, entry.name);
    const skipped = path.join(PATCHES_DIR, `_${entry.name}`);
    if (!fs.existsSync(active) && !fs.existsSync(skipped))
      copyDir(path.join(BUNDLED_PATCHES, entry.name), active);
  }
}

export function findPiRoot(): string {
  let piBin: string;
  try {
    piBin = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("Could not find `pi` on PATH");
  }
  let current = fs.realpathSync(piBin);
  if (fs.statSync(current).isFile()) current = path.dirname(current);
  while (current !== path.dirname(current)) {
    const pkg = path.join(current, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const json = JSON.parse(fs.readFileSync(pkg, "utf8")) as {
          name?: string;
        };
        if (json.name === "@earendil-works/pi-coding-agent") return current;
      } catch {
        /* keep walking */
      }
    }
    current = path.dirname(current);
  }
  throw new Error("Could not resolve pi package root from `pi` on PATH");
}

export function piVersion(): string {
  const result = spawnSync("pi", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return (result.stdout || result.stderr || "unknown").trim() || "unknown";
}

export function resolveTarget(piRoot: string, target: string): string {
  return path.isAbsolute(target) ? target : path.join(piRoot, target);
}

// ── Loading ──────────────────────────────────────────────────
//
// Patch directories starting with `_` are skipped (manual tombstone escape
// hatch — `mv id _id` if you want pi-patcher to ignore a patch without
// actually removing it). `pi-patcher remove` is the supported verb.

export function allPatches(): Patch[] {
  ensureLayout();
  return fs
    .readdirSync(PATCHES_DIR, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        !e.name.startsWith("_") &&
        fs.existsSync(path.join(PATCHES_DIR, e.name, "spec.json")),
    )
    .map((e) => loadFromDir(path.join(PATCHES_DIR, e.name)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function loadPatch(id: string): Patch {
  ensureLayout();
  const dir = path.join(PATCHES_DIR, id);
  if (!fs.existsSync(dir)) throw new Error(`No patch named ${id}`);
  return loadFromDir(dir);
}

export function saveSpec(patch: Patch, spec: PatchSpec): void {
  fs.writeFileSync(
    path.join(patch.dir, "spec.json"),
    `${JSON.stringify(spec, null, 2)}\n`,
  );
  patch.spec = spec;
}

export function removePatchDir(id: string): void {
  fs.rmSync(path.join(PATCHES_DIR, id), { recursive: true, force: true });
}

function loadFromDir(dir: string): Patch {
  const id = path.basename(dir);
  const specPath = path.join(dir, "spec.json");
  const intentPath = path.join(dir, "intent.md");
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as PatchSpec;
  validateSpec(id, spec);
  return {
    id,
    dir,
    intent: fs.existsSync(intentPath)
      ? fs.readFileSync(intentPath, "utf8")
      : "",
    spec,
  };
}

function validateSpec(id: string, spec: PatchSpec): void {
  if (!Array.isArray(spec.files) || spec.files.length === 0)
    throw new Error(`${id}: spec.json must have a non-empty "files" array`);
  for (const file of spec.files) {
    if (!file.target || !Array.isArray(file.replacements))
      throw new Error(`${id}: each file needs a target and replacements`);
    for (const r of file.replacements) {
      if (typeof r.oldText !== "string" || typeof r.newText !== "string")
        throw new Error(`${id}: replacements need oldText and newText strings`);
      if (r.oldText === "")
        throw new Error(`${id}: empty oldText is not supported`);
      if (r.newText === "")
        throw new Error(
          `${id}: empty newText (deletion patches) is not supported. ` +
            `Replace the line with a comment or no-op instead.`,
        );
    }
  }
}

// ── Status ───────────────────────────────────────────────────
export function statusOf(patch: Patch, piRoot: string): Status {
  const seen = new Set<Status>();
  for (const file of patch.spec.files) {
    const target = resolveTarget(piRoot, file.target);
    if (!fs.existsSync(target)) {
      seen.add("drift");
      continue;
    }
    const text = fs.readFileSync(target, "utf8");
    for (const r of file.replacements) seen.add(classify(r, text));
  }
  if (seen.has("drift")) return "drift";
  if (seen.has("pending")) return "pending";
  return "applied";
}

export function classify(r: Replacement, text: string): Status {
  const newCount = count(text, r.newText);
  if (newCount === 1) return "applied";
  if (newCount > 1) return "drift";
  return count(text, r.oldText) === 1 ? "pending" : "drift";
}

// ── Mechanical apply / revert ────────────────────────────────
//
// Both run all replacements as a transaction. If any file fails
// `node --check`, every file modified in this call is rolled back.
// Returns the sha of the last successfully changed file, or null if
// nothing changed.

export function applyEdits(patch: Patch, piRoot: string): string | null {
  return runEdits(patch, piRoot, false);
}

export function revertEdits(patch: Patch, piRoot: string): string | null {
  return runEdits(patch, piRoot, true);
}

function runEdits(
  patch: Patch,
  piRoot: string,
  reverse: boolean,
): string | null {
  const version = piVersion();
  const originals = new Map<string, string>();
  let lastSha: string | null = null;
  try {
    for (const file of patch.spec.files) {
      const target = resolveTarget(piRoot, file.target);
      const original = fs.readFileSync(target, "utf8");
      let text = original;
      backupFile(target, version);
      for (const r of file.replacements) {
        const from = reverse ? r.newText : r.oldText;
        const to = reverse ? r.oldText : r.newText;
        if (count(text, from) !== 1) continue;
        text = text.replace(from, to);
      }
      if (text === original) continue;
      if (!originals.has(target)) originals.set(target, original);
      fs.writeFileSync(target, text);
      validateTarget(target);
      lastSha = sha(text);
    }
  } catch (error) {
    for (const [target, original] of originals)
      fs.writeFileSync(target, original);
    throw error;
  }
  return lastSha;
}

// ── Primitives ───────────────────────────────────────────────
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

/**
 * Validate the target file after an edit, choosing the validator by file
 * extension. Throws on failure. For unknown extensions there's no automatic
 * validator — the patch either applied (string replace succeeded) or it
 * didn't. This is what lets pi-patcher edit markdown prompts, plain text,
 * etc., not just compiled JS.
 */
export function validateTarget(target: string): void {
  const ext = path.extname(target).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    execFileSync(process.execPath, ["--check", target], { stdio: "pipe" });
    return;
  }
  if (ext === ".json") {
    JSON.parse(fs.readFileSync(target, "utf8"));
  }
}

export function count(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

export function sha(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// ── Derive a minimal unique replacement from a heal edit ─────
//
// Used by heal() after the AI rewrites the file: snap the diff out to the
// nearest line boundaries on both sides, then grow the window until each
// side is uniquely locatable in its respective text. The result becomes the
// patch's new oldText/newText.

export function derivePatch(
  before: string,
  after: string,
): Replacement | null {
  if (before === after) return null;

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

// ── Internal ─────────────────────────────────────────────────
function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (!fs.existsSync(d)) fs.copyFileSync(s, d);
  }
}

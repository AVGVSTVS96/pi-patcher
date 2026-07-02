import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ── Locations ────────────────────────────────────────────────
export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const PATCHES_DIR = path.join(os.homedir(), ".pi", "patches");
const HOME = path.join(os.homedir(), ".pi", "pi-patcher");
export const STATE = path.join(HOME, "state.json");
// pi-patcher's own bundled patches (currently just bootstrap-hook) live here,
// kept separate from `~/.pi/patches/` which is reserved for user patches.
export const INTERNAL_PATCHES_DIR = path.join(HOME, "internal-patches");
export const PROMPTS_DIR = path.join(ROOT, "prompts");
// The package's shipped patches. Overridable for tests so they can point sync
// at a fixture bundled dir with a controllable spec (cf. PI_PATCHER_HEAL_MODEL).
const BUNDLED_PATCHES =
  process.env.PI_PATCHER_BUNDLED_DIR ?? path.join(ROOT, "patches");

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
  source: "markdown" | "json";
};

export type Status = "applied" | "pending" | "drift";

// ── Layout / discovery ───────────────────────────────────────
/**
 * Create the runtime directories pi-patcher needs (`~/.pi/patches/` for
 * user-authored patches and `~/.pi/pi-patcher/internal-patches/` for bundled patches).
 * This does NOT install bundled patches, since that is an explicit opt-in via
 * `pi-patcher init`, so plain `npm install -g pi-patcher` never silently
 * mutates the user's pi install.
 */
export function ensureLayout(): void {
  for (const dir of [PATCHES_DIR, INTERNAL_PATCHES_DIR])
    fs.mkdirSync(dir, { recursive: true });
}

// ── Internal (bundled) patch sync ────────────────────────────
export type SyncMode = "seed" | "refresh-only";
export type SyncEvent = { id: string; action: "seeded" | "refreshed" };

/**
 * Seed/refresh pi-patcher's own bundled patches into
 * `~/.pi/pi-patcher/internal-patches/`, leaving `~/.pi/patches/` (user patches)
 * untouched. Per id, comparing the working spec sha to the recorded baseSha:
 *   - absent           → seed from bundled (only in "seed" mode)
 *   - untouched, stale → overwrite from bundled, so a shipped fix lands
 *   - healed locally   → leave (working sha ≠ baseSha)
 *   - already current  → leave (bundled sha === baseSha)
 *
 * "refresh-only" never seeds from absent, keeping the opt-in invariant: a bare
 * `reconcile` without a prior `init` stays a no-op. The baseSha map is mutated
 * in place (so this module needn't import State); returns events to log.
 */
export function syncInternalPatches(
  baseShas: Record<string, string>,
  mode: SyncMode,
): SyncEvent[] {
  ensureLayout();
  const events: SyncEvent[] = [];
  if (!fs.existsSync(BUNDLED_PATCHES)) return events;
  for (const entry of fs.readdirSync(BUNDLED_PATCHES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const bundledDir = path.join(BUNDLED_PATCHES, id);
    const bundledFile = patchDefinitionPath(bundledDir);
    if (!bundledFile) continue;
    const bundledSha = sha(fs.readFileSync(bundledFile, "utf8"));
    const workingDir = path.join(INTERNAL_PATCHES_DIR, id);
    const workingFile = patchDefinitionPath(workingDir);

    if (!workingFile) {
      if (mode !== "seed") continue; // refresh-only never seeds from absent
      replaceDir(bundledDir, workingDir);
      baseShas[id] = bundledSha;
      events.push({ id, action: "seeded" });
      continue;
    }

    const workingSha = sha(fs.readFileSync(workingFile, "utf8"));
    const baseSha = baseShas[id];
    if (workingSha === baseSha && bundledSha !== baseSha) {
      replaceDir(bundledDir, workingDir); // untouched-since-seed AND newer bundled
      baseShas[id] = bundledSha;
      events.push({ id, action: "refreshed" });
    } else if (baseSha === undefined) {
      // Pre-existing copy we never recorded (e.g. upgrade from before this
      // feature): treat as healed/custom and preserve, don't clobber.
      baseShas[id] = workingSha;
    }
    // else: healed locally OR already current → leave untouched
  }
  return events;
}

/** True if `id` is one of pi-patcher's own bundled patches (managed, not user). */
export function isInternalPatch(id: string): boolean {
  return patchDefinitionPath(path.join(INTERNAL_PATCHES_DIR, id)) !== undefined;
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

export function resolveTarget(piRoot: string, target: string): string {
  return path.isAbsolute(target) ? target : path.join(piRoot, target);
}

// ── Loading ──────────────────────────────────────────────────
//
// Patch directories starting with `_` are skipped (manual tombstone escape
// hatch: `mv id _id` if you want pi-patcher to ignore a patch without
// actually removing it). `pi-patcher remove` is the supported verb.

export function allPatches(): Patch[] {
  ensureLayout();
  const internal = discoverPatchesIn(INTERNAL_PATCHES_DIR);
  const user = discoverPatchesIn(PATCHES_DIR);
  // Internal (managed) patches win on id collision; the user dir is otherwise
  // discovered and reconciled exactly as before.
  const seen = new Set(internal.map((p) => p.id));
  return [...internal, ...user.filter((p) => !seen.has(p.id))].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
}

function discoverPatchesIn(dir: string): Patch[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        !e.name.startsWith("_") &&
        patchDefinitionPath(path.join(dir, e.name)) !== undefined,
    )
    .map((e) => loadFromDir(path.join(dir, e.name)));
}

export function loadPatch(id: string): Patch {
  ensureLayout();
  for (const base of [INTERNAL_PATCHES_DIR, PATCHES_DIR]) {
    const dir = path.join(base, id);
    if (patchDefinitionPath(dir)) return loadFromDir(dir);
  }
  throw new Error(`No patch named ${id}`);
}

export function removePatchDir(id: string): void {
  fs.rmSync(path.join(PATCHES_DIR, id), { recursive: true, force: true });
}

function loadFromDir(dir: string): Patch {
  const id = path.basename(dir);
  const patchMd = path.join(dir, "PATCH.md");
  if (fs.existsSync(patchMd)) {
    const patch = parsePatchMd(dir, fs.readFileSync(patchMd, "utf8"));
    validateSpec(patch.id, patch.spec);
    return patch;
  }

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
    source: "json",
  };
}

function patchDefinitionPath(dir: string): string | undefined {
  const patchMd = path.join(dir, "PATCH.md");
  if (fs.existsSync(patchMd)) return patchMd;
  const specJson = path.join(dir, "spec.json");
  return fs.existsSync(specJson) ? specJson : undefined;
}

function parsePatchMd(dir: string, markdown: string): Patch {
  const fallbackId = path.basename(dir);
  const { attrs, body } = parseFrontmatter(markdown);
  const id = stringAttr(attrs.id) ?? fallbackId;
  if (id !== fallbackId)
    throw new Error(`${fallbackId}: PATCH.md id must match its directory name`);
  return {
    id,
    dir,
    // PATCH.md prose is agent-facing and intentionally free-form. Mechanical
    // code only reads frontmatter and fenced edit blocks.
    intent: markdown.trim(),
    spec: { version: 1, files: parseMarkdownEdits(id, body) },
    source: "markdown",
  };
}

function parseFrontmatter(markdown: string): {
  attrs: Record<string, string>;
  body: string;
} {
  if (!markdown.startsWith("---\n")) return { attrs: {}, body: markdown };
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) return { attrs: {}, body: markdown };
  const raw = markdown.slice(4, end).trim();
  const attrs: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) attrs[match[1]!] = match[2]!.replace(/^['"]|['"]$/g, "");
  }
  let bodyOffset = end + 5;
  if (markdown.slice(bodyOffset).startsWith("\n")) bodyOffset++;
  return { attrs, body: markdown.slice(bodyOffset) };
}

function stringAttr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseMarkdownEdits(id: string, body: string): FileEntry[] {
  const byTarget = new Map<string, Replacement[]>();
  const targetOrder: string[] = [];

  for (const fence of markdownFences(body)) {
    const target = targetFromFenceInfo(fence.info);
    if (!target) continue; // prose/example fence, not a mechanical edit

    const replacement =
      parseSearchReplaceBlock(fence.content) ?? parseDiffBlock(fence.content);
    if (!replacement)
      throw new Error(
        `${id}: ${target}: fence is neither a search/replace nor a hunk block`,
      );

    const anchorHint = noteBefore(body.slice(0, fence.start));
    if (anchorHint) replacement.anchorHint = anchorHint;
    if (!byTarget.has(target)) targetOrder.push(target);
    const replacements = byTarget.get(target) ?? [];
    replacements.push(replacement);
    byTarget.set(target, replacements);
  }

  return targetOrder.map((target) => ({
    target,
    replacements: byTarget.get(target) ?? [],
  }));
}

function markdownFences(markdown: string): Array<{
  start: number;
  end: number;
  info: string;
  content: string;
}> {
  const fences: Array<{
    start: number;
    end: number;
    info: string;
    content: string;
  }> = [];
  let pos = 0;

  while (pos < markdown.length) {
    const lineStart = pos;
    const lineEnd = markdown.indexOf("\n", lineStart);
    const lineStop = lineEnd === -1 ? markdown.length : lineEnd;
    const line = markdown.slice(lineStart, lineStop);
    const open = line.match(/^\s{0,3}(`{3,})(.*)$/);
    pos = lineEnd === -1 ? markdown.length : lineEnd + 1;
    if (!open) continue;

    const tickCount = open[1]!.length;
    const info = open[2]!.trim();
    const contentStart = pos;
    let closeStart = -1;
    let closeEnd = -1;

    while (pos < markdown.length) {
      const candidateStart = pos;
      const candidateLineEnd = markdown.indexOf("\n", candidateStart);
      const candidateStop =
        candidateLineEnd === -1 ? markdown.length : candidateLineEnd;
      const candidate = markdown.slice(candidateStart, candidateStop);
      pos = candidateLineEnd === -1 ? markdown.length : candidateLineEnd + 1;
      if (new RegExp(`^\\s{0,3}\`{${tickCount},}\\s*$`).test(candidate)) {
        closeStart = candidateStart;
        closeEnd = candidateStop;
        break;
      }
    }

    if (closeStart === -1) break;
    let content = markdown.slice(contentStart, closeStart);
    if (content.endsWith("\n")) content = content.slice(0, -1);
    fences.push({ start: lineStart, end: closeEnd, info, content });
  }

  return fences;
}

function targetFromFenceInfo(info: string): string | undefined {
  const match = info.match(/(?:^|\s)file=("[^"]+"|'[^']+'|\S+)/);
  if (!match) return undefined;
  return match[1]!.replace(/^['"]|['"]$/g, "").trim() || undefined;
}

function noteBefore(prefix: string): string | undefined {
  return prefix.match(/(?:^|\n)>\s*note:\s*([^\n]+)\n\s*$/i)?.[1]?.trim();
}

function parseSearchReplaceBlock(block: string): Replacement | null {
  const match = block.match(
    /^<<<<<<< SEARCH\r?\n([\s\S]*?)^=======\r?\n([\s\S]*?)^>>>>>>> REPLACE\s*$/m,
  );
  return match ? { oldText: match[1]!, newText: match[2]! } : null;
}

function parseDiffBlock(block: string): Replacement | null {
  const lines = block.split(/\r?\n/);

  const oldLines: string[] = [];
  const newLines: string[] = [];
  let changed = false;
  for (const line of lines) {
    if (/^@@.*@@$/.test(line)) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      newLines.push(line.slice(1));
      changed = true;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      oldLines.push(line.slice(1));
      changed = true;
    } else {
      oldLines.push(line);
      newLines.push(line);
    }
  }

  if (!changed) return null;
  const oldText = oldLines.length ? `${oldLines.join("\n")}\n` : "";
  const newText = newLines.length ? `${newLines.join("\n")}\n` : "";
  return { oldText, newText };
}

function validateSpec(id: string, spec: PatchSpec): void {
  if (!Array.isArray(spec.files) || spec.files.length === 0)
    throw new Error(`${id}: patch must define at least one edit`);
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
// Both run all replacements as a transaction. If any replacement can't be
// anchored, or any file fails `node --check`, every file modified in this
// call is rolled back from an in-memory snapshot. Returns true if any file
// changed, false if nothing needed doing.

export function applyEdits(patch: Patch, piRoot: string): boolean {
  return runEdits(patch, piRoot, false);
}

export function revertEdits(patch: Patch, piRoot: string): boolean {
  return runEdits(patch, piRoot, true);
}

function runEdits(patch: Patch, piRoot: string, reverse: boolean): boolean {
  const originals = new Map<string, string>();
  let changed = false;
  try {
    for (const file of patch.spec.files) {
      const target = resolveTarget(piRoot, file.target);
      const original = fs.readFileSync(target, "utf8");
      let text = original;
      for (const r of file.replacements) {
        // Idempotent + strict. `classify` checks newText first, so it stays
        // correct even when newText contains oldText (e.g. an insert-after
        // patch). Skip a replacement already in its desired state, apply one
        // that's uniquely anchored, otherwise fail loudly rather than
        // silently dropping it (no partial applies).
        const status = classify(r, text);
        const done = reverse ? "pending" : "applied";
        const ready = reverse ? "applied" : "pending";
        if (status === done) continue;
        if (status === ready) {
          text = reverse
            ? text.replace(r.newText, r.oldText)
            : text.replace(r.oldText, r.newText);
          continue;
        }
        throw new Error(
          `${patch.id}: ${file.target}: cannot ${
            reverse ? "revert" : "apply"
          } a replacement (expected exactly one occurrence of ${
            reverse ? "newText" : "oldText"
          })`,
        );
      }
      if (text === original) continue;
      if (!originals.has(target)) originals.set(target, original);
      fs.writeFileSync(target, text);
      validateTarget(target);
      changed = true;
    }
  } catch (error) {
    for (const [target, original] of originals)
      fs.writeFileSync(target, original);
    throw error;
  }
  return changed;
}

// ── Primitives ───────────────────────────────────────────────
/**
 * Validate the target file after an edit, choosing the validator by file
 * extension. Throws on failure. For unknown extensions there's no automatic
 * validator. The patch either applied (string replace succeeded) or it
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

// ── Internal ─────────────────────────────────────────────────
function replaceDir(src: string, dst: string): void {
  fs.rmSync(dst, { recursive: true, force: true });
  copyDir(src, dst, true);
}

function copyDir(src: string, dst: string, overwrite = false): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d, overwrite);
    else if (overwrite || !fs.existsSync(d)) fs.copyFileSync(s, d);
  }
}

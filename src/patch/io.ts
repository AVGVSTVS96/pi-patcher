import fs from "node:fs";
import path from "node:path";
import { PATCHES_DIR, ensureLayout } from "../paths.js";
import type { Patch, PatchSpec } from "./types.js";

export function allPatches(): Patch[] {
  ensureLayout();
  return fs
    .readdirSync(PATCHES_DIR, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        fs.existsSync(path.join(PATCHES_DIR, e.name, "spec.json")),
    )
    .map((e) => loadFromDir(path.join(PATCHES_DIR, e.name)))
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
  return loadFromDir(dir);
}

export function saveSpec(patch: Patch, spec: PatchSpec): void {
  fs.writeFileSync(
    path.join(patch.dir, "spec.json"),
    `${JSON.stringify(spec, null, 2)}\n`,
  );
  patch.spec = spec;
}

export function markTombstoned(id: string): void {
  if (!id) throw new Error("Usage: pi-patcher remove <patch-id>");
  ensureLayout();
  const src = path.join(PATCHES_DIR, id);
  const dst = path.join(PATCHES_DIR, `_${id}`);
  if (!fs.existsSync(src)) throw new Error(`No active patch named ${id}`);
  fs.renameSync(src, dst);
  console.log(`Tombstoned ${id}. It will be reversed on next reconcile.`);
}

// ── Internal ─────────────────────────────────────────────────
function loadFromDir(dir: string): Patch {
  const base = path.basename(dir);
  const specPath = path.join(dir, "spec.json");
  const intentPath = path.join(dir, "intent.md");
  let spec: PatchSpec = { files: [] };
  try {
    spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as PatchSpec;
  } catch {
    /* fall through with empty spec */
  }
  return {
    id: base.replace(/^_/, ""),
    dir,
    tombstoned: base.startsWith("_"),
    intent: fs.existsSync(intentPath)
      ? fs.readFileSync(intentPath, "utf8")
      : "",
    spec,
  };
}

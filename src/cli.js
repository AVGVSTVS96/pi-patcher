#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = path.join(os.homedir(), ".pi", "pi-patcher");
const PATCHES = path.join(HOME, "patches");
const LOGS = path.join(HOME, "logs");
const BACKUPS = path.join(HOME, "backups");
const HEAL_SESSIONS = path.join(HOME, "heal-sessions");
const STATE = path.join(HOME, "state.json");
const HEAL_MODEL = "openai-codex/gpt-5.5:low";

function log(message) {
  fs.mkdirSync(LOGS, { recursive: true });
  fs.appendFileSync(path.join(LOGS, "reconcile.log"), `[${new Date().toISOString()}] ${message}\n`);
}

function say(message) {
  console.log(message);
  log(message);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function count(haystack, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += Math.max(needle.length, 1); }
  return n;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (!fs.existsSync(d)) fs.copyFileSync(s, d);
  }
}

function ensureLayout() {
  for (const dir of [PATCHES, LOGS, BACKUPS, HEAL_SESSIONS]) fs.mkdirSync(dir, { recursive: true });
  const bundled = path.join(ROOT, "patches");
  if (!fs.existsSync(bundled)) return;
  for (const entry of fs.readdirSync(bundled, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const active = path.join(PATCHES, entry.name);
    const tombstone = path.join(PATCHES, `_${entry.name}`);
    if (!fs.existsSync(active) && !fs.existsSync(tombstone)) copyDir(path.join(bundled, entry.name), active);
  }
}

function findPiRoot() {
  let piBin;
  try { piBin = execFileSync("which", ["pi"], { encoding: "utf8" }).trim(); }
  catch { throw new Error("Could not find `pi` on PATH"); }
  let current = fs.realpathSync(piBin);
  if (fs.statSync(current).isFile()) current = path.dirname(current);
  while (current !== path.dirname(current)) {
    const pkg = path.join(current, "package.json");
    if (fs.existsSync(pkg)) {
      const json = readJson(pkg, {});
      if (json.name === "@earendil-works/pi-coding-agent") return current;
    }
    current = path.dirname(current);
  }
  throw new Error("Could not resolve @earendil-works/pi-coding-agent package root from `pi`");
}

function piVersion() {
  try {
    const result = spawnSync("pi", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return (result.stdout || result.stderr || "unknown").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function resolveTarget(piRoot, target) {
  if (path.isAbsolute(target)) return target;
  return path.join(piRoot, target);
}

function loadPatch(dir) {
  return {
    id: path.basename(dir).replace(/^_/, ""),
    dir,
    tombstoned: path.basename(dir).startsWith("_"),
    intent: fs.existsSync(path.join(dir, "intent.md")) ? fs.readFileSync(path.join(dir, "intent.md"), "utf8") : "",
    spec: readJson(path.join(dir, "spec.json"), null),
  };
}

function listPatchDirs() {
  ensureLayout();
  return fs.readdirSync(PATCHES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(PATCHES, e.name, "spec.json")))
    .map((e) => path.join(PATCHES, e.name))
    .sort();
}

function filesOf(spec) {
  if (Array.isArray(spec.files)) return spec.files;
  if (spec.target && Array.isArray(spec.replacements)) return [{ target: spec.target, replacements: spec.replacements }];
  return [];
}

function classifyFile(file, text) {
  const results = [];
  for (const r of file.replacements ?? []) {
    const oldCount = count(text, r.oldText);
    const newCount = count(text, r.newText);
    if (newCount === 1) results.push({ state: "applied", replacement: r });
    else if (newCount > 1) results.push({ state: "drift", reason: "newText matched multiple times", replacement: r });
    else if (oldCount === 1) results.push({ state: "pending", replacement: r });
    else if (oldCount > 1) results.push({ state: "drift", reason: "oldText matched multiple times", replacement: r });
    else results.push({ state: "drift", reason: "neither oldText nor newText matched", replacement: r });
  }
  return results;
}

function patchState(patch, piRoot) {
  const states = [];
  for (const f of filesOf(patch.spec)) {
    const target = resolveTarget(piRoot, f.target);
    if (!fs.existsSync(target)) { states.push("drift"); continue; }
    const text = fs.readFileSync(target, "utf8");
    states.push(...classifyFile(f, text).map((r) => r.state));
  }
  if (states.includes("drift")) return "drift";
  if (states.includes("pending")) return "pending";
  return "applied";
}

function backupFile(target, version) {
  const safe = target.replaceAll(path.sep, "__");
  const dst = path.join(BACKUPS, version.replace(/[^a-zA-Z0-9._-]/g, "_"), safe);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (!fs.existsSync(dst)) fs.copyFileSync(target, dst);
  return dst;
}

function checkFile(target) {
  execFileSync(process.execPath, ["--check", target], { stdio: "pipe" });
}

function applyPatch(patch, piRoot, state, reverse = false) {
  const version = piVersion();
  let changed = false;
  for (const f of filesOf(patch.spec)) {
    const target = resolveTarget(piRoot, f.target);
    let text = fs.readFileSync(target, "utf8");
    const original = text;
    backupFile(target, version);
    for (const r of f.replacements ?? []) {
      const from = reverse ? r.newText : r.oldText;
      const to = reverse ? r.oldText : r.newText;
      if (count(text, from) !== 1) continue;
      text = text.replace(from, to);
    }
    if (text !== original) {
      fs.writeFileSync(target, text);
      checkFile(target);
      changed = true;
      state.patches[patch.id] = state.patches[patch.id] ?? {};
      state.patches[patch.id].lastAppliedAt = new Date().toISOString();
      state.patches[patch.id].lastTargetSha = sha(text);
      state.patches[patch.id].removed = reverse;
    }
  }
  return changed;
}

function renderPrompt(patch, targetPath) {
  const template = fs.readFileSync(path.join(ROOT, "prompts", "heal.md"), "utf8");
  return template
    .replaceAll("{{patch_id}}", patch.id)
    .replaceAll("{{intent}}", patch.intent.trim())
    .replaceAll("{{spec}}", JSON.stringify(patch.spec, null, 2))
    .replaceAll("{{target_path}}", targetPath);
}

function latestSessionFile(dir) {
  if (!fs.existsSync(dir)) return undefined;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
  return files.sort().at(-1);
}

function deriveSingleReplacement(before, after) {
  if (before === after) return null;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length - 1;
  let endAfter = after.length - 1;
  while (endBefore >= start && endAfter >= start && before[endBefore] === after[endAfter]) { endBefore--; endAfter--; }
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
  while ((count(before, oldText) !== 1 || count(after, newText) !== 1) && (a > 0 || b < before.length || c > 0 || d < after.length)) {
    if (a > 0) { a--; while (a > 0 && before[a - 1] !== "\n") a--; }
    if (c > 0) { c--; while (c > 0 && after[c - 1] !== "\n") c--; }
    if (b < before.length) { while (b < before.length && before[b] !== "\n") b++; if (b < before.length) b++; }
    if (d < after.length) { while (d < after.length && after[d] !== "\n") d++; if (d < after.length) d++; }
    oldText = before.slice(a, b);
    newText = after.slice(c, d);
  }
  return { oldText, newText };
}

function healPatch(patch, piRoot, state) {
  const firstFile = filesOf(patch.spec)[0];
  if (!firstFile) throw new Error(`${patch.id}: no files in spec`);
  const target = resolveTarget(piRoot, firstFile.target);
  const before = fs.readFileSync(target, "utf8");
  const bak = backupFile(target, piVersion());
  const sessionDir = path.join(HEAL_SESSIONS, `${patch.id}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  say(`pi-patcher: ${patch.id} drifted. Self-healing…`);
  const prompt = renderPrompt(patch, target);
  const child = spawnSync("pi", ["-p", "--model", HEAL_MODEL, "--session-dir", sessionDir], {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
  });
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  if (output.trim()) process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  const sessionPath = latestSessionFile(sessionDir);
  state.patches[patch.id] = state.patches[patch.id] ?? {};
  state.patches[patch.id].lastSessions = [sessionPath, ...(state.patches[patch.id].lastSessions ?? [])].filter(Boolean).slice(0, 10);
  const abort = output.match(/===ABORT===([\s\S]*?)===END===/);
  if (abort) {
    fs.copyFileSync(bak, target);
    state.patches[patch.id].lastError = abort[1].trim();
    say(`pi-patcher: ${patch.id} not healed. Inspect: pi --session ${sessionPath}`);
    say(`Reason: ${abort[1].trim()}`);
    return false;
  }
  try { checkFile(target); } catch (error) {
    fs.copyFileSync(bak, target);
    state.patches[patch.id].lastError = `node --check failed: ${error.message}`;
    say(`pi-patcher: ${patch.id} not healed. Inspect: pi --session ${sessionPath}`);
    return false;
  }
  const after = fs.readFileSync(target, "utf8");
  const derived = deriveSingleReplacement(before, after);
  if (!derived || count(after, derived.newText) !== 1) {
    fs.copyFileSync(bak, target);
    state.patches[patch.id].lastError = "edits did not produce a derivable patch";
    say(`pi-patcher: ${patch.id} not healed. Inspect: pi --session ${sessionPath}`);
    return false;
  }
  const newSpec = structuredClone(patch.spec);
  const files = filesOf(newSpec);
  files[0].replacements = [{ ...(files[0].replacements?.[0] ?? {}), ...derived }];
  if (Array.isArray(newSpec.files)) newSpec.files = files;
  else { newSpec.target = files[0].target; newSpec.replacements = files[0].replacements; }
  writeJson(path.join(patch.dir, "spec.json"), newSpec);
  patch.spec = newSpec;
  state.patches[patch.id].lastHealedAt = new Date().toISOString();
  state.patches[patch.id].lastTargetSha = sha(after);
  delete state.patches[patch.id].lastError;
  say(`pi-patcher: ${patch.id} healed. Session: pi --session ${sessionPath}`);
  return true;
}

function reconcile(opts = {}) {
  ensureLayout();
  const piRoot = findPiRoot();
  const state = readJson(STATE, { patches: {} });
  state.piRoot = piRoot;
  state.lastRunAt = new Date().toISOString();
  state.piVersion = piVersion();
  for (const dir of listPatchDirs()) {
    const patch = loadPatch(dir);
    if (!patch.spec) continue;
    try {
      if (patch.tombstoned) {
        const changed = applyPatch(patch, piRoot, state, true);
        if (changed) say(`pi-patcher: reversed ${patch.id}`);
        continue;
      }
      const status = patchState(patch, piRoot);
      if (status === "applied") continue;
      if (status === "pending") {
        const changed = applyPatch(patch, piRoot, state, false);
        if (changed) say(`pi-patcher: applied ${patch.id}`);
        continue;
      }
      healPatch(patch, piRoot, state);
    } catch (error) {
      state.patches[patch.id] = state.patches[patch.id] ?? {};
      state.patches[patch.id].lastError = error instanceof Error ? error.message : String(error);
      say(`pi-patcher: ${patch.id} failed: ${state.patches[patch.id].lastError}`);
      if (!opts.afterUpdate) process.exitCode = 1;
    } finally {
      writeJson(STATE, state);
    }
  }
  writeJson(STATE, state);
}

function list() {
  ensureLayout();
  const piRoot = findPiRoot();
  const state = readJson(STATE, { patches: {} });
  for (const dir of listPatchDirs()) {
    const patch = loadPatch(dir);
    const status = patch.tombstoned ? "tombstoned" : patchState(patch, piRoot);
    const last = state.patches?.[patch.id]?.lastSessions?.[0];
    console.log(`${patch.id}\t${status}${last ? `\t${last}` : ""}`);
  }
}

function remove(id) {
  if (!id) throw new Error("Usage: pi-patcher remove <patch-id>");
  ensureLayout();
  const src = path.join(PATCHES, id);
  const dst = path.join(PATCHES, `_${id}`);
  if (!fs.existsSync(src)) throw new Error(`No active patch named ${id}`);
  fs.renameSync(src, dst);
  console.log(`Tombstoned ${id}. It will be reversed on next reconcile.`);
}

const [cmd = "reconcile", ...args] = process.argv.slice(2);
try {
  if (cmd === "reconcile") reconcile({ afterUpdate: args.includes("--after-update") });
  else if (cmd === "heal") {
    const id = args[0];
    if (!id) throw new Error("Usage: pi-patcher heal <patch-id>");
    ensureLayout();
    const dir = path.join(PATCHES, id);
    if (!fs.existsSync(dir)) throw new Error(`No active patch named ${id}`);
    const patch = loadPatch(dir);
    const state = readJson(STATE, { patches: {} });
    healPatch(patch, findPiRoot(), state);
    writeJson(STATE, state);
  }
  else if (cmd === "list") list();
  else if (cmd === "remove") remove(args[0]);
  else throw new Error(`Unknown command: ${cmd}`);
} catch (error) {
  console.error(`pi-patcher: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  HEAL_MODEL,
  HEAL_SESSIONS,
  PROMPTS_DIR,
  piVersion,
  resolveTarget,
} from "./paths.js";
import {
  backupFile,
  deriveSingleReplacement,
  filesOf,
  nodeCheck,
  type Patch,
} from "./patches.js";
import {
  count,
  errorMessage,
  patchEntry,
  sha,
  say,
  writeJson,
  type State,
} from "./util.js";

export function heal(patch: Patch, piRoot: string, state: State): void {
  const file = filesOf(patch.spec)[0];
  if (!file) throw new Error(`${patch.id}: no files in spec`);

  const target = resolveTarget(piRoot, file.target);
  const before = fs.readFileSync(target, "utf8");
  const backup = backupFile(target, piVersion());
  const entry = patchEntry(state, patch.id);

  say(`pi-patcher: ${patch.id} drifted. Self-healing…`);
  const { output, sessionPath } = runHealSession(patch, target);
  if (sessionPath)
    entry.lastSessions = [sessionPath, ...(entry.lastSessions ?? [])].slice(
      0,
      10,
    );

  const abort = output.match(/===ABORT===([\s\S]*?)===END===/);
  if (abort)
    return rollback(target, backup, entry, abort[1]!.trim(), sessionPath);

  try {
    nodeCheck(target);
  } catch (error) {
    return rollback(
      target,
      backup,
      entry,
      `node --check failed: ${errorMessage(error)}`,
      sessionPath,
    );
  }

  const after = fs.readFileSync(target, "utf8");
  const derived = deriveSingleReplacement(before, after);
  if (!derived || count(after, derived.newText) !== 1) {
    return rollback(
      target,
      backup,
      entry,
      "edits did not produce a derivable patch",
      sessionPath,
    );
  }

  rewriteSpec(patch, derived);
  entry.lastHealedAt = new Date().toISOString();
  entry.lastTargetSha = sha(after);
  delete entry.lastError;
  say(
    `pi-patcher: ${patch.id} healed. Session: pi --session ${sessionPath ?? "(no session)"}`,
  );
}

// ── LLM call ─────────────────────────────────────────────────
function runHealSession(
  patch: Patch,
  target: string,
): { output: string; sessionPath: string | undefined } {
  const sessionDir = path.join(
    HEAL_SESSIONS,
    `${patch.id}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  fs.mkdirSync(sessionDir, { recursive: true });

  const child = spawnSync(
    "pi",
    ["-p", "--model", HEAL_MODEL, "--session-dir", sessionDir],
    {
      input: renderPrompt(patch, target),
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 20,
    },
  );

  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  if (output.trim())
    process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  return { output, sessionPath: latestSessionFile(sessionDir) };
}

function renderPrompt(patch: Patch, targetPath: string): string {
  const template = fs.readFileSync(path.join(PROMPTS_DIR, "heal.md"), "utf8");
  return template
    .replaceAll("{{patch_id}}", patch.id)
    .replaceAll("{{intent}}", patch.intent.trim())
    .replaceAll("{{spec}}", JSON.stringify(patch.spec, null, 2))
    .replaceAll("{{target_path}}", targetPath);
}

function latestSessionFile(dir: string): string | undefined {
  if (!fs.existsSync(dir)) return undefined;
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(dir, f))
    .sort()
    .at(-1);
}

// ── Rollback + spec rewrite ──────────────────────────────────
function rollback(
  target: string,
  backup: string,
  entry: { lastError?: string },
  reason: string,
  session: string | undefined,
): void {
  fs.copyFileSync(backup, target);
  entry.lastError = reason;
  say(
    `pi-patcher: not healed. Inspect: pi --session ${session ?? "(no session)"}`,
  );
  say(`Reason: ${reason}`);
}

function rewriteSpec(
  patch: Patch,
  derived: { oldText: string; newText: string },
): void {
  const newSpec = structuredClone(patch.spec);
  const files = filesOf(newSpec);
  const first = files[0]!;
  first.replacements = [
    {
      ...(first.replacements?.[0] ?? { oldText: "", newText: "" }),
      ...derived,
    },
  ];

  if (Array.isArray(newSpec.files)) newSpec.files = files;
  else {
    newSpec.target = first.target;
    newSpec.replacements = first.replacements;
  }

  writeJson(path.join(patch.dir, "spec.json"), newSpec);
  patch.spec = newSpec;
}

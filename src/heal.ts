import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  type Patch,
  type Replacement,
  HEAL_MODEL,
  HEAL_SESSIONS,
  PROMPTS_DIR,
  classify,
  count,
  derivePatch,
  resolveTarget,
  saveSpec,
  validateTarget,
} from "./patches.js";
import {
  type State,
  recordError,
  recordHealed,
  rememberSession,
} from "./state.js";

/**
 * Re-anchor every drifted replacement in a patch by handing each one to
 * pi in turn. Replacements that are already applied are skipped. Each AI
 * session is scoped to a single specific replacement; only that
 * file/replacement entry in `spec.json` is rewritten on success.
 *
 * Returns true iff every drifted replacement healed successfully.
 */
export function heal(patch: Patch, piRoot: string, state: State): boolean {
  let ok = true;
  for (let fi = 0; fi < patch.spec.files.length; fi++) {
    const file = patch.spec.files[fi]!;
    for (let ri = 0; ri < file.replacements.length; ri++) {
      const target = resolveTarget(piRoot, file.target);
      if (!fs.existsSync(target)) {
        ok = false;
        recordError(state, patch.id, `${file.target}: target file missing`);
        continue;
      }
      const text = fs.readFileSync(target, "utf8");
      // patch.spec is mutated in place by saveSpec after each successful
      // heal; re-read the replacement freshly so classification is correct.
      const replacement = patch.spec.files[fi]!.replacements[ri]!;
      if (classify(replacement, text) !== "drift") continue;
      if (!healOne(patch, fi, ri, piRoot, state)) ok = false;
    }
  }
  return ok;
}

function healOne(
  patch: Patch,
  fi: number,
  ri: number,
  piRoot: string,
  state: State,
): boolean {
  const file = patch.spec.files[fi]!;
  const replacement = file.replacements[ri]!;
  const target = resolveTarget(piRoot, file.target);
  const before = fs.readFileSync(target, "utf8");

  const label = healLabel(patch, fi, ri);
  say(`pi-patcher: ${label} drifted. Self-healing\u2026`);

  const sessionDir = path.join(
    HEAL_SESSIONS,
    `${patch.id}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  fs.mkdirSync(sessionDir, { recursive: true });

  const child = spawnSync(
    "pi",
    ["-p", "--model", HEAL_MODEL, "--session-dir", sessionDir],
    {
      input: renderPrompt(patch, target, replacement),
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 20,
    },
  );

  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  if (output.trim())
    process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);

  const sessionPath = latestSessionFile(sessionDir);
  if (sessionPath) rememberSession(state, patch.id, sessionPath);

  const fail = (reason: string) => {
    fs.writeFileSync(target, before);
    recordError(state, patch.id, reason);
    say(
      `pi-patcher: ${label} not healed. Inspect: pi --session ${sessionPath ?? "(no session)"}`,
    );
    say(`Reason: ${reason}`);
    return false;
  };

  const abort = output.match(/===ABORT===([\s\S]*?)===END===/);
  if (abort) return fail(abort[1]!.trim());
  if (child.error) return fail(`failed to start pi: ${child.error.message}`);
  if (child.status !== 0)
    return fail(
      child.signal
        ? `pi heal session terminated by signal ${child.signal}`
        : `pi heal session exited with status ${child.status ?? "unknown"}`,
    );

  try {
    validateTarget(target);
  } catch (error) {
    return fail(
      `validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const after = fs.readFileSync(target, "utf8");
  const derived = derivePatch(before, after);
  if (
    !derived ||
    count(before, derived.oldText) !== 1 ||
    count(after, derived.newText) !== 1
  )
    return fail("edits did not produce a derivable patch");

  rewriteReplacement(patch, fi, ri, derived);
  recordHealed(state, patch.id);
  say(
    `pi-patcher: ${label} healed. Session: pi --session ${sessionPath ?? "(no session)"}`,
  );
  return true;
}

function healLabel(patch: Patch, fi: number, ri: number): string {
  const file = patch.spec.files[fi]!;
  if (patch.spec.files.length === 1 && file.replacements.length === 1)
    return patch.id;
  return `${patch.id} (${file.target}#${ri})`;
}

function renderPrompt(
  patch: Patch,
  targetPath: string,
  replacement: Replacement,
): string {
  const template = fs.readFileSync(path.join(PROMPTS_DIR, "heal.md"), "utf8");
  return template
    .replaceAll("{{patch_id}}", patch.id)
    .replaceAll("{{intent}}", patch.intent.trim())
    .replaceAll(
      "{{replacement}}",
      JSON.stringify(
        { oldText: replacement.oldText, newText: replacement.newText },
        null,
        2,
      ),
    )
    .replaceAll("{{target_path}}", targetPath)
    .replaceAll("{{validation_hint}}", validationHint(targetPath));
}

function validationHint(targetPath: string): string {
  const ext = path.extname(targetPath).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs")
    return `The target file must pass \`node --check ${targetPath}\` after edits.`;
  if (ext === ".json")
    return `The target file must remain valid JSON after edits.`;
  return `The target file must remain syntactically valid for its language; no automatic check is run for this file type.`;
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

function rewriteReplacement(
  patch: Patch,
  fi: number,
  ri: number,
  derived: Replacement,
): void {
  const newSpec = structuredClone(patch.spec);
  const file = newSpec.files[fi]!;
  const old = file.replacements[ri]!;
  file.replacements[ri] = { ...old, ...derived };
  saveSpec(patch, newSpec);
}

function say(message: string): void {
  console.log(message);
}

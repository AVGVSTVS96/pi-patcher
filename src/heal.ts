import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  type Patch,
  type Replacement,
  HEAL_MODEL,
  HEAL_SESSIONS,
  PROMPTS_DIR,
  backupFile,
  count,
  derivePatch,
  nodeCheck,
  piVersion,
  resolveTarget,
  saveSpec,
  sha,
} from "./patches.js";
import {
  type State,
  recordError,
  recordHealed,
  rememberSession,
} from "./state.js";

/**
 * Re-anchor a drifted patch by handing the work to pi itself. On success the
 * patch's spec is rewritten with the new oldText/newText derived from the
 * AI's edit. On failure the target file is restored from the in-memory
 * snapshot and an error is recorded in state. Returns true on success.
 */
export function heal(patch: Patch, piRoot: string, state: State): boolean {
  const file = patch.spec.files[0];
  if (!file) throw new Error(`${patch.id}: no files in spec`);

  const target = resolveTarget(piRoot, file.target);
  const before = fs.readFileSync(target, "utf8");
  backupFile(target, piVersion());

  say(`pi-patcher: ${patch.id} drifted. Self-healing\u2026`);

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

  const sessionPath = latestSessionFile(sessionDir);
  if (sessionPath) rememberSession(state, patch.id, sessionPath);

  const fail = (reason: string) => {
    fs.writeFileSync(target, before);
    recordError(state, patch.id, reason);
    say(
      `pi-patcher: ${patch.id} not healed. Inspect: pi --session ${sessionPath ?? "(no session)"}`,
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
    nodeCheck(target);
  } catch (error) {
    return fail(
      `node --check failed: ${error instanceof Error ? error.message : String(error)}`,
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

  rewriteFirstReplacement(patch, derived);
  recordHealed(state, patch.id, sha(after));
  say(
    `pi-patcher: ${patch.id} healed. Session: pi --session ${sessionPath ?? "(no session)"}`,
  );
  return true;
}

function renderPrompt(patch: Patch, targetPath: string): string {
  const template = fs.readFileSync(
    path.join(PROMPTS_DIR, "heal.md"),
    "utf8",
  );
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

function rewriteFirstReplacement(patch: Patch, derived: Replacement): void {
  const newSpec = structuredClone(patch.spec);
  const first = newSpec.files[0]!;
  first.replacements = [
    { ...(first.replacements[0] ?? { oldText: "", newText: "" }), ...derived },
  ];
  saveSpec(patch, newSpec);
}

function say(message: string): void {
  console.log(message);
}

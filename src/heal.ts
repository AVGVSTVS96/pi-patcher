import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  type Patch,
  type Replacement,
  HEAL_MODEL,
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
import { logDetail, logFailure, logSuccess, logWarn, ui } from "./ui.js";

/**
 * Re-anchor every drifted replacement in a patch by handing each one to
 * pi in turn. Replacements that are already applied are skipped. Each AI
 * session is scoped to a single specific replacement; only that
 * file/replacement entry in `spec.json` is rewritten on success.
 *
 * Returns true iff every drifted replacement healed successfully.
 */
export async function heal(patch: Patch, piRoot: string, state: State): Promise<boolean> {
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
      if (!(await healOne(patch, fi, ri, piRoot, state))) ok = false;
    }
  }
  return ok;
}

async function healOne(
  patch: Patch,
  fi: number,
  ri: number,
  piRoot: string,
  state: State,
): Promise<boolean> {
  const file = patch.spec.files[fi]!;
  const replacement = file.replacements[ri]!;
  const target = resolveTarget(piRoot, file.target);
  const before = fs.readFileSync(target, "utf8");

  const label = healLabel(patch, fi, ri);
  logWarn(`${label} drifted`);

  const sessionId = crypto.randomUUID();

  const stopSpinner = startSpinner(`healing ${label} with ${HEAL_MODEL}`);
  const child = await runPiHeal(
    ["-p", "--model", HEAL_MODEL, "--session-id", sessionId],
    renderPrompt(patch, target, replacement),
  );
  stopSpinner();

  const output = child.output;
  const fail = (reason: string, inspect = true) => {
    fs.writeFileSync(target, before);
    recordError(state, patch.id, reason);
    if (inspect) rememberSession(state, patch.id, sessionId);
    logFailure(`${label} not healed`);
    logDetail(`Reason: ${reason}`);
    if (inspect) logDetail(`Inspect: ${ui.cyan(`pi --session ${sessionId}`)}`);
    return false;
  };

  const abort = output.match(/===ABORT===([\s\S]*?)===END===/);
  if (abort) return fail(abort[1]!.trim());
  if (child.error) return fail(`failed to start pi: ${child.error.message}`, false);
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
  rememberSession(state, patch.id, sessionId);
  recordHealed(state, patch.id);
  logSuccess(`${label} healed`);
  logDetail(`Inspect: ${ui.cyan(`pi --session ${sessionId}`)}`);
  return true;
}

type HealProcessResult = {
  output: string;
  error?: Error;
  status: number | null;
  signal: NodeJS.Signals | null;
};

const MAX_CAPTURED_OUTPUT = 1024 * 1024 * 20;

function runPiHeal(args: string[], input: string): Promise<HealProcessResult> {
  return new Promise((resolve) => {
    const child = spawn("pi", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let captured = 0;
    let spawnError: Error | undefined;

    const capture = (chunk: Buffer) => {
      if (captured >= MAX_CAPTURED_OUTPUT) return;
      const remaining = MAX_CAPTURED_OUTPUT - captured;
      const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(kept);
      captured += kept.length;
    };

    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (status, signal) => {
      resolve({
        output: Buffer.concat(chunks).toString("utf8"),
        error: spawnError,
        status,
        signal,
      });
    });

    child.stdin.on("error", () => {
      // The child can exit before reading the prompt (for example if pi is
      // missing or crashes early). The close/error handlers above report the
      // actual failure; don't let an EPIPE crash pi-patcher.
    });
    child.stdin.end(input);
  });
}

function startSpinner(message: string): () => void {
  if (!process.stdout.isTTY) {
    console.log(`  ${ui.dim("…")} ${message}…`);
    return () => undefined;
  }

  const frames = ["◐", "◓", "◑", "◒"].map(ui.yellow);
  const start = Date.now();
  let i = 0;
  const render = () => {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    process.stdout.write(`\r  ${frames[i++ % frames.length]} ${message} (${elapsed}s)`);
  };
  render();
  const timer = setInterval(render, 120);
  return () => {
    clearInterval(timer);
    process.stdout.write("\r\x1b[K");
  };
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


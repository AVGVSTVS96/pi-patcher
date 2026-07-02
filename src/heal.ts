import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  type Patch,
  HEAL_MODEL,
  PROMPTS_DIR,
  applyEdits,
  loadPatch,
  resolveTarget,
} from "./patches.js";
import {
  type State,
  recordError,
  recordHealed,
  recordNeedsRedesign,
  rememberSession,
} from "./state.js";
import {
  logDetail,
  logFailure,
  logLabeledDetail,
  logStepDone,
  logSuccess,
  logWarn,
  ui,
} from "./ui.js";

/**
 * Patch-level result of a heal pass:
 *   - "healed":  the agent's rewritten spec applied cleanly from a clean base
 *   - "failed":  a mechanical/validation error (rolled back); a hard failure
 *   - "aborted": the agent judged that restoring the intent needs a redesign
 *                (tier 3). The caller routes this (picker / report / policy).
 */
export type HealResult =
  | { kind: "healed" }
  | { kind: "failed" }
  | { kind: "aborted"; reason: string; sessionId: string };

/**
 * One contract for heal and redesign: the AI is the only writer of patch
 * specs. pi rewrites the spec file (PATCH.md / spec.json) itself — it may
 * trial edits in the source, but those are scratch — and pi-patcher proves
 * the result by restoring the sources from a snapshot and applying the
 * rewritten spec mechanically. A spec that doesn't verify is bounced back
 * once, in the same session, with the exact failure; a second miss rolls
 * everything back.
 *
 * The two modes differ only in policy: heal asks for the smallest spec
 * change that restores the intent (and may abort into "needs redesign"),
 * redesign lets the agent restructure the edits freely.
 */
export async function heal(patch: Patch, piRoot: string, state: State): Promise<HealResult> {
  return updateSpec(patch, piRoot, state, "heal");
}

export async function redesign(patch: Patch, piRoot: string, state: State): Promise<boolean> {
  return (await updateSpec(patch, piRoot, state, "redesign")).kind === "healed";
}

type Mode = "heal" | "redesign";

const MAX_ATTEMPTS = 2;

async function updateSpec(
  patch: Patch,
  piRoot: string,
  state: State,
  mode: Mode,
): Promise<HealResult> {
  const label = patch.id;
  const specPath = patchSpecPath(patch);
  const specBefore = fs.readFileSync(specPath, "utf8");
  const snapshot = snapshotPackages(patch, piRoot);
  const sessionId = crypto.randomUUID();

  if (mode === "heal") logWarn(`${label} drifted`);

  const restoreAll = () => {
    if (fs.readFileSync(specPath, "utf8") !== specBefore)
      fs.writeFileSync(specPath, specBefore);
    restoreSnapshot(snapshot);
  };
  const fail = (reason: string, inspect = true): HealResult => {
    restoreAll();
    recordError(state, patch.id, reason);
    if (mode === "redesign") recordNeedsRedesign(state, patch.id);
    if (inspect) rememberSession(state, patch.id, sessionId);
    logFailure(mode === "heal" ? `${label} not healed` : `${label} redesign failed`);
    logLabeledDetail("Reason", reason);
    if (inspect) logDetail(`Inspect: ${ui.cyan(`pi --session ${sessionId}`)}`);
    return { kind: "failed" };
  };

  let spinner = startSpinner(
    mode === "heal"
      ? `planning ${label} with ${HEAL_MODEL}`
      : `planning ${label} redesign with ${HEAL_MODEL}`,
  );
  let input = renderPrompt(`${mode}.md`, patch, piRoot);

  for (let attempt = 1; ; attempt++) {
    const child = await runPiHeal(
      ["-p", "--model", HEAL_MODEL, "--session-id", sessionId],
      input,
      (plan) => spinner.step(plan, `rewriting ${label}'s spec`),
    );
    spinner.stop();
    // Scratch edits in the source are part of the contract (the agent may
    // trial its change there); erase them before judging the spec.
    restoreSnapshot(snapshot);

    const abortReason = extractBlock(child.output, "ABORT");
    if (abortReason) {
      if (mode === "redesign") return fail(abortReason);
      restoreAll();
      recordError(state, patch.id, abortReason);
      recordNeedsRedesign(state, patch.id);
      rememberSession(state, patch.id, sessionId);
      logWarn(`${label} needs a redesign`);
      logLabeledDetail("Reason", abortReason);
      logDetail(`Inspect: ${ui.cyan(`pi --session ${sessionId}`)}`);
      return { kind: "aborted", reason: abortReason, sessionId };
    }
    if (child.error) return fail(`failed to start pi: ${child.error.message}`, false);
    if (child.status !== 0)
      return fail(
        child.signal
          ? `pi session terminated by signal ${child.signal}`
          : `pi session exited with status ${child.status ?? "unknown"}`,
      );

    const reason = verifySpec(patch, piRoot, specPath, specBefore);
    if (!reason) break;
    if (attempt >= MAX_ATTEMPTS) return fail(reason);

    logWarn(`${label} attempt ${attempt} did not verify; retrying`);
    logLabeledDetail("Reason", reason);
    input = renderRetryPrompt(specPath, reason);
    spinner = startSpinner(`retrying ${label} with ${HEAL_MODEL}`);
  }

  rememberSession(state, patch.id, sessionId);
  recordHealed(state, patch.id);
  logSuccess(mode === "heal" ? `${label} healed` : `${label} redesigned`);
  logDetail(`Inspect: ${ui.cyan(`pi --session ${sessionId}`)}`);
  return { kind: "healed" };
}

/**
 * Judge the agent's rewritten spec: it must have changed, still parse, and
 * apply cleanly to the restored (upstream) targets. Returns the failure
 * reason, or null on success — in which case the targets are left patched.
 * applyEdits validates syntax and self-rolls-back its own writes on failure.
 */
function verifySpec(
  patch: Patch,
  piRoot: string,
  specPath: string,
  specBefore: string,
): string | null {
  if (fs.readFileSync(specPath, "utf8") === specBefore)
    return `the session did not modify ${path.basename(specPath)}`;
  let reloaded: Patch;
  try {
    reloaded = loadPatch(patch.id);
  } catch (error) {
    return `the rewritten spec is invalid: ${msg(error)}`;
  }
  try {
    applyEdits(reloaded, piRoot);
  } catch (error) {
    return `the rewritten spec did not apply: ${msg(error)}`;
  }
  return null;
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── pi invocation ────────────────────────────────────────────
type HealProcessResult = {
  output: string;
  error?: Error;
  status: number | null;
  signal: NodeJS.Signals | null;
};

const MAX_CAPTURED_OUTPUT = 1024 * 1024 * 20;

/**
 * Match a `===TAG===…===END===` block and return its trimmed body, or null.
 * Used for the streamed PLAN block and the final ABORT block.
 */
function extractBlock(text: string, tag: string): string | null {
  const match = text.match(new RegExp(`===${tag}===([\\s\\S]*?)===END===`));
  return match ? match[1]!.trim() : null;
}

function runPiHeal(
  args: string[],
  input: string,
  onPlan?: (plan: string) => void,
): Promise<HealProcessResult> {
  return new Promise((resolve) => {
    const child = spawn("pi", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let captured = 0;
    let spawnError: Error | undefined;
    let planFired = false;

    const capture = (chunk: Buffer) => {
      if (captured < MAX_CAPTURED_OUTPUT) {
        const remaining = MAX_CAPTURED_OUTPUT - captured;
        const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        chunks.push(kept);
        captured += kept.length;
      }
      // Surface the agent's plan the moment its block completes in the stream,
      // so the TUI can advance from "planning" to "rewriting" while pi works.
      if (onPlan && !planFired) {
        const plan = extractBlock(Buffer.concat(chunks).toString("utf8"), "PLAN");
        if (plan) {
          planFired = true;
          onPlan(plan);
        }
      }
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

type Spinner = {
  /** Commit the current step as a ✓ line, then start spinning `next`. */
  step: (done: string, next: string) => void;
  /** Clear the live spinner line (the caller logs the final result). */
  stop: () => void;
};

/**
 * A single-line spinner that can advance through steps. Each `step(done,
 * next)` commits `done` as a resolved ✓ line and restarts the spinner (with a
 * fresh timer) on `next`. Falls back to plain lines when not on a TTY.
 */
function startSpinner(message: string): Spinner {
  let current = message;

  if (!process.stdout.isTTY) {
    console.log(`  ${ui.dim("…")} ${current}…`);
    return {
      step: (done, next) => {
        logStepDone(done);
        current = next;
        console.log(`  ${ui.dim("…")} ${current}…`);
      },
      stop: () => undefined,
    };
  }

  const frames = ["◐", "◓", "◑", "◒"].map(ui.yellow);
  let start = Date.now();
  let i = 0;
  const render = () => {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    process.stdout.write(`\r  ${frames[i++ % frames.length]} ${current} (${elapsed}s)`);
  };
  render();
  const timer = setInterval(render, 120);

  return {
    step: (done, next) => {
      process.stdout.write("\r\x1b[K");
      logStepDone(done);
      current = next;
      start = Date.now();
      render();
    },
    stop: () => {
      clearInterval(timer);
      process.stdout.write("\r\x1b[K");
    },
  };
}

// ── Package snapshot / scratch-edit rollback ─────────────────
const SNAPSHOT_MAX_FILES = 5000;
const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;

type Snapshot = {
  /** Contents to restore, bounded by the caps. */
  files: Map<string, string>;
  /** Every path that existed pre-session; anything else found later is deleted. */
  names: Set<string>;
  roots: string[];
};

/** Nearest ancestor directory containing a package.json (or the file's dir). */
function packageRootOf(file: string): string {
  let dir = path.dirname(file);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return path.dirname(file);
}

/**
 * Snapshot every file under each target's package (skipping node_modules and
 * dot-dirs, bounded by file/byte caps) so the agent's scratch edits can be
 * rolled back wherever they land. Declared targets are always snapshotted,
 * even past the caps.
 */
function snapshotPackages(patch: Patch, piRoot: string): Snapshot {
  const targets = patch.spec.files.map((f) => resolveTarget(piRoot, f.target));
  const roots = [...new Set(targets.map(packageRootOf))];
  const snapshot: Snapshot = { files: new Map(), names: new Set(), roots };
  let bytes = 0;

  for (const root of roots)
    walkFiles(root, (p) => {
      snapshot.names.add(p);
      if (snapshot.files.size >= SNAPSHOT_MAX_FILES || bytes >= SNAPSHOT_MAX_BYTES) return;
      const content = safeRead(p);
      if (content === undefined) return;
      bytes += Buffer.byteLength(content);
      snapshot.files.set(p, content);
    });

  for (const target of targets) {
    if (snapshot.files.has(target)) continue;
    const content = safeRead(target);
    if (content !== undefined) {
      snapshot.files.set(target, content);
      snapshot.names.add(target);
    }
  }
  return snapshot;
}

/**
 * Put every snapshotted file back and delete files created since the
 * snapshot, leaving the packages exactly as the agent found them.
 */
function restoreSnapshot(snapshot: Snapshot): void {
  for (const [p, original] of snapshot.files)
    if (safeRead(p) !== original) fs.writeFileSync(p, original);
  for (const root of snapshot.roots)
    walkFiles(root, (p) => {
      if (!snapshot.names.has(p)) fs.rmSync(p, { force: true });
    });
}

function walkFiles(dir: string, visit: (file: string) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(p, visit);
    else visit(p);
  }
}

function safeRead(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

// ── Prompt rendering ─────────────────────────────────────────
export function renderRedesignPrompt(patch: Patch, piRoot: string): string {
  return renderPrompt("redesign.md", patch, piRoot);
}

function renderPrompt(name: string, patch: Patch, piRoot: string): string {
  const template = fs.readFileSync(path.join(PROMPTS_DIR, name), "utf8");
  const targets = patch.spec.files.map((f) => resolveTarget(piRoot, f.target));
  return template
    .replaceAll("{{patch_id}}", patch.id)
    .replaceAll("{{spec_path}}", patchSpecPath(patch))
    .replaceAll("{{targets}}", targets.join("\n"))
    .replaceAll("{{package_root}}", packageRootOf(targets[0]!))
    .replaceAll("{{patch_markdown}}", patchContext(patch))
    .replaceAll("{{validation_hint}}", validationHint(targets));
}

function renderRetryPrompt(specPath: string, reason: string): string {
  const template = fs.readFileSync(path.join(PROMPTS_DIR, "retry.md"), "utf8");
  return template
    .replaceAll("{{spec_path}}", specPath)
    .replaceAll("{{failure_reason}}", reason);
}

function patchSpecPath(patch: Patch): string {
  return path.join(patch.dir, patch.source === "markdown" ? "PATCH.md" : "spec.json");
}

function patchContext(patch: Patch): string {
  const specPath = patchSpecPath(patch);
  const spec = fs.existsSync(specPath) ? fs.readFileSync(specPath, "utf8").trim() : "";
  if (patch.source === "markdown") return spec || patch.intent.trim() || `# ${patch.id}`;
  // Legacy spec.json: prose intent alongside the raw spec the agent must edit.
  const parts = [
    patch.intent.trim(),
    spec && `\`\`\`json file=${specPath}\n${spec}\n\`\`\``,
  ].filter(Boolean);
  return parts.length ? parts.join("\n\n") : `# ${patch.id}`;
}

function validationHint(targets: string[]): string {
  const hints = new Set(
    targets.map((t) => {
      const ext = path.extname(t).toLowerCase();
      if (ext === ".js" || ext === ".mjs" || ext === ".cjs")
        return `The applied spec must leave its target passing \`node --check\`.`;
      if (ext === ".json") return `The applied spec must leave its target as valid JSON.`;
      return `The applied spec must leave its target syntactically valid for its language; no automatic check is run for this file type.`;
    }),
  );
  return [...hints].join(" ");
}

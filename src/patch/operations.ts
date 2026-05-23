import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HEAL_MODEL, HEAL_SESSIONS, PROMPTS_DIR } from "../paths.js";
import { piVersion, resolveTarget } from "../pi.js";
import { say, errorMessage } from "../log.js";
import {
  recordApplied,
  recordReverted,
  recordHealed,
  recordError,
  rememberHealSession,
} from "../state.js";
import type { Ctx } from "../session.js";
import { saveSpec } from "./io.js";
import {
  applyEdits,
  revertEdits,
  backupFile,
  derivePatch,
  nodeCheck,
  count,
  sha,
} from "./edits.js";
import { type Patch, type Replacement, filesOf } from "./types.js";

// ── Layer 2: semantic operations on a patch ──────────────────
//
// Each operation runs the corresponding mechanical edits, records the
// outcome in state, and logs. They return void on success; failures throw
// (apply/revert) or return false (heal — because the heal session itself
// reports a structured abort that isn't an exception).

export function apply(patch: Patch, ctx: Ctx): void {
  const targetSha = applyEdits(patch, ctx);
  if (!targetSha) return;
  recordApplied(ctx.state, patch.id, targetSha);
  say(`pi-patcher: applied ${patch.id}`);
}

export function revert(patch: Patch, ctx: Ctx): void {
  const targetSha = revertEdits(patch, ctx);
  if (!targetSha) return;
  recordReverted(ctx.state, patch.id, targetSha);
  say(`pi-patcher: reversed ${patch.id}`);
}

export function heal(patch: Patch, ctx: Ctx): boolean {
  const file = filesOf(patch.spec)[0];
  if (!file) throw new Error(`${patch.id}: no files in spec`);

  const target = resolveTarget(ctx.piRoot, file.target);
  const before = fs.readFileSync(target, "utf8");
  backupFile(target, piVersion());

  say(`pi-patcher: ${patch.id} drifted. Self-healing…`);
  const session = runHealSession(patch, target);
  if (session.path) rememberHealSession(ctx.state, patch.id, session.path);

  const abort = session.output.match(/===ABORT===([\s\S]*?)===END===/);
  if (abort)
    return failHeal(ctx, patch, target, before, abort[1]!.trim(), session.path);

  if (session.error)
    return failHeal(
      ctx,
      patch,
      target,
      before,
      `failed to start pi: ${session.error.message}`,
      session.path,
    );

  if (session.status !== 0)
    return failHeal(
      ctx,
      patch,
      target,
      before,
      session.signal
        ? `pi heal session terminated by signal ${session.signal}`
        : `pi heal session exited with status ${session.status ?? "unknown"}`,
      session.path,
    );

  try {
    nodeCheck(target);
  } catch (error) {
    return failHeal(
      ctx,
      patch,
      target,
      before,
      `node --check failed: ${errorMessage(error)}`,
      session.path,
    );
  }

  const after = fs.readFileSync(target, "utf8");
  const derived = derivePatch(before, after);
  if (
    !derived ||
    count(before, derived.oldText) !== 1 ||
    count(after, derived.newText) !== 1
  )
    return failHeal(
      ctx,
      patch,
      target,
      before,
      "edits did not produce a derivable patch",
      session.path,
    );

  rewriteFirstReplacement(patch, derived);
  recordHealed(ctx.state, patch.id, sha(after));
  say(
    `pi-patcher: ${patch.id} healed. Session: pi --session ${session.path ?? "(no session)"}`,
  );
  return true;
}

// ── Heal internals ───────────────────────────────────────────
type HealSession = {
  output: string;
  path: string | undefined;
  error: Error | undefined;
  signal: NodeJS.Signals | null;
  status: number | null;
};

function runHealSession(patch: Patch, targetPath: string): HealSession {
  const sessionDir = path.join(
    HEAL_SESSIONS,
    `${patch.id}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  fs.mkdirSync(sessionDir, { recursive: true });

  const child = spawnSync(
    "pi",
    ["-p", "--model", HEAL_MODEL, "--session-dir", sessionDir],
    {
      input: renderPrompt(patch, targetPath),
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 20,
    },
  );

  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  if (output.trim())
    process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);

  return {
    output,
    path: latestSessionFile(sessionDir),
    error: child.error,
    signal: child.signal,
    status: child.status,
  };
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

function failHeal(
  ctx: Ctx,
  patch: Patch,
  target: string,
  before: string,
  reason: string,
  sessionPath: string | undefined,
): false {
  fs.writeFileSync(target, before);
  recordError(ctx.state, patch.id, reason);
  say(
    `pi-patcher: not healed. Inspect: pi --session ${sessionPath ?? "(no session)"}`,
  );
  say(`Reason: ${reason}`);
  return false;
}

function rewriteFirstReplacement(patch: Patch, derived: Replacement): void {
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
  saveSpec(patch, newSpec);
}

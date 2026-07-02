import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const cleanups: string[] = [];

const originalPackageManagerCli = `async function update() {\n                    console.log(chalk.green(\`Updated \${APP_NAME}\`));\n}\n`;

afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("pi-patcher CLI", () => {
  // ── Opt-in via `init` ─────────────────────────────────────
  test("init installs the bundled bootstrap-hook and applies it to fresh pi files", () => {
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });

    const result = runCli(ctx, ["init"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pi-patcher\n");
    expect(result.stdout).toContain("seeded internal patch bootstrap-hook");
    expect(result.stdout).toContain("bootstrap-hook applied");
    expect(result.stdout).toContain("pi-patcher is wired into pi update");
    expect(result.stdout).toContain("To remove cleanly later, run: pi-patcher uninstall");

    const patched = fs.readFileSync(ctx.packageManagerCliPath, "utf8");
    expect(patched).toContain('import("node:child_process")');
    expect(patched).toContain('spawnSync("pi-patcher", ["reconcile"]');
    expect(patched).not.toContain("--after-update");
    expect(patched).not.toContain('require("child_process")');

    // The bundled patch is seeded into internal-patches/, NOT the user dir,
    // and its baseSha is recorded so future shipped fixes can be detected.
    expect(fs.existsSync(path.join(internalDir(ctx, "bootstrap-hook"), "PATCH.md"))).toBe(true);
    expect(fs.existsSync(path.join(ctx.home, ".pi", "patches", "bootstrap-hook"))).toBe(false);
    expect(readState(ctx).internalBaseShas["bootstrap-hook"]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("init seeds the internal patch while leaving ~/.pi/patches/ for user patches", () => {
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });
    fs.writeFileSync(path.join(ctx.piRoot, "dist", "user.js"), "const x = 1;\n");
    writePatch(ctx, "user-tweak", {
      files: [
        {
          target: "dist/user.js",
          replacements: [{ oldText: "const x = 1;\n", newText: "const x = 2;\n" }],
        },
      ],
    });

    const result = runCli(ctx, ["init"]);

    expect(result.exitCode).toBe(0);
    // Internal patch applied from internal-patches/, user patch from ~/.pi/patches/.
    expect(result.stdout).toContain("bootstrap-hook applied");
    expect(result.stdout).toContain("user-tweak applied");
    expect(fs.readFileSync(path.join(ctx.piRoot, "dist", "user.js"), "utf8")).toBe(
      "const x = 2;\n",
    );
    // The user dir holds only the user patch; sync never wrote into it.
    expect(fs.readdirSync(path.join(ctx.home, ".pi", "patches"))).toEqual(["user-tweak"]);
  });

  test("the bundled dist/cli.js artifact runs the same init happy path", () => {
    // Guards against bundler regressions: bad import.meta.url resolution,
    // externalized dynamic imports, dropped chmod +x, etc.
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });

    const result = runBundledCli(ctx, ["init"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("bootstrap-hook applied");
    expect(fs.readFileSync(ctx.packageManagerCliPath, "utf8")).toContain(
      'import("node:child_process")',
    );
  });

  test("reconcile is a no-op without `init` (the opt-in invariant)", () => {
    // Bare `npm install -g pi-patcher` must not have touched the user's pi.
    // Until `init` runs, `reconcile` finds no patches to apply.
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });

    const result = runCli(ctx, ["reconcile"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("applied bootstrap-hook");
    expect(fs.readFileSync(ctx.packageManagerCliPath, "utf8")).toBe(originalPackageManagerCli);
    // The patches dir is created (ensureLayout) but stays empty.
    expect(
      fs.existsSync(path.join(ctx.home, ".pi", "patches", "bootstrap-hook")),
    ).toBe(false);
  });

  test("reconcile after init is idempotent across two invocations", () => {
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });
    expect(runCli(ctx, ["init"]).exitCode).toBe(0);
    const afterInit = fs.readFileSync(ctx.packageManagerCliPath, "utf8");

    const second = runCli(ctx, ["reconcile"]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("bootstrap-hook already current");
    expect(fs.readFileSync(ctx.packageManagerCliPath, "utf8")).toBe(afterInit);
  });

  test("list uses the section output and shows applied patches", () => {
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });
    expect(runCli(ctx, ["init"]).exitCode).toBe(0);

    const result = runCli(ctx, ["list"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pi-patcher\n");
    expect(result.stdout).toContain("bootstrap-hook applied");
  });

  test("init re-seeds an internal patch whose working copy was deleted", () => {
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });
    expect(runCli(ctx, ["init"]).exitCode).toBe(0);
    expect(fs.existsSync(internalDir(ctx, "bootstrap-hook"))).toBe(true);

    // User nukes the working copy by hand and pi update rewrote the file.
    fs.rmSync(internalDir(ctx, "bootstrap-hook"), { recursive: true, force: true });
    fs.writeFileSync(ctx.packageManagerCliPath, originalPackageManagerCli);

    const result = runCli(ctx, ["init"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("seeded internal patch bootstrap-hook");
    expect(result.stdout).toContain("bootstrap-hook applied");
    expect(fs.existsSync(internalDir(ctx, "bootstrap-hook"))).toBe(true);
  });

  test("remove refuses an internal patch; it stays managed", () => {
    // bootstrap-hook is pi-patcher's own patch, not a user patch. `remove`
    // is user-only; tearing down the managed patch is `uninstall`'s job.
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });
    expect(runCli(ctx, ["init"]).exitCode).toBe(0);

    const result = runCli(ctx, ["remove", "bootstrap-hook"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("managed by pi-patcher");
    expect(fs.existsSync(internalDir(ctx, "bootstrap-hook"))).toBe(true);
  });

  test("reconcile without init is a no-op (refresh-only never seeds the internal patch)", () => {
    // The opt-in invariant under the internal-patches model: a bare
    // `reconcile` refreshes existing internal patches but never seeds from
    // absent, so an un-init'd install is untouched.
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });

    const result = runCli(ctx, ["reconcile"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("seeded internal patch");
    expect(result.stdout).not.toContain("applied bootstrap-hook");
    expect(fs.existsSync(internalDir(ctx, "bootstrap-hook"))).toBe(false);
    expect(fs.readFileSync(ctx.packageManagerCliPath, "utf8")).toBe(originalPackageManagerCli);
  });

  // ── remove ───────────────────────────────────────────────
  test("remove reverts a user patch, deletes the folder, and forgets state", () => {
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });
    fs.writeFileSync(path.join(ctx.piRoot, "dist", "user.js"), "const x = 1;\n");
    writePatch(ctx, "user-tweak", {
      files: [
        {
          target: "dist/user.js",
          replacements: [{ oldText: "const x = 1;\n", newText: "const x = 2;\n" }],
        },
      ],
    });
    expect(runCli(ctx, ["reconcile"]).exitCode).toBe(0);
    expect(fs.readFileSync(path.join(ctx.piRoot, "dist", "user.js"), "utf8")).toBe(
      "const x = 2;\n",
    );

    const result = runCli(ctx, ["remove", "user-tweak"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pi-patcher: reverted user-tweak");
    expect(result.stdout).toContain("pi-patcher: removed user-tweak");
    expect(fs.readFileSync(path.join(ctx.piRoot, "dist", "user.js"), "utf8")).toBe(
      "const x = 1;\n",
    );

    const patchesDir = path.join(ctx.home, ".pi", "patches");
    expect(fs.existsSync(path.join(patchesDir, "user-tweak"))).toBe(false);
    expect(readState(ctx).patches["user-tweak"]).toBeUndefined();
  });

  test("remove on a never-applied user patch deletes the folder cleanly", () => {
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });
    fs.writeFileSync(path.join(ctx.piRoot, "dist", "user.js"), "const x = 1;\n");
    writePatch(ctx, "user-tweak", {
      files: [
        {
          target: "dist/user.js",
          replacements: [{ oldText: "const x = 1;\n", newText: "const x = 2;\n" }],
        },
      ],
    });
    // Note: we do NOT run reconcile, so user-tweak is still pending.

    const result = runCli(ctx, ["remove", "user-tweak"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("reverted");
    expect(result.stdout).toContain("pi-patcher: removed user-tweak");
    expect(fs.readFileSync(path.join(ctx.piRoot, "dist", "user.js"), "utf8")).toBe(
      "const x = 1;\n",
    );
  });

  test("remove on a drifted user patch fails non-zero and leaves the folder alone", () => {
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });
    fs.writeFileSync(
      path.join(ctx.piRoot, "dist", "drifted.js"),
      'console.log("something else entirely");\n',
    );
    writePatch(ctx, "will-drift", {
      files: [
        {
          target: "dist/drifted.js",
          replacements: [
            {
              oldText: 'console.log("original");\n',
              newText: 'console.log("patched");\n',
            },
          ],
        },
      ],
    });

    const result = runCli(ctx, ["remove", "will-drift"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("drifted");
    expect(fs.readFileSync(path.join(ctx.piRoot, "dist", "drifted.js"), "utf8")).toBe(
      'console.log("something else entirely");\n',
    );
    expect(
      fs.existsSync(path.join(ctx.home, ".pi", "patches", "will-drift")),
    ).toBe(true);
  });

  // ── Tombstone escape hatch ───────────────────────────────
  test("an _<id>/ directory is skipped (manual tombstone escape hatch)", () => {
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });
    fs.writeFileSync(path.join(ctx.piRoot, "dist", "tomb.js"), "const x = 1;\n");
    writePatch(ctx, "tombstoned", {
      files: [
        {
          target: "dist/tomb.js",
          replacements: [{ oldText: "const x = 1;\n", newText: "const x = 2;\n" }],
        },
      ],
    });
    expect(runCli(ctx, ["reconcile"]).exitCode).toBe(0);
    expect(fs.readFileSync(path.join(ctx.piRoot, "dist", "tomb.js"), "utf8")).toBe(
      "const x = 2;\n",
    );

    // User manually disables the patch and restores the file by hand.
    const patchesDir = path.join(ctx.home, ".pi", "patches");
    fs.renameSync(
      path.join(patchesDir, "tombstoned"),
      path.join(patchesDir, "_tombstoned"),
    );
    fs.writeFileSync(path.join(ctx.piRoot, "dist", "tomb.js"), "const x = 1;\n");

    const result = runCli(ctx, ["reconcile"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("applied tombstoned");
    expect(fs.readFileSync(path.join(ctx.piRoot, "dist", "tomb.js"), "utf8")).toBe(
      "const x = 1;\n",
    );
  });

  // ── Apply / heal failure modes ───────────────────────────
  test("a clean-apply syntax failure rolls the target file back", () => {
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });
    const badTarget = path.join(ctx.piRoot, "dist", "bad.js");
    fs.writeFileSync(badTarget, "const x = 1;\n");
    writePatch(ctx, "bad-syntax", {
      files: [
        {
          target: "dist/bad.js",
          replacements: [{ oldText: "const x = 1;\n", newText: "const = ;\n" }],
        },
      ],
    });

    const result = runCli(ctx, ["reconcile"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("bad-syntax failed:");
    expect(fs.readFileSync(badTarget, "utf8")).toBe("const x = 1;\n");
  });

  test("a replacement that can't anchor fails the patch and rolls back already-written files", () => {
    // No silent partial apply: file-a applies cleanly and is written, then
    // file-b's second replacement can't anchor (its oldText was consumed by
    // the first). The whole patch must fail and file-a must be restored.
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });
    const aPath = path.join(ctx.piRoot, "dist", "a.js");
    const bPath = path.join(ctx.piRoot, "dist", "b.js");
    fs.writeFileSync(aPath, "const a = 1;\n");
    fs.writeFileSync(bPath, "// dup\n");
    writePatch(ctx, "twin-fail", {
      files: [
        {
          target: "dist/a.js",
          replacements: [{ oldText: "const a = 1;\n", newText: "const a = 2;\n" }],
        },
        {
          // Both replacements share the same oldText. statusOf sees each as
          // pending against the original, but after the first applies the
          // second has nothing left to match.
          target: "dist/b.js",
          replacements: [
            { oldText: "// dup\n", newText: "// one\n" },
            { oldText: "// dup\n", newText: "// two\n" },
          ],
        },
      ],
    });

    const result = runCli(ctx, ["reconcile"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("twin-fail failed:");
    expect(result.stdout).toContain("expected exactly one occurrence of oldText");
    // file-a was written then rolled back; file-b was never touched.
    expect(fs.readFileSync(aPath, "utf8")).toBe("const a = 1;\n");
    expect(fs.readFileSync(bPath, "utf8")).toBe("// dup\n");
    expect(readState(ctx).patches["twin-fail"].lastError).toContain(
      "cannot apply a replacement",
    );
  });

  test("an aborted heal during reconcile is saved in state", () => {
    const drifted = `async function update() {\n  console.log("updated pi");\n}\n`;
    const reason = "upstream moved the update flow into a different file and restoring the patch would require editing outside the constrained target file";
    const ctx = makeFakePi({
      packageManagerCli: drifted,
      healScript: `printf "===ABORT===\\n${reason}\\n===END===\\n"\nexit 0`,
    });
    // Install bootstrap-hook into the patches dir without applying it
    // (the file is already drifted, so `init` would route through heal).
    copyBundledPatch(ctx, "bootstrap-hook");

    const result = runCli(ctx, ["reconcile"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Reason: upstream moved the update flow");
    expect(result.stdout).toContain("\n            ");
    expect(result.stdout).not.toContain("===ABORT===");
    expect(result.stdout.match(/upstream moved the update flow/g)?.length).toBe(1);
    expect(fs.readFileSync(ctx.packageManagerCliPath, "utf8")).toBe(drifted);
    const state = JSON.parse(
      fs.readFileSync(path.join(ctx.home, ".pi", "pi-patcher", "state.json"), "utf8"),
    );
    expect(state.patches["bootstrap-hook"].lastError).toBe(reason);
    expect(state.patches["bootstrap-hook"].lastSessions[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.stdout).toContain(
      `Inspect: pi --session ${state.patches["bootstrap-hook"].lastSessions[0]}`,
    );
  });

  // ── Tier 2: cross-file retarget ──────────────────────────
  test("heal retargets a patch to a sibling file when the anchor moved", () => {
    // The declared target no longer holds the anchor. It moved, unchanged,
    // into a sibling file under the same package. The agent rewrites the
    // spec's target itself; pi-patcher applies the retargeted spec.
    const ctx = makeFakePi({
      packageManagerCli: originalPackageManagerCli,
      healScript: [
        "PROMPT=$(cat)",
        'SPEC=$(printf "%s" "$PROMPT" | sed -n "s/^Patch spec file: //p" | head -n1)',
        'printf "===PLAN===\\nretarget\\n===END===\\n"',
        `printf '%s' '{"version":1,"files":[{"target":"dist/moved-new.js","replacements":[{"oldText":"export const moved = 1;\\n","newText":"export const moved = 2;\\n"}]}]}' > "$SPEC"`,
        "exit 0",
      ].join("\n"),
    });
    fs.writeFileSync(path.join(ctx.piRoot, "dist", "moved-old.js"), "// the code moved away\n");
    fs.writeFileSync(path.join(ctx.piRoot, "dist", "moved-new.js"), "export const moved = 1;\n");
    writePatch(ctx, "moved", {
      files: [
        {
          target: "dist/moved-old.js",
          replacements: [
            { oldText: "export const moved = 1;\n", newText: "export const moved = 2;\n" },
          ],
        },
      ],
    });

    const result = runCli(ctx, ["reconcile"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("moved healed");
    expect(fs.readFileSync(path.join(ctx.piRoot, "dist", "moved-new.js"), "utf8")).toBe(
      "export const moved = 2;\n",
    );
    // The old target is left untouched; the spec now points at the new file.
    expect(fs.readFileSync(path.join(ctx.piRoot, "dist", "moved-old.js"), "utf8")).toBe(
      "// the code moved away\n",
    );
    const spec = JSON.parse(
      fs.readFileSync(path.join(ctx.home, ".pi", "patches", "moved", "spec.json"), "utf8"),
    );
    expect(spec.files[0].target).toBe("dist/moved-new.js");
    expect(spec.files[0].replacements[0].newText).toBe("export const moved = 2;\n");
  });

  // ── Tier 3: redesign routing ─────────────────────────────
  test("reconcile --redesign autonomously re-authors an aborted patch and applies it", () => {
    const ctx = makeFakePi({
      packageManagerCli: originalPackageManagerCli,
      healScript: [
        "PROMPT=$(cat)",
        'case "$PROMPT" in',
        '  *"You are redesigning"*)',
        '    SPEC=$(printf "%s" "$PROMPT" | sed -n "s/^Patch spec file: //p" | head -n1)',
        `    printf '%s' '{"version":1,"files":[{"target":"dist/redesign-target.js","replacements":[{"oldText":"const v = \\"new-shape\\";\\n","newText":"const v = \\"redesigned\\";\\n"}]}]}' > "$SPEC"`,
        '    printf "===PLAN===\\nrework\\n===END===\\n"',
        "    exit 0;;",
        "  *)",
        '    printf "===ABORT===\\nneeds redesign\\n===END===\\n"',
        "    exit 0;;",
        "esac",
      ].join("\n"),
    });
    fs.writeFileSync(
      path.join(ctx.piRoot, "dist", "redesign-target.js"),
      'const v = "new-shape";\n',
    );
    writePatch(ctx, "shape", {
      files: [
        {
          target: "dist/redesign-target.js",
          replacements: [
            { oldText: 'const v = "old";\n', newText: 'const v = "patched";\n' },
          ],
        },
      ],
    });

    const result = runCli(ctx, ["reconcile", "--redesign"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("shape redesigned");
    expect(result.stdout).toContain("1 redesigned");
    expect(fs.readFileSync(path.join(ctx.piRoot, "dist", "redesign-target.js"), "utf8")).toBe(
      'const v = "redesigned";\n',
    );
    expect(readState(ctx).patches["shape"].needsRedesign).toBeUndefined();
  });

  test("reconcile --prompt prints a redesign prompt and leaves the patch for the user", () => {
    const ctx = makeFakePi({
      packageManagerCli: originalPackageManagerCli,
      healScript: 'printf "===ABORT===\\nneeds redesign\\n===END===\\n"\nexit 0',
    });
    fs.writeFileSync(path.join(ctx.piRoot, "dist", "hand.js"), "const x = 9;\n");
    writePatch(ctx, "handoff", {
      files: [
        {
          target: "dist/hand.js",
          replacements: [{ oldText: "const x = 1;\n", newText: "const x = 2;\n" }],
        },
      ],
    });

    const result = runCli(ctx, ["reconcile", "--prompt"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("You are redesigning");
    expect(result.stdout).toContain("Patch id: handoff");
    expect(result.stdout).toContain("1 need redesign");
    // Untouched: the user drives the fix themselves.
    expect(fs.readFileSync(path.join(ctx.piRoot, "dist", "hand.js"), "utf8")).toBe("const x = 9;\n");
    expect(readState(ctx).patches["handoff"].needsRedesign).toBe(true);
  });

  test("list flags a patch that needs a redesign", () => {
    const ctx = makeFakePi({
      packageManagerCli: originalPackageManagerCli,
      healScript: 'printf "===ABORT===\\nneeds redesign\\n===END===\\n"\nexit 0',
    });
    fs.writeFileSync(path.join(ctx.piRoot, "dist", "flag.js"), "const x = 9;\n");
    writePatch(ctx, "flagged", {
      files: [
        {
          target: "dist/flag.js",
          replacements: [{ oldText: "const x = 1;\n", newText: "const x = 2;\n" }],
        },
      ],
    });
    expect(runCli(ctx, ["reconcile"]).exitCode).toBe(1);

    const result = runCli(ctx, ["list"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("flagged needs redesign");
  });

  test("heal surfaces the agent's plan as a resolved step while it works", () => {
    const ctx = makeFakePi({
      packageManagerCli: originalPackageManagerCli,
      healScript: [
        "PROMPT=$(cat)",
        'SPEC=$(printf "%s" "$PROMPT" | sed -n "s/^Patch spec file: //p" | head -n1)',
        'printf "===PLAN===\\nRelocating the greeting constant.\\n===END===\\n"',
        `printf '%s' '{"version":1,"files":[{"target":"dist/plan.js","replacements":[{"oldText":"const g = \\"drifted\\";\\n","newText":"const g = \\"healed\\";\\n"}]}]}' > "$SPEC"`,
        "exit 0",
      ].join("\n"),
    });
    fs.writeFileSync(path.join(ctx.piRoot, "dist", "plan.js"), 'const g = "drifted";\n');
    writePatch(ctx, "planme", {
      files: [
        {
          target: "dist/plan.js",
          replacements: [{ oldText: 'const g = "orig";\n', newText: 'const g = "patched";\n' }],
        },
      ],
    });

    const result = runCli(ctx, ["reconcile"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("planning planme");
    expect(result.stdout).toContain("Relocating the greeting constant.");
    expect(result.stdout).toContain("rewriting planme's spec");
    expect(result.stdout).toContain("planme healed");
    expect(fs.readFileSync(path.join(ctx.piRoot, "dist", "plan.js"), "utf8")).toBe(
      'const g = "healed";\n',
    );
  });

  // ── The spec-writing contract ────────────────────────────
  test("scratch edits in the source are reverted; only the rewritten spec is durable", () => {
    // The agent may trial its change in the source (edit files, create new
    // ones), but pi-patcher restores everything except the spec, then applies
    // the spec mechanically from the clean base.
    const ctx = makeFakePi({
      packageManagerCli: originalPackageManagerCli,
      healScript: [
        "PROMPT=$(cat)",
        'SPEC=$(printf "%s" "$PROMPT" | sed -n "s/^Patch spec file: //p" | head -n1)',
        'ROOT=$(printf "%s" "$PROMPT" | sed -n "s/^Package root: //p" | head -n1)',
        'printf "===PLAN===\\ntrial in source, then rewrite the spec\\n===END===\\n"',
        `printf 'const s = "scratch";\\n' > "$ROOT/dist/sibling.js"`,
        `printf 'left behind\\n' > "$ROOT/dist/scratch-file.js"`,
        `printf '%s' '{"version":1,"files":[{"target":"dist/scratchy.js","replacements":[{"oldText":"const v = \\"drifted\\";\\n","newText":"const v = \\"healed\\";\\n"}]}]}' > "$SPEC"`,
        "exit 0",
      ].join("\n"),
    });
    fs.writeFileSync(path.join(ctx.piRoot, "dist", "scratchy.js"), 'const v = "drifted";\n');
    fs.writeFileSync(path.join(ctx.piRoot, "dist", "sibling.js"), 'const s = "orig";\n');
    writePatch(ctx, "scratchy", {
      files: [
        {
          target: "dist/scratchy.js",
          replacements: [{ oldText: 'const v = "orig";\n', newText: 'const v = "patched";\n' }],
        },
      ],
    });

    const result = runCli(ctx, ["reconcile"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("scratchy healed");
    expect(fs.readFileSync(path.join(ctx.piRoot, "dist", "scratchy.js"), "utf8")).toBe(
      'const v = "healed";\n',
    );
    // The trial edit is rolled back and the created file is deleted.
    expect(fs.readFileSync(path.join(ctx.piRoot, "dist", "sibling.js"), "utf8")).toBe(
      'const s = "orig";\n',
    );
    expect(fs.existsSync(path.join(ctx.piRoot, "dist", "scratch-file.js"))).toBe(false);
  });

  test("a spec that fails verification is retried once in the same session", () => {
    // Attempt 1 writes a spec that can't anchor; pi-patcher resumes the same
    // session with the exact failure, and attempt 2 fixes the spec.
    const ctx = makeFakePi({
      packageManagerCli: originalPackageManagerCli,
      healScript: [
        "PROMPT=$(cat)",
        'SPEC=$(printf "%s" "$PROMPT" | sed -n "s/^Patch spec file: //p" | head -n1)',
        'echo "$5" >> "$HOME/session-ids.txt"',
        'if [ -f "$HOME/attempt-1" ]; then',
        '  printf "%s" "$PROMPT" > "$HOME/retry-prompt.txt"',
        '  SPEC=$(cat "$HOME/spec-path.txt")',
        `  printf '%s' '{"version":1,"files":[{"target":"dist/retry.js","replacements":[{"oldText":"const r = \\"drifted\\";\\n","newText":"const r = \\"healed\\";\\n"}]}]}' > "$SPEC"`,
        "else",
        '  touch "$HOME/attempt-1"',
        '  printf "%s" "$SPEC" > "$HOME/spec-path.txt"',
        '  printf "===PLAN===\\nfirst try\\n===END===\\n"',
        `  printf '%s' '{"version":1,"files":[{"target":"dist/retry.js","replacements":[{"oldText":"no such anchor\\n","newText":"const r = \\"healed\\";\\n"}]}]}' > "$SPEC"`,
        "fi",
        "exit 0",
      ].join("\n"),
    });
    fs.writeFileSync(path.join(ctx.piRoot, "dist", "retry.js"), 'const r = "drifted";\n');
    writePatch(ctx, "retry", {
      files: [
        {
          target: "dist/retry.js",
          replacements: [{ oldText: 'const r = "orig";\n', newText: 'const r = "patched";\n' }],
        },
      ],
    });

    const result = runCli(ctx, ["reconcile"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("retry attempt 1 did not verify; retrying");
    expect(result.stdout).toContain("retry healed");
    expect(fs.readFileSync(path.join(ctx.piRoot, "dist", "retry.js"), "utf8")).toBe(
      'const r = "healed";\n',
    );
    // Same session resumed, corrective prompt carries the exact failure.
    const sessions = fs
      .readFileSync(path.join(ctx.home, "session-ids.txt"), "utf8")
      .trim()
      .split("\n");
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toBe(sessions[1]);
    const retryPrompt = fs.readFileSync(path.join(ctx.home, "retry-prompt.txt"), "utf8");
    expect(retryPrompt).toContain("did not verify");
    expect(retryPrompt).toContain("the rewritten spec did not apply");
  });

  test("a spec that still fails after the retry is rolled back entirely", () => {
    const ctx = makeFakePi({
      packageManagerCli: originalPackageManagerCli,
      healScript: [
        "PROMPT=$(cat)",
        'SPEC=$(printf "%s" "$PROMPT" | sed -n "s/^Patch spec file: //p" | head -n1)',
        '[ -f "$HOME/spec-path.txt" ] && SPEC=$(cat "$HOME/spec-path.txt")',
        'printf "%s" "$SPEC" > "$HOME/spec-path.txt"',
        `printf '%s' '{"version":1,"files":[{"target":"dist/hopeless.js","replacements":[{"oldText":"no such anchor\\n","newText":"const h = \\"healed\\";\\n"}]}]}' > "$SPEC"`,
        "exit 0",
      ].join("\n"),
    });
    fs.writeFileSync(path.join(ctx.piRoot, "dist", "hopeless.js"), 'const h = "drifted";\n');
    writePatch(ctx, "hopeless", {
      files: [
        {
          target: "dist/hopeless.js",
          replacements: [{ oldText: 'const h = "orig";\n', newText: 'const h = "patched";\n' }],
        },
      ],
    });
    const specPath = path.join(ctx.home, ".pi", "patches", "hopeless", "spec.json");
    const specBefore = fs.readFileSync(specPath, "utf8");

    const result = runCli(ctx, ["reconcile"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("hopeless not healed");
    expect(result.stdout).toContain("the rewritten spec did not apply");
    // Both the spec and the target are back to where they started.
    expect(fs.readFileSync(specPath, "utf8")).toBe(specBefore);
    expect(fs.readFileSync(path.join(ctx.piRoot, "dist", "hopeless.js"), "utf8")).toBe(
      'const h = "drifted";\n',
    );
    expect(readState(ctx).patches["hopeless"].lastError).toContain(
      "the rewritten spec did not apply",
    );
  });

  // ── Heal correctness ─────────────────────────────────────
  test("heal applies a multi-replacement spec, leaving already-applied entries alone", () => {
    // The file already has replacement[0] applied while [1] drifted. The
    // agent rewrites the whole spec; on apply, [0] classifies as applied and
    // is skipped, [1] anchors against the drifted text and is applied.
    const fileText =
      `console.log("alpha-applied");\n` +
      `console.log("beta-drifted-zone");\n`;
    const ctx = makeFakePi({
      packageManagerCli: originalPackageManagerCli,
      healScript: [
        "PROMPT=$(cat)",
        'SPEC=$(printf "%s" "$PROMPT" | sed -n "s/^Patch spec file: //p" | head -n1)',
        'printf "===PLAN===\\nrewrite beta zone\\n===END===\\n"',
        `printf '%s' '{"version":1,"files":[{"target":"dist/multi.js","replacements":[{"oldText":"console.log(\\"alpha-original\\");\\n","newText":"console.log(\\"alpha-applied\\");\\n"},{"oldText":"console.log(\\"beta-drifted-zone\\");\\n","newText":"console.log(\\"beta-healed\\");\\n"}]}]}' > "$SPEC"`,
        "exit 0",
      ].join("\n"),
    });

    fs.writeFileSync(path.join(ctx.piRoot, "dist", "multi.js"), fileText);
    writePatch(ctx, "multi", {
      files: [
        {
          target: "dist/multi.js",
          replacements: [
            {
              oldText: 'console.log("alpha-original");\n',
              newText: 'console.log("alpha-applied");\n',
            },
            {
              oldText: 'console.log("beta-original");\n',
              newText: 'console.log("beta-applied");\n',
            },
          ],
        },
      ],
    });

    const result = runCli(ctx, ["reconcile"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("multi drifted");
    expect(result.stdout).toContain("multi healed");

    const patched = fs.readFileSync(
      path.join(ctx.piRoot, "dist", "multi.js"),
      "utf8",
    );
    expect(patched).toContain('console.log("alpha-applied");');
    expect(patched).toContain('console.log("beta-healed");');

    const spec = JSON.parse(
      fs.readFileSync(
        path.join(ctx.home, ".pi", "patches", "multi", "spec.json"),
        "utf8",
      ),
    );
    expect(spec.files[0].replacements[0].newText).toBe(
      'console.log("alpha-applied");\n',
    );
    expect(spec.files[0].replacements[1].newText).toContain("beta-healed");
  });

  test("PATCH.md patches apply from fenced edits with file metadata", () => {
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });
    const target = path.join(ctx.piRoot, "dist", "patch-md.js");
    fs.writeFileSync(target, "const value = 1;\n");
    writePatchMd(
      ctx,
      "patch-md",
      `---
id: patch-md
summary: freeform markdown patch
version: 0.1.0
lastUpdated: 2026-06-25
---

# Freeform patch

Any prose works here; no required section names.

This example fence is prose, not a mechanical edit, because it has no file metadata:

\`\`\`diff
@@ example only @@
old
+new
\`\`\`

\`\`\`diff file=dist/patch-md.js
-const value = 1;
+const value = 2;
\`\`\`
`,
    );

    const result = runCli(ctx, ["reconcile"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("patch-md applied");
    expect(fs.readFileSync(target, "utf8")).toBe("const value = 2;\n");
  });

  test("heal prompt is seeded from the PATCH.md source of truth", () => {
    const ctx = makeFakePi({
      packageManagerCli: originalPackageManagerCli,
      healScript: [
        'cat > "$HOME/heal-prompt.txt"',
        'printf "===ABORT===\\ncaptured prompt\\n===END===\\n"',
        "exit 0",
      ].join("\n"),
    });
    const target = path.join(ctx.piRoot, "dist", "prompt-source.js");
    fs.writeFileSync(target, "const value = 3;\n");
    writePatchMd(
      ctx,
      "prompt-source",
      `---
id: prompt-source
summary: prompt should include full PATCH.md
---

# Prompt source

This prose is the source of truth for healing.

\`\`\`diff file=dist/prompt-source.js
-const value = 1;
+const value = 2;
\`\`\`
`,
    );

    const result = runCli(ctx, ["reconcile"]);

    expect(result.exitCode).toBe(1);
    const prompt = fs.readFileSync(path.join(ctx.home, "heal-prompt.txt"), "utf8");
    expect(prompt).toContain("Use the patch spec as the source of truth");
    expect(prompt).toContain(
      `Patch spec file: ${path.join(ctx.home, ".pi", "patches", "prompt-source", "PATCH.md")}`,
    );
    expect(prompt).toContain("# Prompt source");
    expect(prompt).toContain("This prose is the source of truth for healing.");
    expect(prompt).toContain("```diff file=dist/prompt-source.js");
    expect(prompt).not.toContain("{{");
    expect(prompt).not.toContain('"oldText"');
  });

  test("an agent-rewritten PATCH.md is applied verbatim, prose and all", () => {
    const ctx = makeFakePi({
      packageManagerCli: originalPackageManagerCli,
      healScript: [
        "PROMPT=$(cat)",
        'SPEC=$(printf "%s" "$PROMPT" | sed -n "s/^Patch spec file: //p" | head -n1)',
        'printf "===PLAN===\\nrewrite md patch zone\\n===END===\\n"',
        'cat > "$SPEC" <<\'EOF\'',
        "---",
        "id: patch-md-heal",
        "summary: heal markdown patch",
        "---",
        "",
        "# Heal me",
        "",
        "Prose that should survive a healed edit.",
        "",
        "```patch file=dist/patch-md-heal.js",
        "<<<<<<< SEARCH",
        "const value = 3;",
        "=======",
        "const value = 4;",
        ">>>>>>> REPLACE",
        "```",
        "EOF",
        "exit 0",
      ].join("\n"),
    });
    const target = path.join(ctx.piRoot, "dist", "patch-md-heal.js");
    fs.writeFileSync(target, "const value = 3;\n");
    writePatchMd(
      ctx,
      "patch-md-heal",
      `---
id: patch-md-heal
summary: heal markdown patch
version: 0.1.0
lastUpdated: 2026-06-25
---

# Heal me

Prose that should survive a healed edit.

\`\`\`patch file=dist/patch-md-heal.js
<<<<<<< SEARCH
const value = 1;
=======
const value = 2;
>>>>>>> REPLACE
\`\`\`
`,
    );

    const result = runCli(ctx, ["reconcile"]);

    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe("const value = 4;\n");
    const patchMd = fs.readFileSync(
      path.join(ctx.home, ".pi", "patches", "patch-md-heal", "PATCH.md"),
      "utf8",
    );
    expect(patchMd).toContain("Prose that should survive");
    expect(patchMd).toContain("```patch file=dist/patch-md-heal.js");
    expect(patchMd).toContain("const value = 3;");
    expect(patchMd).toContain("const value = 4;");
  });

  test("text-only targets (.md) apply without validation", () => {
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });
    const promptPath = path.join(ctx.piRoot, "dist", "system-prompt.md");
    fs.writeFileSync(
      promptPath,
      "You are a coding agent.\nBe terse and accurate.\n",
    );
    writePatch(ctx, "prompt-tweak", {
      files: [
        {
          target: "dist/system-prompt.md",
          replacements: [
            {
              oldText: "Be terse and accurate.\n",
              newText: "Be terse and accurate. Always use British spelling.\n",
            },
          ],
        },
      ],
    });

    const result = runCli(ctx, ["reconcile"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("prompt-tweak applied");
    expect(fs.readFileSync(promptPath, "utf8")).toBe(
      "You are a coding agent.\nBe terse and accurate. Always use British spelling.\n",
    );
  });

  // ── Uninstall ────────────────────────────────────────────
  test("uninstall reverts every patch and invokes `npm uninstall -g pi-patcher`", () => {
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });
    fs.writeFileSync(path.join(ctx.piRoot, "dist", "extra.js"), "const x = 1;\n");
    writePatch(ctx, "user-tweak", {
      files: [
        {
          target: "dist/extra.js",
          replacements: [{ oldText: "const x = 1;\n", newText: "const x = 2;\n" }],
        },
      ],
    });
    expect(runCli(ctx, ["init"]).exitCode).toBe(0);

    const result = runCli(ctx, ["uninstall"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("bootstrap-hook reverted");
    expect(result.stdout).toContain("user-tweak reverted");
    expect(result.stdout).toContain("npm uninstall -g pi-patcher");
    expect(result.stdout).toContain("fake npm: uninstall -g pi-patcher");

    expect(fs.readFileSync(ctx.packageManagerCliPath, "utf8")).toBe(originalPackageManagerCli);
    expect(fs.readFileSync(path.join(ctx.piRoot, "dist", "extra.js"), "utf8")).toBe(
      "const x = 1;\n",
    );

    const patchesDir = path.join(ctx.home, ".pi", "patches");
    expect(fs.existsSync(path.join(patchesDir, "user-tweak"))).toBe(false);
    // The managed patch is deleted from internal-patches/ and its baseSha cleared.
    expect(fs.existsSync(internalDir(ctx, "bootstrap-hook"))).toBe(false);
    const state = readState(ctx);
    expect(state.patches["bootstrap-hook"]).toBeUndefined();
    expect(state.patches["user-tweak"]).toBeUndefined();
    expect(state.internalBaseShas).toBeUndefined();
  });

  test("uninstall skips drifted patches with a warning, still succeeds, still uninstalls", () => {
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });
    fs.writeFileSync(
      path.join(ctx.piRoot, "dist", "drifted.js"),
      'console.log("something else entirely");\n',
    );
    writePatch(ctx, "will-drift", {
      files: [
        {
          target: "dist/drifted.js",
          replacements: [
            {
              oldText: 'console.log("original");\n',
              newText: 'console.log("patched");\n',
            },
          ],
        },
      ],
    });

    const result = runCli(ctx, ["uninstall"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("will-drift skipped (drifted");
    expect(result.stdout).toContain("with caveats");
    expect(result.stdout).toContain("fake npm: uninstall -g pi-patcher");
    expect(fs.readFileSync(path.join(ctx.piRoot, "dist", "drifted.js"), "utf8")).toBe(
      'console.log("something else entirely");\n',
    );
    expect(
      fs.existsSync(path.join(ctx.home, ".pi", "patches", "will-drift")),
    ).toBe(false);
  });

  // ── Validation ───────────────────────────────────────────
  test("a spec with empty newText is rejected at load time", () => {
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });
    writePatch(ctx, "deletion-attempt", {
      files: [
        {
          target: "dist/package-manager-cli.js",
          replacements: [
            {
              oldText: '                    console.log(chalk.green(`Updated ${APP_NAME}`));\n',
              newText: "",
            },
          ],
        },
      ],
    });

    const result = runCli(ctx, ["list"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("empty newText");
  });

  // ── Internal patch auto-refresh (Option A) ───────────────
  // These drive sync against a fixture bundled dir (PI_PATCHER_BUNDLED_DIR)
  // so the "bundled" spec can change between runs without touching the repo.
  const FIXTURE_V1 = {
    version: 1,
    files: [
      {
        target: "dist/fixture.js",
        replacements: [
          { oldText: 'const g = "hi";\n', newText: 'const g = "hello";\n' },
        ],
      },
    ],
  };

  function makeFixtureCtx() {
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });
    fs.writeFileSync(path.join(ctx.piRoot, "dist", "fixture.js"), 'const g = "hi";\n');
    const bundle = makeBundleDir();
    writeBundledPatch(bundle, "fixturehook", FIXTURE_V1);
    return { ctx, bundle, env: { PI_PATCHER_BUNDLED_DIR: bundle } };
  }

  test("reconcile refreshes an untouched internal patch when a newer bundled spec ships", () => {
    const { ctx, bundle, env } = makeFixtureCtx();
    expect(runCli(ctx, ["init"], env).exitCode).toBe(0);
    const baseSha = readState(ctx).internalBaseShas["fixturehook"];
    expect(baseSha).toMatch(/^[0-9a-f]{64}$/);

    // Ship a fix: same apply effect (still applied → no re-edit) but new spec bytes.
    const v2 = structuredClone(FIXTURE_V1);
    v2.files[0].replacements[0].anchorHint = "shipped fix marker";
    writeBundledPatch(bundle, "fixturehook", v2);

    const result = runCli(ctx, ["reconcile"], env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("refreshed internal patch fixturehook (shipped update)");
    const workingSpec = fs.readFileSync(
      path.join(internalDir(ctx, "fixturehook"), "spec.json"),
      "utf8",
    );
    expect(workingSpec).toContain("shipped fix marker");
    expect(readState(ctx).internalBaseShas["fixturehook"]).not.toBe(baseSha);
  });

  test("reconcile preserves a locally-healed internal patch even when the bundled spec changed", () => {
    const { ctx, bundle, env } = makeFixtureCtx();
    expect(runCli(ctx, ["init"], env).exitCode).toBe(0);
    const baseSha = readState(ctx).internalBaseShas["fixturehook"];

    // Simulate a local heal: the working spec diverges from baseSha.
    const healed = structuredClone(FIXTURE_V1);
    healed.files[0].replacements[0].anchorHint = "locally healed";
    fs.writeFileSync(
      path.join(internalDir(ctx, "fixturehook"), "spec.json"),
      `${JSON.stringify(healed, null, 2)}\n`,
    );
    // And the bundled spec also moved on.
    const v2 = structuredClone(FIXTURE_V1);
    v2.files[0].replacements[0].anchorHint = "shipped fix marker";
    writeBundledPatch(bundle, "fixturehook", v2);

    const result = runCli(ctx, ["reconcile"], env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("refreshed internal patch fixturehook");
    const workingSpec = fs.readFileSync(
      path.join(internalDir(ctx, "fixturehook"), "spec.json"),
      "utf8",
    );
    expect(workingSpec).toContain("locally healed");
    expect(workingSpec).not.toContain("shipped fix marker");
    // baseSha is unchanged (we never refreshed).
    expect(readState(ctx).internalBaseShas["fixturehook"]).toBe(baseSha);
  });

  test("reconcile does not rewrite an internal patch that is already current", () => {
    const { ctx, env } = makeFixtureCtx();
    expect(runCli(ctx, ["init"], env).exitCode).toBe(0);
    const before = fs.readFileSync(
      path.join(internalDir(ctx, "fixturehook"), "spec.json"),
      "utf8",
    );

    const result = runCli(ctx, ["reconcile"], env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("refreshed internal patch fixturehook");
    expect(
      fs.readFileSync(
        path.join(internalDir(ctx, "fixturehook"), "spec.json"),
        "utf8",
      ),
    ).toBe(before);
  });

  // ── Bundled spec ESM validity (static) ───────────────────
  test("bundled bootstrap-hook uses `await import`, never a bare require", () => {
    // Guards against regressing the original bug: pi's update output is ESM,
    // where `require` is undefined and the hook's try/catch swallows the
    // ReferenceError, silently never running reconcile.
    const patch = fs.readFileSync(
      path.join(repoRoot, "patches", "bootstrap-hook", "PATCH.md"),
      "utf8",
    );
    expect(patch).toContain("```diff file=dist/package-manager-cli.js");
    expect(patch).toContain("await import(");
    expect(patch).not.toMatch(/\brequire\(/);
  });
});

// ── Fake pi environment ──────────────────────────────────────
type FakePiContext = {
  home: string;
  piRoot: string;
  binDir: string;
  packageManagerCliPath: string;
};

function makeFakePi({
  packageManagerCli,
  healScript = 'printf "fake heal not implemented\\n" >&2\nexit 1',
}: {
  packageManagerCli: string;
  healScript?: string;
}): FakePiContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-patcher-test-"));
  cleanups.push(root);

  const home = path.join(root, "home");
  const piRoot = path.join(root, "fake-pi");
  const binDir = path.join(piRoot, "bin");
  fs.mkdirSync(path.join(piRoot, "dist"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(piRoot, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.0", type: "module" }),
  );
  const packageManagerCliPath = path.join(piRoot, "dist", "package-manager-cli.js");
  fs.writeFileSync(packageManagerCliPath, packageManagerCli);
  fs.writeFileSync(
    path.join(binDir, "pi"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pi 1.0.0"; exit 0; fi\nif [ "$1" = "-p" ]; then\n${healScript}\nfi\nprintf "unexpected pi args: %s\\n" "$*" >&2\nexit 1\n`,
    { mode: 0o755 },
  );
  // Fake npm so `pi-patcher uninstall` doesn't try to mutate the user's
  // real global packages during tests. Echoes its args and exits 0.
  fs.writeFileSync(
    path.join(binDir, "npm"),
    `#!/bin/sh\nprintf "fake npm: %s\\n" "$*"\nexit 0\n`,
    { mode: 0o755 },
  );

  return { home, piRoot, binDir, packageManagerCliPath };
}

function runCli(
  ctx: FakePiContext,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  return spawnCli(ctx, [process.execPath, "run", "src/cli.ts", ...args], extraEnv);
}

function runBundledCli(ctx: FakePiContext, args: string[]) {
  const dist = path.join(repoRoot, "dist", "cli.js");
  if (!fs.existsSync(dist))
    throw new Error(
      `dist/cli.js not found. The 'test' script runs 'bun run build' first; run that manually if invoking 'bun test' directly.`,
    );
  return spawnCli(ctx, ["node", dist, ...args]);
}

function spawnCli(
  ctx: FakePiContext,
  cmd: string[],
  extraEnv: Record<string, string> = {},
) {
  const result = Bun.spawnSync({
    cmd,
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: ctx.home,
      PATH: `${ctx.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

const internalDir = (ctx: FakePiContext, id: string) =>
  path.join(ctx.home, ".pi", "pi-patcher", "internal-patches", id);

const readState = (ctx: FakePiContext) =>
  JSON.parse(
    fs.readFileSync(
      path.join(ctx.home, ".pi", "pi-patcher", "state.json"),
      "utf8",
    ),
  );

/** Create a throwaway bundled-patches dir (pointed at via PI_PATCHER_BUNDLED_DIR). */
function makeBundleDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-patcher-bundle-"));
  cleanups.push(dir);
  return dir;
}

function writeBundledPatch(bundleDir: string, id: string, spec: unknown) {
  const dir = path.join(bundleDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "intent.md"), `bundled ${id}\n`);
  fs.writeFileSync(
    path.join(dir, "spec.json"),
    `${JSON.stringify(spec, null, 2)}\n`,
  );
}

function writePatch(ctx: FakePiContext, id: string, spec: unknown) {
  const dir = path.join(ctx.home, ".pi", "patches", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "intent.md"), `test patch ${id}\n`);
  fs.writeFileSync(path.join(dir, "spec.json"), `${JSON.stringify(spec, null, 2)}\n`);
}

function writePatchMd(ctx: FakePiContext, id: string, markdown: string) {
  const dir = path.join(ctx.home, ".pi", "patches", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "PATCH.md"), markdown);
}

/**
 * Copy a bundled patch from the repo's `patches/` dir into the fake pi
 * env's `~/.pi/patches/`. Used for tests that need the bundled patch
 * present but NOT yet applied, simulating "init has run, but the
 * file has since drifted."
 */
function copyBundledPatch(ctx: FakePiContext, id: string) {
  const src = path.join(repoRoot, "patches", id);
  const dst = path.join(ctx.home, ".pi", "patches", id);
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src))
    fs.copyFileSync(path.join(src, entry), path.join(dst, entry));
}

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { derivePatch } from "../src/patches.js";

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
    expect(result.stdout).toContain("pi-patcher: applied bootstrap-hook");
    expect(result.stdout).toContain("pi-patcher is wired into pi update");
    expect(result.stdout).toContain("To remove cleanly later, run: pi-patcher uninstall");

    const patched = fs.readFileSync(ctx.packageManagerCliPath, "utf8");
    expect(patched).toContain('import("node:child_process")');
    expect(patched).toContain('spawnSync("pi-patcher", ["reconcile"]');
    expect(patched).not.toContain("--after-update");
    expect(patched).not.toContain('require("child_process")');
  });

  test("the bundled dist/cli.js artifact runs the same init happy path", () => {
    // Guards against bundler regressions: bad import.meta.url resolution,
    // externalized dynamic imports, dropped chmod +x, etc.
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });

    const result = runBundledCli(ctx, ["init"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pi-patcher: applied bootstrap-hook");
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
    expect(fs.readFileSync(ctx.packageManagerCliPath, "utf8")).toBe(afterInit);
  });

  test("init is idempotent: re-running picks up missing bundled patches without clobbering", () => {
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });
    expect(runCli(ctx, ["init"]).exitCode).toBe(0);
    expect(runCli(ctx, ["remove", "bootstrap-hook"]).exitCode).toBe(0);
    expect(
      fs.existsSync(path.join(ctx.home, ".pi", "patches", "bootstrap-hook")),
    ).toBe(false);

    // pi update freshly rewrote the file; user re-runs init.
    fs.writeFileSync(ctx.packageManagerCliPath, originalPackageManagerCli);
    const result = runCli(ctx, ["init"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pi-patcher: applied bootstrap-hook");
    expect(
      fs.existsSync(path.join(ctx.home, ".pi", "patches", "bootstrap-hook")),
    ).toBe(true);
  });

  test("after remove, reconcile does NOT silently re-install the bundled patch", () => {
    // This is the new opt-in invariant: nothing auto-recreates patches the
    // user explicitly removed. `init` is the only path that copies bundled
    // patches in.
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });
    expect(runCli(ctx, ["init"]).exitCode).toBe(0);
    expect(runCli(ctx, ["remove", "bootstrap-hook"]).exitCode).toBe(0);

    // Simulate a subsequent `pi update`: file is fresh again, reconcile runs.
    fs.writeFileSync(ctx.packageManagerCliPath, originalPackageManagerCli);
    const result = runCli(ctx, ["reconcile"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("applied bootstrap-hook");
    expect(
      fs.existsSync(path.join(ctx.home, ".pi", "patches", "bootstrap-hook")),
    ).toBe(false);
    expect(fs.readFileSync(ctx.packageManagerCliPath, "utf8")).toBe(originalPackageManagerCli);
  });

  // ── remove ───────────────────────────────────────────────
  test("remove reverts the patch, deletes the folder, and forgets state", () => {
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });
    expect(runCli(ctx, ["init"]).exitCode).toBe(0);

    const result = runCli(ctx, ["remove", "bootstrap-hook"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pi-patcher: reverted bootstrap-hook");
    expect(result.stdout).toContain("pi-patcher: removed bootstrap-hook");
    expect(fs.readFileSync(ctx.packageManagerCliPath, "utf8")).toBe(originalPackageManagerCli);

    const patchesDir = path.join(ctx.home, ".pi", "patches");
    expect(fs.existsSync(path.join(patchesDir, "bootstrap-hook"))).toBe(false);
    const state = JSON.parse(
      fs.readFileSync(path.join(ctx.home, ".pi", "pi-patcher", "state.json"), "utf8"),
    );
    expect(state.patches["bootstrap-hook"]).toBeUndefined();
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
    expect(runCli(ctx, ["init"]).exitCode).toBe(0);

    // User manually disables the bundled patch.
    const patchesDir = path.join(ctx.home, ".pi", "patches");
    fs.renameSync(
      path.join(patchesDir, "bootstrap-hook"),
      path.join(patchesDir, "_bootstrap-hook"),
    );
    // And restores the file by hand.
    fs.writeFileSync(ctx.packageManagerCliPath, originalPackageManagerCli);

    const result = runCli(ctx, ["reconcile"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("applied bootstrap-hook");
    expect(fs.readFileSync(ctx.packageManagerCliPath, "utf8")).toBe(originalPackageManagerCli);
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
    expect(result.stdout).toContain("pi-patcher: bad-syntax failed:");
    expect(fs.readFileSync(badTarget, "utf8")).toBe("const x = 1;\n");
  });

  test("an aborted heal during reconcile is saved in state", () => {
    const drifted = `async function update() {\n  console.log("updated pi");\n}\n`;
    const ctx = makeFakePi({
      packageManagerCli: drifted,
      healScript: 'printf "===ABORT===\\nupstream moved the update flow\\n===END===\\n"\nexit 0',
    });
    // Install bootstrap-hook into the patches dir without applying it
    // (the file is already drifted, so `init` would route through heal).
    copyBundledPatch(ctx, "bootstrap-hook");

    const result = runCli(ctx, ["reconcile"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Reason: upstream moved the update flow");
    expect(fs.readFileSync(ctx.packageManagerCliPath, "utf8")).toBe(drifted);
    const state = JSON.parse(
      fs.readFileSync(path.join(ctx.home, ".pi", "pi-patcher", "state.json"), "utf8"),
    );
    expect(state.patches["bootstrap-hook"].lastError).toBe("upstream moved the update flow");
  });

  // ── Heal correctness ─────────────────────────────────────
  test("heal handles multi-replacement patches per-entry, leaving applied ones alone", () => {
    // The file already has replacement[0] applied. Replacement[1]'s old/new
    // text is nowhere to be found — drift. Heal must touch only [1] and
    // rewrite only [1] in the spec.
    const fileText =
      `console.log("alpha-applied");\n` +
      `console.log("beta-drifted-zone");\n`;
    const ctx = makeFakePi({
      packageManagerCli: originalPackageManagerCli,
      healScript: [
        "PROMPT=$(cat)",
        'TARGET=$(printf "%s" "$PROMPT" | sed -n "s/^Target file: //p" | head -n1)',
        'printf "===PLAN===\\nrewrite beta zone\\n===END===\\n"',
        `printf 'console.log("alpha-applied");\\nconsole.log("beta-healed");\\n' > "$TARGET"`,
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
    expect(result.stdout).toContain("multi (dist/multi.js#1) drifted");
    expect(result.stdout).toContain("multi (dist/multi.js#1) healed");
    expect(result.stdout).not.toContain("multi (dist/multi.js#0)");

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
    expect(result.stdout).toContain("pi-patcher: applied prompt-tweak");
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
    expect(result.stdout).toContain("pi-patcher: reverted bootstrap-hook");
    expect(result.stdout).toContain("pi-patcher: reverted user-tweak");
    expect(result.stdout).toContain("npm uninstall -g pi-patcher");
    expect(result.stdout).toContain("fake npm: uninstall -g pi-patcher");

    expect(fs.readFileSync(ctx.packageManagerCliPath, "utf8")).toBe(originalPackageManagerCli);
    expect(fs.readFileSync(path.join(ctx.piRoot, "dist", "extra.js"), "utf8")).toBe(
      "const x = 1;\n",
    );

    const patchesDir = path.join(ctx.home, ".pi", "patches");
    expect(fs.existsSync(path.join(patchesDir, "bootstrap-hook"))).toBe(false);
    expect(fs.existsSync(path.join(patchesDir, "user-tweak"))).toBe(false);
    const state = JSON.parse(
      fs.readFileSync(path.join(ctx.home, ".pi", "pi-patcher", "state.json"), "utf8"),
    );
    expect(state.patches["bootstrap-hook"]).toBeUndefined();
    expect(state.patches["user-tweak"]).toBeUndefined();
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
    expect(result.stdout).toContain("pi-patcher: skipped will-drift (drifted");
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
});

describe("derivePatch", () => {
  test("derives a minimal line-level replacement", () => {
    const before = "one\nfunction value() { return 1; }\ntwo\n";
    const after = "one\nfunction value() { return 2; }\ntwo\n";

    expect(derivePatch(before, after)).toEqual({
      oldText: "function value() { return 1; }\n",
      newText: "function value() { return 2; }\n",
    });
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

function runCli(ctx: FakePiContext, args: string[]) {
  return spawnCli(ctx, [process.execPath, "run", "src/cli.ts", ...args]);
}

function runBundledCli(ctx: FakePiContext, args: string[]) {
  const dist = path.join(repoRoot, "dist", "cli.js");
  if (!fs.existsSync(dist))
    throw new Error(
      `dist/cli.js not found. The 'test' script runs 'bun run build' first; run that manually if invoking 'bun test' directly.`,
    );
  return spawnCli(ctx, ["node", dist, ...args]);
}

function spawnCli(ctx: FakePiContext, cmd: string[]) {
  const result = Bun.spawnSync({
    cmd,
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: ctx.home,
      PATH: `${ctx.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
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

function writePatch(ctx: FakePiContext, id: string, spec: unknown) {
  const dir = path.join(ctx.home, ".pi", "patches", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "intent.md"), `test patch ${id}\n`);
  fs.writeFileSync(path.join(dir, "spec.json"), `${JSON.stringify(spec, null, 2)}\n`);
}

/**
 * Copy a bundled patch from the repo's `patches/` dir into the fake pi
 * env's `~/.pi/patches/`. Used for tests that need the bundled patch
 * present but NOT yet applied — i.e. simulating "init has run, but the
 * file has since drifted."
 */
function copyBundledPatch(ctx: FakePiContext, id: string) {
  const src = path.join(repoRoot, "patches", id);
  const dst = path.join(ctx.home, ".pi", "patches", id);
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src))
    fs.copyFileSync(path.join(src, entry), path.join(dst, entry));
}

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveSingleReplacement } from "../src/patches.js";

const repoRoot = path.resolve(import.meta.dir, "..");
const cleanups: string[] = [];

const originalPackageManagerCli = `async function update() {\n                    console.log(chalk.green(\`Updated \${APP_NAME}\`));\n}\n`;

afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("pi-patcher CLI", () => {
  test("reconcile applies the bundled ESM-safe update hook", () => {
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });

    const result = runCli(ctx, ["reconcile"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pi-patcher: applied bootstrap-hook");
    const patched = fs.readFileSync(ctx.packageManagerCliPath, "utf8");
    expect(patched).toContain('import("node:child_process")');
    expect(patched).toContain('spawnSync("pi-patcher", ["reconcile", "--after-update"]');
    expect(patched).not.toContain('require("child_process")');
  });

  test("remove tombstones a patch and the next reconcile reverses it", () => {
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });

    expect(runCli(ctx, ["reconcile"]).exitCode).toBe(0);
    expect(runCli(ctx, ["remove", "bootstrap-hook"]).exitCode).toBe(0);
    const result = runCli(ctx, ["reconcile"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pi-patcher: reversed bootstrap-hook");
    expect(fs.readFileSync(ctx.packageManagerCliPath, "utf8")).toBe(originalPackageManagerCli);
  });

  test("a clean-apply syntax failure rolls the target file back", () => {
    const ctx = makeFakePi({ packageManagerCli: originalPackageManagerCli });
    const badTarget = path.join(ctx.piRoot, "dist", "bad.js");
    fs.writeFileSync(badTarget, "const x = 1;\n");
    writePatch(ctx, "bad-syntax", {
      target: "dist/bad.js",
      replacements: [{ oldText: "const x = 1;\n", newText: "const = ;\n" }],
    });

    const result = runCli(ctx, ["reconcile"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("pi-patcher: bad-syntax failed:");
    expect(fs.readFileSync(badTarget, "utf8")).toBe("const x = 1;\n");
  });

  test("an aborted heal is saved in state and exits non-zero", () => {
    const drifted = `async function update() {\n  console.log("updated pi");\n}\n`;
    const ctx = makeFakePi({
      packageManagerCli: drifted,
      healScript: 'printf "===ABORT===\\nupstream moved the update flow\\n===END===\\n"\nexit 0',
    });

    const result = runCli(ctx, ["reconcile"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Reason: upstream moved the update flow");
    expect(fs.readFileSync(ctx.packageManagerCliPath, "utf8")).toBe(drifted);
    const state = JSON.parse(
      fs.readFileSync(path.join(ctx.home, ".pi", "pi-patcher", "state.json"), "utf8"),
    );
    expect(state.patches["bootstrap-hook"].lastError).toBe("upstream moved the update flow");
  });
});

describe("deriveSingleReplacement", () => {
  test("derives a minimal line-level replacement", () => {
    const before = "one\nfunction value() { return 1; }\ntwo\n";
    const after = "one\nfunction value() { return 2; }\ntwo\n";

    expect(deriveSingleReplacement(before, after)).toEqual({
      oldText: "function value() { return 1; }\n",
      newText: "function value() { return 2; }\n",
    });
  });
});

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

  return { home, piRoot, binDir, packageManagerCliPath };
}

function runCli(ctx: FakePiContext, args: string[]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", "src/cli.ts", ...args],
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
  const dir = path.join(ctx.home, ".pi", "pi-patcher", "patches", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "intent.md"), `test patch ${id}\n`);
  fs.writeFileSync(path.join(dir, "spec.json"), `${JSON.stringify(spec, null, 2)}\n`);
}

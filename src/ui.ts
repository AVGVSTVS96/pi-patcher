import { spawnSync } from "node:child_process";

const useColor = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);

function color(code: number, text: string): string {
  return useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const ui = {
  dim: (text: string) => color(2, text),
  green: (text: string) => color(32, text),
  yellow: (text: string) => color(33, text),
  red: (text: string) => color(31, text),
  cyan: (text: string) => color(36, text),
};

export function logHeader(): void {
  console.log("pi-patcher");
}

export function logApplied(id: string): void {
  console.log(`  ${ui.green("✓")} ${id} applied`);
}

export function logSuccess(message: string): void {
  console.log(`  ${ui.green("✓")} ${message}`);
}

export function logWarn(message: string): void {
  console.log(`  ${ui.yellow("⚠")} ${message}`);
}

export function logFailure(message: string): void {
  console.log(`  ${ui.red("✗")} ${message}`);
}

export function logInfo(message: string): void {
  console.log(`  ${ui.dim("•")} ${message}`);
}

export function logDetail(message: string): void {
  console.log(`    ${message}`);
}

/**
 * A completed sub-step: `    ✓ <text>`, wrapped with a hanging indent.
 * Used to commit the agent's plan as the resolved "planning" step while the
 * next step keeps spinning below it.
 */
export function logStepDone(text: string): void {
  const firstPrefix = `    ${ui.green("✓")} `;
  const nextPrefix = " ".repeat(6);
  const columns = process.stdout.columns ?? 100;
  const lines = wrapWords(text, Math.max(20, columns - 6));
  if (lines.length === 0) return;
  console.log(`${firstPrefix}${lines[0]}`);
  for (const line of lines.slice(1)) console.log(`${nextPrefix}${line}`);
}

export function logLabeledDetail(label: string, text: string): void {
  const firstPrefix = `    ${label}: `;
  const nextPrefix = " ".repeat(firstPrefix.length);
  const columns = process.stdout.columns ?? 100;
  const lines = wrapWords(text, Math.max(20, columns - firstPrefix.length));

  if (lines.length === 0) {
    console.log(firstPrefix.trimEnd());
    return;
  }

  console.log(`${firstPrefix}${lines[0]}`);
  for (const line of wrapWords(
    lines.slice(1).join(" "),
    Math.max(20, columns - nextPrefix.length),
  ))
    console.log(`${nextPrefix}${line}`);
}

// ── Interactive picker (hand-rolled; zero deps) ─────────────
export type Choice = { label: string; hint?: string };

/**
 * Minimal arrow-key select. Renders a title, optional detail lines, then a
 * vertical list; returns the chosen index, or -1 if the user skips (esc /
 * ctrl-c / q). Returns -1 immediately when not attached to a TTY, so callers
 * can fall back to non-interactive behavior.
 */
export function select(
  title: string,
  detail: string[],
  choices: Choice[],
): Promise<number> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const out = process.stdout;
    if (!stdin.isTTY || !out.isTTY || choices.length === 0) {
      resolve(-1);
      return;
    }

    out.write(`\n  ${ui.yellow("?")} ${title}\n`);
    for (const line of detail) out.write(`    ${ui.dim(line)}\n`);
    out.write(`    ${ui.dim("↑/↓ move · enter select · esc skip")}\n`);

    let active = 0;
    const render = (first = false) => {
      if (!first) out.write(`\x1b[${choices.length}A`);
      for (let k = 0; k < choices.length; k++) {
        const c = choices[k]!;
        const on = k === active;
        const pointer = on ? ui.cyan("❯") : " ";
        const label = on ? ui.cyan(c.label) : c.label;
        const hint = c.hint ? `  ${ui.dim(c.hint)}` : "";
        out.write(`\x1b[2K  ${pointer} ${label}${hint}\n`);
      }
    };
    render(true);

    const cleanup = () => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    const onData = (key: string) => {
      if (key === "\x1b[A" || key === "k") {
        active = (active - 1 + choices.length) % choices.length;
        render();
      } else if (key === "\x1b[B" || key === "j") {
        active = (active + 1) % choices.length;
        render();
      } else if (key === "\r" || key === "\n") {
        cleanup();
        resolve(active);
      } else if (key === "\x1b" || key === "\x03" || key === "q") {
        cleanup();
        resolve(-1);
      }
    };

    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
}

// ── Clipboard (spawn the platform tool; no dep) ─────────────
/** Copy text to the system clipboard. Returns false if no tool is available. */
export function copyToClipboard(text: string): boolean {
  const tools: Array<[string, string[]]> =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ];
  for (const [cmd, args] of tools) {
    try {
      const result = spawnSync(cmd, args, { input: text });
      if (!result.error && result.status === 0) return true;
    } catch {
      // try the next tool
    }
  }
  return false;
}

function wrapWords(text: string, width: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }

  if (line) lines.push(line);
  return lines;
}

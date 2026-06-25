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

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

export function findPiRoot(): string {
  let piBin: string;
  try {
    piBin = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("Could not find `pi` on PATH");
  }

  let current = fs.realpathSync(piBin);
  if (fs.statSync(current).isFile()) current = path.dirname(current);

  while (current !== path.dirname(current)) {
    const pkg = path.join(current, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const json = JSON.parse(fs.readFileSync(pkg, "utf8")) as {
          name?: string;
        };
        if (json.name === "@earendil-works/pi-coding-agent") return current;
      } catch {
        /* keep walking */
      }
    }
    current = path.dirname(current);
  }
  throw new Error(
    "Could not resolve @earendil-works/pi-coding-agent package root from `pi`",
  );
}

export function piVersion(): string {
  const result = spawnSync("pi", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return (result.stdout || result.stderr || "unknown").trim() || "unknown";
}

export function resolveTarget(piRoot: string, target: string): string {
  return path.isAbsolute(target) ? target : path.join(piRoot, target);
}

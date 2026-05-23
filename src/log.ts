import fs from "node:fs";
import path from "node:path";
import { LOGS } from "./paths.js";

export function log(message: string): void {
  fs.mkdirSync(LOGS, { recursive: true });
  fs.appendFileSync(
    path.join(LOGS, "reconcile.log"),
    `[${new Date().toISOString()}] ${message}\n`,
  );
}

export function say(message: string): void {
  console.log(message);
  log(message);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

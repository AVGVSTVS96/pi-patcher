#!/usr/bin/env node
import { errorMessage } from "../log.js";
import {
  cmdReconcile,
  cmdHeal,
  cmdList,
  cmdRemove,
} from "./commands.js";

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`pi-patcher: ${errorMessage(error)}`);
  process.exitCode = 1;
}

function main(argv: string[]): number {
  const [cmd = "reconcile", ...rest] = argv;
  switch (cmd) {
    case "reconcile":
      return cmdReconcile(rest);
    case "heal":
      return cmdHeal(requireArg(rest[0], "heal <id>"));
    case "list":
      return cmdList();
    case "remove":
      return cmdRemove(requireArg(rest[0], "remove <id>"));
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

function requireArg<T>(value: T | undefined, hint: string): T {
  if (value == null) throw new Error(`Usage: pi-patcher ${hint}`);
  return value;
}

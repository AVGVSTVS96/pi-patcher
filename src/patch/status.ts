import fs from "node:fs";
import { resolveTarget } from "../pi.js";
import type { Ctx } from "../session.js";
import { count } from "./edits.js";
import {
  type Patch,
  type Replacement,
  type Status,
  filesOf,
} from "./types.js";

export function statusOf(patch: Patch, ctx: Ctx): Status {
  if (patch.tombstoned) return "tombstoned";
  return computeStatus(patch, ctx);
}

function computeStatus(
  patch: Patch,
  ctx: Ctx,
): Exclude<Status, "tombstoned"> {
  const seen = new Set<Exclude<Status, "tombstoned">>();
  for (const file of filesOf(patch.spec)) {
    const target = resolveTarget(ctx.piRoot, file.target);
    if (!fs.existsSync(target)) {
      seen.add("drift");
      continue;
    }
    const text = fs.readFileSync(target, "utf8");
    for (const r of file.replacements ?? []) seen.add(classifyOne(r, text));
  }
  if (seen.has("drift")) return "drift";
  if (seen.has("pending")) return "pending";
  return "applied";
}

function classifyOne(
  r: Replacement,
  text: string,
): Exclude<Status, "tombstoned"> {
  const newCount = count(text, r.newText);
  if (newCount === 1) return "applied";
  if (newCount > 1) return "drift";
  const oldCount = count(text, r.oldText);
  if (oldCount === 1) return "pending";
  return "drift";
}

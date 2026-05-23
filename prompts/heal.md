You are repairing a small source patch for pi.

Patch id: {{patch_id}}
Target file: {{target_path}}

## Original intent of the patch
{{intent}}

## The replacement that failed
This replacement used to apply cleanly; it no longer does. Treat it as a hint for the intended location and shape, not as ground truth.

```json
{{replacement}}
```

## Your task
The exact `oldText` → `newText` replacement above no longer applies because the target file changed upstream. Find the equivalent location in the current target file and apply the smallest equivalent edit that restores the original intent.

Before editing, output exactly one planning block:

===PLAN===
A concise 2-4 sentence summary of what changed upstream and what you will edit.
===END===

Then perform the edit and exit.

## Scope guard
If restoring the original intent would require a significantly larger or conceptually different change than the previous replacement — for example, the target feature was removed, the relevant code was redesigned, many unrelated locations would need edits, or you would be redesigning the patch rather than re-anchoring it — do not edit. Instead output:

===ABORT===
A concise reason you are not proceeding.
===END===

Then exit.

## Hard constraints
- Edit only this file: {{target_path}}
- Keep the edit as small as possible.
- Do not modify package metadata, settings, logs, backups, or patch specs.
- {{validation_hint}}

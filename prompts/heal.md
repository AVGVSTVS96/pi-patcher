You are healing a pi-patcher PATCH.md after upstream changed the target file.
Use the PATCH.md as the source of truth; re-anchor its intended edit with the smallest equivalent change, not a redesign.

Patch id: {{patch_id}}
Target file: {{target_path}}

## PATCH.md

````markdown
{{patch_markdown}}
````

## Task
The PATCH.md edit for this target no longer applies cleanly. Use the prose and fenced edit as context, then edit the current target file to restore that same intent.

Before editing, output exactly one planning block:

===PLAN===
A concise 2-4 sentence summary of what changed upstream and what you will edit.
===END===

Then perform the edit and exit.

## Abort instead of redesigning
If the PATCH.md intent no longer maps cleanly to this target file, do not edit. Output:

===ABORT===
A concise reason you are not proceeding.
===END===

Then exit.

## Hard constraints
- Edit only this file: {{target_path}}
- Keep the edit as small as possible.
- Do not modify package metadata, settings, logs, backups, or patch specs.
- {{validation_hint}}

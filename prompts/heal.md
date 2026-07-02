You are healing a pi-patcher patch after upstream changes to its target broke the patch's edits.
Use the patch spec as the source of truth; restore its intended edit with the smallest equivalent change.

Patch id: {{patch_id}}
Patch spec file: {{spec_path}}
Package root: {{package_root}}
Target file(s):
{{targets}}

## Patch spec

````markdown
{{patch_markdown}}
````

## Task
The spec's edits no longer apply cleanly. Read the current target(s), then rewrite the fenced edit blocks in {{spec_path}} so they restore the intent against the updated source. Each SEARCH block must match its target exactly once.

You may search the source under {{package_root}} to understand what changed; if the code moved to another file, point the fence's `file=` at it. You may also trial the edit in the source to check correctness: when you exit, pi-patcher reverts every file except {{spec_path}}, then applies and verifies your spec mechanically.

Before editing, output exactly one planning block:

===PLAN===
A concise 2-4 sentence summary of what changed upstream and what you will edit.
===END===

Then perform the edit and exit.

## When to abort
Abort only if restoring the intent would require a genuine redesign: the feature it patched was removed, or the change no longer maps to any small edit. Then, don't edit. Instead, output:

===ABORT===
A concise reason a small edit can't restore the intent.
===END===

Then exit.

## Hard constraints
- Make the smallest spec change that restores the intent.
- Your only durable output is {{spec_path}}; every other edit is reverted.
- {{validation_hint}}

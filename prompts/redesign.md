You are redesigning a pi-patcher patch. Upstream changes mean its intent can no longer be restored by a minimal heal.
As long as the intent can still be faithfully achieved, you may restructure the patch's edits freely against the updated source.

Patch id: {{patch_id}}
Patch spec file: {{spec_path}}
Package root: {{package_root}}
Target file(s):
{{targets}}

## Current patch

````markdown
{{patch_markdown}}
````

## Task
1. Read the target file(s) and the package source under {{package_root}} to understand what changed.
2. Re-author the fenced edit blocks in {{spec_path}} so that, applied to the current target(s), they achieve the intent. Each SEARCH block must match its target exactly once. Keep the prose accurate.
3. You may trial edits in the source to check correctness: when you exit, pi-patcher reverts every file except {{spec_path}}, then applies and verifies your spec mechanically.

Output one planning block:

===PLAN===
A concise 2-4 sentence summary of what changed and how you are reworking the patch.
===END===

Then make the edit and exit.

## When to abort
Abort only if the intent is obsolete: the feature it patched is gone with no equivalent, or any redesign would introduce new side-effects. Then output:

===ABORT===
Explain why the patch can no longer achieve its intent. Suggest `pi-patcher remove {{patch_id}}`.
===END===

## Hard constraints
- Your only durable output is {{spec_path}}; every other edit is reverted.
- {{validation_hint}}

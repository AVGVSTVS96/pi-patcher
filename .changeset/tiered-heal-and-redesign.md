---
"pi-patcher": minor
---

The AI is now the only writer of patch specs: pi rewrites `PATCH.md` itself, and pi-patcher verifies by restoring its snapshot and applying the spec mechanically, retrying once in the same session before rolling back. Adds `reconcile --redesign` (rework aborted patches autonomously) and `--prompt` (print a prompt to drive it yourself).

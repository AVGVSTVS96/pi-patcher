# pi-patcher

## 1.1.0

### Minor Changes

- The AI is now the only writer of patch specs: pi rewrites `PATCH.md` itself, and pi-patcher verifies by restoring its snapshot and applying the spec mechanically, retrying once in the same session before rolling back. Adds `reconcile --redesign` (rework aborted patches autonomously) and `--prompt` (print a prompt to drive it yourself). _[`440da05`](https://github.com/avgvstvs96/pi-patcher/commit/440da05877d1a259aa4664669722a9866af531be) [@AVGVSTVS96](https://github.com/AVGVSTVS96)_

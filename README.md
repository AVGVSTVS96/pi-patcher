# pi-patcher

Self-healing patches for [pi](https://github.com/earendil-works/pi-coding-agent).

Want to modify `pi` but your changes require a patch? Use `pi-patcher` to keep small source patches applied across every `pi update`. When a patch breaks because pi changed, `pi-patcher` shells out to pi itself to re-anchor the edit.

## The idea

Every time pi updates, your local patches break. The old story is: re-derive the patch, re-apply, repeat forever.

pi-patcher flips that. Each patch is a tiny `oldText → newText` spec plus a plain-English `intent.md`. On every `pi update`:

1. If the spec still applies cleanly, it's re-applied. Done.
2. If it drifted, pi-patcher hands the intent, the old spec, and the new target file to pi and asks it to find the equivalent edit.
3. The healed edit is diffed back into a fresh spec and saved. Next update, it just works.

Pi patches pi. The patch maintainer is the agent.

## Install

```sh
npm install -g pi-patcher
```

The postinstall runs `pi-patcher reconcile`, which patches a one-line hook into pi's update path so that every subsequent `pi update` re-applies your patches. The hook itself is just another pi-patcher patch — self-managed and self-healed when necessary.

## Commands

```sh
pi-patcher              # same as reconcile
pi-patcher reconcile    # apply pending patches; heal drifted ones
pi-patcher list         # status + most recent heal session per patch
pi-patcher heal <id>    # force-heal one patch (manual re-anchor)
pi-patcher remove <id>  # revert the edits and delete the patch folder
```

`reconcile` is the workhorse. It's what runs after `npm install -g pi-patcher` and after every `pi update`. You can also run it by hand after authoring or editing a patch.

`remove` reverts the patch's edits first, then deletes the folder. If the file has drifted so the mechanical revert can't run, `remove` bails out and asks you to clean up the file by hand. The escape hatch is always `rm -rf ~/.pi/patches/<id>`.

## Writing a patch

A patch is just a folder in `~/.pi/patches/`:

```text
~/.pi/patches/<id>/
  intent.md     # what the patch does, and why (read by the AI when healing)
  spec.json     # { files: [{ target, replacements: [{ oldText, newText }] }] }
```

Each `oldText` must appear exactly once in the target file. `newText` must be non-empty — deletion-only patches aren't supported in this version (replace the line with a comment instead).

## How healing works

When the literal `oldText`/`newText` no longer matches, pi-patcher hands the work to pi:

- the target file is snapshotted first
- `pi -p --model ${PI_PATCHER_HEAL_MODEL:-openai-codex/gpt-5.5:low} --session-dir <heal-sessions>/<id>-<ts>/` is invoked with `prompts/heal.md` on stdin
- `node --check` runs on the result; the snapshot is restored on failure
- if pi decides the change is out of scope (feature removed, would require a redesign), it emits `===ABORT===` and pi-patcher rolls back cleanly
- on success, pi-patcher derives a fresh `oldText`/`newText` from the AI's edit and saves it to `spec.json`

Every session is saved and its path is logged; replay with `pi --session <path>`.

## Model configuration

`PI_PATCHER_HEAL_MODEL` overrides the default heal model (`openai-codex/gpt-5.5:low`).

## Development

```sh
bun test
bun run typecheck
bun run build
```

## Layout

```text
~/.pi/patches/        # your patches (user-authored, also bundled defaults)
~/.pi/pi-patcher/     # tool-internal runtime data
  backups/<ver>/      # pre-edit copies, keyed by pi version
  heal-sessions/      # one dir per heal attempt
  state.json          # last-applied / last-healed / last-error per patch
```

## License

MIT

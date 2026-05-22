# pi-patcher

Self healing patches for [pi](https://github.com/earendil-works/pi-coding-agent)

Want to modify `pi` but your changes require a patch? Use `pi-patcher` to automatically apply patches to pi's source code on `pi update`. When patching fails due to updates to target files, `pi-patcher` uses `pi` to self-heal: it updates the patch file for the new code and applies it.

## The idea

Every time pi updates, your local patches break. The old story is: re-derive the patch, re-apply, repeat forever.

pi-patcher flips that. Each patch is a tiny `oldText → newText` spec plus a plain-English `intent.md`. On every `pi update`:

1. If the spec still applies cleanly, it's re-applied. Done.
2. If it drifted, pi-patcher shells out to pi itself — `pi -p --model …` — hands it the intent, the old spec, and the new target file, and asks it to find the equivalent edit.
3. The healed edit is diffed back into a fresh spec and saved. Next update, it just works.

Pi patches pi. The patch maintainer is the agent.

## Install

```sh
npm install -g pi-patcher
```

Postinstall runs `pi-patcher reconcile`, which patches a one-line hook into pi's update path and applies any patches defined in `~/.pi/pi-patcher/patches/`. The `pi-update` patch is self-managed and self-healed when necessary.

## Commands

```sh
pi-patcher              # reconcile
pi-patcher reconcile    # apply / reverse / heal everything
pi-patcher list         # show patch state + latest heal session
pi-patcher heal <id>    # force-heal one patch
pi-patcher remove <id>  # tombstone a patch (reversed on next reconcile)
```

<!-- TODO: `remove` should actively remove the patch, not wait for next reconcile -->

## Writing a patch

A patch is just a folder in `~/.pi/pi-patcher/patches/` with: <!-- TODO: move patches to `~/.pi/patches` -->

```text
~/.pi/pi-patcher/patches/<id>/
  intent.md     # what the patch does, and why
  spec.json     # { files: [{ target, replacements: [{ oldText, newText }] }] }
```

`intent.md` ensures the LLM understands the patch before self-healing.

To remove a patch, rename the folder to `_<id>`. Next reconcile reverses it.

## How healing works

When the literal `oldText`/`newText` no longer matches, pi-patcher:

- snapshots the target file
- pipes `prompts/heal.md` (with intent, old spec, and target path interpolated) into `pi -p --model ${PI_PATCHER_HEAL_MODEL:-openai-codex/gpt-5.5:low} --session-dir <heal-sessions>/<id>-<ts>/`
- lets pi edit the target directly
- runs `node --check` on the result; rolls back if it fails
- diffs before/after, derives a new minimal `oldText`/`newText`, and writes it back to `spec.json`

If pi decides the original intent no longer makes sense (feature removed, code redesigned), it emits `===ABORT===` and pi-patcher rolls back cleanly. Every session is saved and its ID is logged; replay with `pi --session <path>`.

## Model configuration

By default, pi-patcher uses `openai-codex/gpt-5.5:low` for self-healing.
Set `PI_PATCHER_HEAL_MODEL` to use a different pi model.

## Development

```sh
bun test
bun run typecheck
bun run build
```

## Layout

```text
~/.pi/pi-patcher/
  patches/          # your patches (active and _tombstoned)
  backups/<ver>/    # pre-edit copies, keyed by pi version
  heal-sessions/    # one dir per heal attempt
  logs/             # reconcile.log
  state.json        # last-applied / last-healed / last-error per patch
```

## License

MIT

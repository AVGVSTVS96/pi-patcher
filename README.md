# pi-patcher

Self-healing patches for [pi](https://github.com/earendil-works/pi-coding-agent).

Want to modify `pi` but your changes require a patch? Use `pi-patcher` to keep source patches applied across every `pi update`. When patching fails due to updates to target files, `pi-patcher` uses `pi` to self-heal: the AI updates the patch file for the new code and applies it.

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
pi-patcher init
```

`pi-patcher init` copies the bundled `bootstrap-hook` patch into `~/.pi/patches/` and applies it, wiring `pi-patcher reconcile` into the end of `pi update` so your patches are re-applied automatically on every future update. Every edit is backed up under `~/.pi/pi-patcher/backups/<piVersion>/` and is reversible via `pi-patcher remove` or `pi-patcher uninstall`.

## Commands

```sh
pi-patcher init         # one-time setup: install bundled patches + wire into `pi update`
pi-patcher reconcile    # apply pending patches; heal drifted ones
pi-patcher list         # status + most recent heal session per patch
pi-patcher heal <id>    # force-heal one patch (manual re-anchor)
pi-patcher remove <id>  # revert the edits and delete the patch folder
pi-patcher uninstall    # revert every patch and `npm uninstall -g pi-patcher`
```

Running `pi-patcher` with no arguments prints this list.

`init` is what you run once after `npm install`. Re-running it after upgrades is safe — it only copies bundled patches that aren't already in `~/.pi/patches/`.

`reconcile` is the workhorse for steady-state. It runs automatically after every `pi update` (via the hook `init` installs), and you can also run it by hand after authoring or editing a patch.

`remove` reverts the patch's edits first, then deletes the folder.

## Writing a patch

A patch is just a folder in `~/.pi/patches/`:

```text
~/.pi/patches/<id>/
  intent.md     # what the patch does, and why (read by the AI when healing)
  spec.json     # { files: [{ target, replacements: [{ oldText, newText }] }] }
```

Each `oldText` must appear exactly once in the target file. `newText` must be non-empty — deletion-only patches aren't supported in this version (replace the line with a comment instead).

A spec can contain multiple files and multiple replacements per file. Mechanical apply, revert, and AI heal all iterate over every entry; heal runs one AI session per drifted replacement and rewrites only that entry's `oldText`/`newText`.

JavaScript and JSON targets are syntax-checked after every edit. Any file type (markdown, plain text, etc.) is supported.

## How healing works

When the literal `oldText`/`newText` no longer matches, pi-patcher hands the work to pi:

- the target file is snapshotted first
- `pi -p --model ${PI_PATCHER_HEAL_MODEL:-openai-codex/gpt-5.5:low} --session-dir <heal-sessions>/<id>-<ts>/` is invoked with `prompts/heal.md` on stdin
- the result is syntax-checked (JS / JSON only); the snapshot is restored on failure
- if pi decides the change is out of scope (feature removed, would require a redesign), it emits `===ABORT===` and pi-patcher rolls back cleanly
- on success, pi-patcher derives a fresh `oldText`/`newText` from the AI's edit and saves it to `spec.json`

Every session is saved and its path is logged; replay with `pi --session <path>`.

## Uninstalling

```sh
pi-patcher uninstall
```

Reverts every patch, deletes their folders, forgets state, then runs `npm uninstall -g pi-patcher`.

To *temporarily* disable pi-patcher without uninstalling, rename any patch directory to `_<id>`. The loader skips underscore-prefixed entries.

## Model configuration

`PI_PATCHER_HEAL_MODEL` overrides the default heal model (`openai-codex/gpt-5.5:low`).

## Development

```sh
bun test
bun run typecheck
bun run build
```

## License

MIT

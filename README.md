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

`pi-patcher init` applies the bundled `bootstrap-hook` patch, wiring `pi-patcher reconcile` into the end of `pi update` so your patches are re-applied automatically on every future update. Every edit is reversible via `pi-patcher remove` or `pi-patcher uninstall`, and any failed apply or heal is rolled back automatically, leaving the target file untouched.

You write patches in `~/.pi/patches/`; pi-patcher's own bundled patches live separately under `~/.pi/pi-patcher/internal-patches/` and never touch your dir.

## Commands

```sh
pi-patcher init         # one-time setup: install bundled patches + wire into `pi update`
pi-patcher reconcile    # apply pending patches; heal drifted ones
pi-patcher list         # status + most recent heal session per patch
pi-patcher heal <id>    # force-heal one patch (manual re-anchor)
pi-patcher remove <id>  # revert a user patch's edits and delete its folder
pi-patcher uninstall    # revert every patch and `npm uninstall -g pi-patcher`
```

Running `pi-patcher` with no arguments prints this list.

`init` is what you run once after `npm install`. Re-running it after upgrades is safe.

`reconcile` is the workhorse for steady-state. It runs automatically after every `pi update` (via the hook `init` installs), and you can also run it by hand after authoring or editing a patch.

`remove` reverts a user patch, then deletes its folder. Bundled patches are managed by pi-patcher — use `uninstall` to remove those.

## Writing a patch

A patch is just a folder in `~/.pi/patches/` with a `PATCH.md` file:

````text
~/.pi/patches/<id>/
  PATCH.md
````

`PATCH.md` is freeform markdown plus frontmatter and fenced edit blocks. The prose is fed to the AI when healing; mechanical apply only reads the frontmatter and edit fences:

````md
---
id: my-patch
summary: What this patch does
version: 0.1.0
lastUpdated: 2026-06-25
---

# My patch

Whatever prose helps explain the patch.

```patch file=dist/example.js
<<<<<<< SEARCH
old text
=======
new text
>>>>>>> REPLACE
```
````

Diff-style hunks are also supported:

````md
```diff file=dist/example.js
@@ optional hint @@
 context line
+added line
```
````

Each derived `oldText` must appear exactly once in the target file. `newText` must be non-empty — deletion-only patches aren't supported in this version (replace the line with a comment instead).

A patch can contain multiple fenced edits, across one or more files. Mechanical apply, revert, and AI heal all iterate over every entry; heal runs one AI session per drifted replacement and rewrites only that entry in `PATCH.md`. Legacy `intent.md` + `spec.json` patch folders are still read for backwards compatibility.

JavaScript and JSON targets are syntax-checked after every edit. Any file type (markdown, plain text, etc.) is supported.

## How healing works

When the literal `oldText`/`newText` no longer matches, pi-patcher hands the work to pi:

- the target file is snapshotted first
- `pi -p --model ${PI_PATCHER_HEAL_MODEL:-openai-codex/gpt-5.5:low} --session-id <id>` is invoked with `prompts/heal.md` on stdin
- pi uses your normal session storage, so heal sessions remain discoverable anywhere `pi --session <id>` can find them
- pi-patcher shows a small progress spinner while the headless heal runs, but suppresses raw nested pi output by default
- the result is syntax-checked (JS / JSON only); the snapshot is restored on failure
- if pi decides the change is out of scope (feature removed, would require a redesign), it emits `===ABORT===` internally and pi-patcher prints the abort reason once
- on success, pi-patcher derives a fresh `oldText`/`newText` from the AI's edit and saves it back to `PATCH.md` (or `spec.json` for legacy patches)

Each heal prints the short replay command, e.g. `pi --session 019efc67-5d7d-75f1-b395-62e7ccc0eda0`.

## Uninstalling

```sh
pi-patcher uninstall
```

Reverts every patch (yours and the bundled ones), deletes their folders, forgets state, then runs `npm uninstall -g pi-patcher`.

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

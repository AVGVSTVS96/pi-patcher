# pi-patcher

Self-healing patches for [pi](https://github.com/earendil-works/pi-coding-agent).

Want to modify `pi` but your changes require a patch? Use `pi-patcher` to keep source patches applied across every `pi update`. When patching fails due to updates to target files, `pi-patcher` uses `pi` to self-heal: the AI rewrites the patch file for the new code, and pi-patcher proves the rewrite by applying it mechanically.

## The idea

Every time pi updates, your local patches break. The old story is: re-derive the patch, re-apply, repeat forever.

pi-patcher flips that. Each patch is a tiny `oldText → newText` spec plus a plain-English `intent.md`. On every `pi update`:

1. If the spec still applies cleanly, it's re-applied. Done.
2. If it drifted, pi-patcher hands the `PATCH.md` and the new target file to pi, and pi rewrites the patch's edit blocks for the current code.
3. pi-patcher reverts any scratch edits, then proves the rewritten spec by applying it mechanically. Next update, it just works.

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
pi-patcher init               # one-time setup: install bundled patches + wire into `pi update`
pi-patcher reconcile          # apply pending patches; heal drifted ones
pi-patcher reconcile --redesign  # also autonomously redesign patches that can't be re-anchored
pi-patcher reconcile --prompt    # ...or print a prompt to drive the redesign yourself
pi-patcher list               # status + most recent heal session per patch
pi-patcher heal <id>          # force-heal one patch (accepts --redesign / --prompt)
pi-patcher remove <id>        # revert a user patch's edits and delete its folder
pi-patcher uninstall          # revert every patch and `npm uninstall -g pi-patcher`
```

Running `pi-patcher` with no arguments prints this list.

`init` is what you run once after `npm install`. Re-running it after upgrades is safe.

`reconcile` is the workhorse for steady-state. It runs automatically after every `pi update` (via the hook `init` installs), and you can also run it by hand after authoring or editing a patch.

`remove` reverts a user patch, then deletes its folder. For bundled patches managed by pi-patcher, use `uninstall`.

## Writing a patch

A patch is just a folder in `~/.pi/patches/` with a `PATCH.md` file:

````text
~/.pi/patches/<id>/
  PATCH.md
````

`PATCH.md` is freeform markdown plus frontmatter and fenced edit blocks. The prose is fed to the AI when healing; mechanical apply only reads the frontmatter and edit fences. The format is defined by the [PATCH.md spec](https://patchmd.vercel.app) ([AVGVSTVS96/patch_md-spec](https://github.com/AVGVSTVS96/patch_md-spec)) — see it for the frontmatter fields, edit-block syntax, and anchoring rules.

A patch can contain multiple fenced edits, across one or more files. Mechanical apply and revert iterate over every entry; heal runs one AI session per drifted patch, and the agent rewrites `PATCH.md` itself. Legacy `intent.md` + `spec.json` patch folders are still read for backwards compatibility.

JavaScript and JSON targets are syntax-checked after every edit. Any file type (markdown, plain text, etc.) is supported.

## How healing works

One contract underlies everything: **the AI is the only writer of patch specs**. pi-patcher never writes a `PATCH.md` — it snapshots, restores, applies, and verifies.

Drift is resolved in tiers, smallest change first:

1. **Re-anchor.** When the literal `oldText`/`newText` no longer matches, pi-patcher hands the `PATCH.md` to pi, which makes the smallest spec edit that restores the intent.
2. **Retarget.** If the code the patch targets has moved to another file in the same package, pi finds it there and points the edit's `file=` at the new location. Re-anchor and retarget both happen automatically during `reconcile`.
3. **Redesign.** Only when restoring the intent would require genuine rework does pi abort. That patch is then *routed* rather than failed (see below).

Under the hood, for tiers 1–2:

- the patch spec and the package's files are snapshotted first
- `pi -p --model ${PI_PATCHER_HEAL_MODEL:-openai-codex/gpt-5.5:low} --session-id <id>` is invoked with `prompts/heal.md` on stdin
- pi rewrites the fenced edits in `PATCH.md` itself; it may trial the change in the source, but those edits are scratch
- pi-patcher then restores the sources from the snapshot and proves the rewritten spec by applying it mechanically (unique anchors + syntax checks, JS / JSON only)
- if the spec doesn't verify, the same session is resumed once with the exact failure; a second miss rolls everything back — spec and sources alike
- pi uses your normal session storage, so heal sessions remain discoverable anywhere `pi --session <id>` can find them
- pi-patcher shows a small progress spinner while the headless heal runs, but suppresses raw nested pi output by default

Each heal prints the short replay command, e.g. `pi --session 019efc67-5d7d-75f1-b395-62e7ccc0eda0`.

### When a patch needs a redesign

If pi aborts because the intent no longer maps to a small edit, the patch is marked **needs redesign** and routed:

- **Interactively** (a TTY, e.g. you running `pi update` or `pi-patcher reconcile` by hand) you get a 3-option picker: *redesign automatically*, *copy a prompt to your clipboard* to drive the fix yourself in `pi`, or *skip*.
- **Non-interactively** (CI, unattended updates) pi-patcher just reports it and points you at the resolution commands, so it never blocks.
- **`--redesign`** forces the autonomous path for every aborted patch: pi re-authors the patch spec against the current target, and pi-patcher proves the redesign by applying it mechanically (rolled back if it doesn't apply).
- **`--prompt`** prints a ready-to-paste prompt instead, so you can run the redesign in an interactive `pi` session and re-run `reconcile` afterwards.

Both flags act **only** on patches that aborted; healthy and re-anchorable patches are unaffected.

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

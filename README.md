# pi-patcher

Minimal, update-resilient source patches for pi installs.

## Install

```sh
npm install -g ./path/to/pi-patcher
```

The install runs `pi-patcher reconcile`, which installs the tiny `pi update` bootstrap hook and applies any patches in `~/.pi/pi-patcher/patches`.

## Commands

```sh
pi-patcher              # same as reconcile
pi-patcher reconcile    # apply/reverse/heal all patches
pi-patcher list         # show patch state and latest heal session
pi-patcher heal <id>    # force the self-heal path for one patch
pi-patcher remove <id>  # rename patches/<id> to patches/_<id>
```

## Patch registry

Patches are folders:

```text
~/.pi/pi-patcher/patches/<id>/
  intent.md
  spec.json
```

Rename a folder to `_id` to tombstone it. The next reconcile reverses it if it had been applied.

## Self-heal

When a patch drifts, pi-patcher invokes:

```sh
pi -p --model "openai-codex/gpt-5.5:low" --session-dir ~/.pi/pi-patcher/heal-sessions/<id>-<timestamp>/
```

The prompt template lives at `prompts/heal.md`.

---
id: bootstrap-hook
summary: Re-run `pi-patcher reconcile` after pi finishes updating itself.
version: 0.1.0
lastUpdated: 2026-06-25
---

# Bootstrap hook

## Intent

After pi's built-in `pi update` command finishes updating pi itself, automatically run `pi-patcher reconcile` so all installed source patches are re-applied to the freshly updated pi install.

This must be a tiny, safe hook in `dist/package-manager-cli.js` immediately after the existing `console.log(chalk.green(`Updated ${APP_NAME}`));` line in the self-update path. The inserted hook must be valid in pi's compiled ESM output and must not rely on CommonJS-only globals like `require`. It should not change update behavior if `pi-patcher` is missing or fails to launch.

## Patch Edits

### dist/package-manager-cli.js

> note: end of the pi self-update branch, immediately after Updated ${APP_NAME}

```diff file=dist/package-manager-cli.js
@@ pi self update success branch @@
                    console.log(chalk.green(`Updated ${APP_NAME}`));
+                    try { (await import("node:child_process")).spawnSync("pi-patcher", ["reconcile"], { stdio: "inherit" }); } catch {}
```

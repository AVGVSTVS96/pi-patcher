After pi's built-in `pi update` command finishes updating pi itself, automatically run `pi-patcher reconcile --after-update` so all installed source patches are re-applied to the freshly updated pi install.

This must be a tiny, safe hook in `dist/package-manager-cli.js` immediately after the existing `console.log(chalk.green(`Updated ${APP_NAME}`));` line in the self-update path. It should not change update behavior if `pi-patcher` is missing or fails to launch.

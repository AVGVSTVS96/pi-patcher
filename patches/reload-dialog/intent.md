Make the built-in `/reload` command show pi's loaded resources summary in the existing loaded-resources dialog/overlay instead of appending it into the current chat thread.

The dialog path already exists inside `showLoadedResources` via the `asDialog: true` option. The patch should only change the `/reload` handler's call to `showLoadedResources` so it passes `force: true`, `asDialog: true`, and `showDiagnosticsWhenQuiet: true` after rebuilding the session resources.

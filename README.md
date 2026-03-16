# vscode-perfetto

Open trace files in the bundled Perfetto UI from VS Code. The extension reads files through `vscode.workspace.fs`, so it works for both local folders and Remote-SSH workspaces.

Right-click a `.json`, `.json.gz`, or `.chrome_trace` file and choose `Open in Perfetto`. You can also open any file first, then run `Perfetto: Open in Perfetto`.

Use `Perfetto: Show Output` to inspect extension logs.

By default the extension opens Perfetto in browser mode. Set `perfetto.openMode` to `webview` if you want to embed the UI inside a VS Code webview instead. In browser mode the extension exposes the selected trace through a temporary local endpoint and passes that URL to Perfetto via `?url=...`.

## Update Bundled Perfetto UI

```bash
pnpm run perfetto:fetch
# TODO: needs more testing
# pnpm run perfetto:build:source
```

## Development

```bash
pnpm install
pnpm run compile
pnpm run package:vsix
```

## Debug In VS Code

Open this repository in VS Code, then use the built-in `Run Extension` launch configuration in `.vscode/launch.json`.

1. Run `pnpm install`.
2. Press `F5` in VS Code.
3. In the Extension Development Host window, open a `.json`, `.json.gz`, or `.chrome_trace` file.
4. Run `Perfetto: Open in Perfetto` or use the Explorer context menu.

To use an external Perfetto UI while debugging, set `perfetto.uiUrl` to the target URL before launching the extension host. This works with both `webview` and `browser` modes.

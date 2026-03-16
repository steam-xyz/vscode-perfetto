# vscode-perfetto

Open trace files in the bundled Perfetto UI from VS Code. The extension reads files through `vscode.workspace.fs`, so it works for both local folders and Remote-SSH workspaces.

Right-click a `.json`, `.chrom_trace`, or `.chrome_trace` file and choose `Open in Perfetto`. You can also open the file first, then run `Perfetto: Open in Perfetto`.

Use `Perfetto: Show Output` to inspect extension logs.

## Update Bundled Perfetto UI

```bash
pnpm run perfetto:fetch
pnpm run perfetto:build:source
```

## Development

```bash
pnpm install
pnpm run compile
pnpm run package:vsix
```

Press `F5` to launch the extension host. To use an external Perfetto UI, set `perfetto.uiUrl` to the target URL.

## CLI Debugging and E2E Tests

Start an extension development host from the command line without packaging a `.vsix`:

```bash
code --extensionDevelopmentPath="$(pwd)" --disable-extensions .
```

Run unattended end-to-end tests with:

```bash
pnpm run test:e2e
```

This command:

- Compiles the extension and test code.
- Reuses your installed VS Code instead of downloading another copy.
- Loads this repository through `--extensionDevelopmentPath`, without installing a `.vsix`.
- Opens `demos/softmax.chrome_trace` and verifies the Perfetto panel and extension logs.

Requirement:

```bash
which code
```

The `code` CLI must be on `PATH` and point to your desktop VS Code installation.

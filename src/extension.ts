import * as path from 'node:path';
import * as vscode from 'vscode';
import { BundledUiServer } from './bundledUiServer';
import { PerfettoPanel, type PerfettoUiTarget } from './perfettoPanel';

const COMMAND_OPEN_TRACE = 'vscode-perfetto.openTrace';
const COMMAND_SHOW_OUTPUT = 'vscode-perfetto.showOutput';
const OUTPUT_CHANNEL_NAME = 'Perfetto';

type PerfettoOpenMode = 'webview' | 'browser';

let bundledUiServer: BundledUiServer | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  const log = (message: string): void => {
    const line = `[${new Date().toLocaleTimeString('en-GB', { hour12: false })}] ${message}`;
    output.appendLine(line);
  };

  context.subscriptions.push(output);
  bundledUiServer = new BundledUiServer(context.extensionUri, log);
  context.subscriptions.push(bundledUiServer);
  log('Extension activated.');

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_OPEN_TRACE, async (resource?: vscode.Uri) => {
      await openTrace(context, resource ?? vscode.window.activeTextEditor?.document.uri, log);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_SHOW_OUTPUT, () => {
      output.show(true);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('perfetto.uiUrl')) {
        void updateCurrentPanelTarget(log);
      }
    }),
  );
}

async function openTrace(
  context: vscode.ExtensionContext,
  traceUri: vscode.Uri | undefined,
  log: (message: string) => void,
): Promise<void> {
  if (!traceUri) {
    void vscode.window.showErrorMessage('Select a file first.');
    return;
  }

  const fileName = getTraceFileName(traceUri);
  const source = traceUri.toString(true);
  const openMode = getPerfettoOpenMode(log);

  log(`Open requested: ${source}`);
  log(`Open mode: ${openMode}`);

  if (openMode === 'browser') {
    try {
      await openTraceInBrowser(traceUri, log);
      log(`Trace queued for ${fileName}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Open failed for ${fileName}: ${message}`);
      outputError(log, fileName, message);
      void vscode.window.showErrorMessage(`Failed to open ${fileName}: ${message}`);
    }
    return;
  }

  const uiTarget = await resolvePerfettoUiTarget(log);
  const panel = PerfettoPanel.createOrShow(context.extensionUri, uiTarget, log, () => {
    disposeBundledUiServer();
  });

  try {
    log(`Perfetto UI: ${uiTarget.label}`);
    const readStart = Date.now();
    const bytes = await vscode.workspace.fs.readFile(traceUri);
    log(`Read ${bytes.byteLength} bytes in ${Date.now() - readStart} ms.`);
    await panel.openTrace(traceUri, bytes);
    log(`Trace queued for ${fileName}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Open failed for ${fileName}: ${message}`);
    outputError(log, fileName, message);
    void vscode.window.showErrorMessage(`Failed to open ${fileName}: ${message}`);
  }
}

function outputError(log: (message: string) => void, fileName: string, message: string): void {
  log(`Error: ${fileName}: ${message}`);
}

function getPerfettoOpenMode(log?: (message: string) => void): PerfettoOpenMode {
  const configuredValue = vscode.workspace
    .getConfiguration('perfetto')
    .get<string>('openMode', 'browser')
    .trim();

  if (configuredValue === 'webview' || configuredValue === 'browser') {
    return configuredValue;
  }

  log?.(`Ignoring invalid perfetto.openMode: ${configuredValue}`);
  return 'browser';
}

function getPerfettoUiOverride(log?: (message: string) => void): string | undefined {
  const configuredValue = vscode.workspace
    .getConfiguration('perfetto')
    .get<string>('uiUrl', '')
    .trim();

  if (!configuredValue) {
    return undefined;
  }

  try {
    const url = new URL(configuredValue);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.toString();
    }
  } catch {
    // Fall back to the bundled UI when the configured URL is invalid.
  }

  log?.(`Ignoring invalid perfetto.uiUrl: ${configuredValue}`);
  return undefined;
}

async function resolvePerfettoUiTarget(log: (message: string) => void): Promise<PerfettoUiTarget> {
  const uiUrlOverride = getPerfettoUiOverride(log);
  if (uiUrlOverride) {
    return {
      url: uiUrlOverride,
      label: uiUrlOverride,
      isBundled: false,
    };
  }

  if (!bundledUiServer) {
    throw new Error('Bundled Perfetto UI server is not initialized.');
  }

  return {
    url: await bundledUiServer.getUiUrl(),
    label: 'bundled Perfetto UI',
    isBundled: true,
  };
}

async function openTraceInBrowser(traceUri: vscode.Uri, log: (message: string) => void): Promise<void> {
  if (!bundledUiServer) {
    throw new Error('Bundled Perfetto UI server is not initialized.');
  }

  const uiTarget = await resolvePerfettoUiTarget(log);
  const traceUrl = await bundledUiServer.createTraceUrl(traceUri);
  const browserUrl = buildBrowserUrl(uiTarget.url, traceUrl);

  log(`Perfetto UI: ${uiTarget.label}`);
  log(`Trace URL: ${traceUrl}`);
  log(`Resolved browser URL: ${browserUrl}`);

  await openInBrowser(browserUrl, log);
}

function buildBrowserUrl(uiUrl: string, traceUrl: string): string {
  const target = new URL(uiUrl);
  const routeArgs = new URLSearchParams();
  routeArgs.set('url', traceUrl);
  target.hash = `!/?${routeArgs.toString()}`;
  return target.toString();
}

async function openInBrowser(url: string, log: (message: string) => void): Promise<void> {
  const commandList = await vscode.commands.getCommands(true);

  if (commandList.includes('workbench.action.browser.open')) {
    log('Opening Perfetto in the integrated browser.');
    await vscode.commands.executeCommand('workbench.action.browser.open', url);
    return;
  }

  if (commandList.includes('simpleBrowser.show')) {
    log('Integrated browser is unavailable, falling back to Simple Browser.');
    await vscode.commands.executeCommand('simpleBrowser.show', url);
    return;
  }

  log('Opening Perfetto in the system browser.');
  const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
  if (!opened) {
    throw new Error('VS Code failed to open the browser URL.');
  }
}

async function updateCurrentPanelTarget(log: (message: string) => void): Promise<void> {
  const uiUrlOverride = getPerfettoUiOverride(log);
  if (uiUrlOverride) {
    const panel = PerfettoPanel.currentPanel;
    if (panel) {
      const uiTarget: PerfettoUiTarget = {
        url: uiUrlOverride,
        label: uiUrlOverride,
        isBundled: false,
      };
      log(`Perfetto UI target changed to ${uiTarget.label}`);
      panel.setUiTarget(uiTarget);
    }
    disposeBundledUiServer();
    return;
  }

  const panel = PerfettoPanel.currentPanel;
  if (!panel) {
    return;
  }

  if (!bundledUiServer) {
    throw new Error('Bundled Perfetto UI server is not initialized.');
  }

  const uiTarget: PerfettoUiTarget = {
    url: await bundledUiServer.getUiUrl(),
    label: 'bundled Perfetto UI',
    isBundled: true,
  };
  log(`Perfetto UI target changed to ${uiTarget.label}`);
  panel.setUiTarget(uiTarget);
}

function disposeBundledUiServer(): void {
  bundledUiServer?.dispose();
}

function getTraceFileName(resource: vscode.Uri): string {
  return path.posix.basename(resource.path) || resource.toString(true);
}

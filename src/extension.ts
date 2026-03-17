import * as path from 'node:path';
import * as vscode from 'vscode';
import { BundledUiServer } from './bundledUiServer';

const COMMAND_OPEN_TRACE = 'vscode-perfetto.openTrace';
const COMMAND_SHOW_OUTPUT = 'vscode-perfetto.showOutput';
const OUTPUT_CHANNEL_NAME = 'Perfetto';
const BUNDLED_UI_LABEL = 'bundled Perfetto UI';

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
      await openTrace(resource ?? vscode.window.activeTextEditor?.document.uri, log);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_SHOW_OUTPUT, () => {
      output.show(true);
    }),
  );
}

async function openTrace(
  traceUri: vscode.Uri | undefined,
  log: (message: string) => void,
): Promise<void> {
  if (!traceUri) {
    void vscode.window.showErrorMessage('Select a file first.');
    return;
  }

  const fileName = getTraceFileName(traceUri);
  const source = traceUri.toString(true);

  log(`Open requested: ${source}`);
  log('Open mode: browser');

  try {
    await openTraceInBrowser(traceUri, log);
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

async function getBundledUiUrl(): Promise<string> {
  if (!bundledUiServer) {
    throw new Error('Bundled Perfetto UI server is not initialized.');
  }

  return bundledUiServer.getUiUrl();
}

async function openTraceInBrowser(traceUri: vscode.Uri, log: (message: string) => void): Promise<void> {
  if (!bundledUiServer) {
    throw new Error('Bundled Perfetto UI server is not initialized.');
  }

  const uiUrl = await getBundledUiUrl();
  const traceUrl = await bundledUiServer.createTraceUrl(traceUri);
  const browserUrl = buildBrowserUrl(uiUrl, traceUrl);

  log(`Perfetto UI: ${BUNDLED_UI_LABEL}`);
  log(`Trace URL: ${traceUrl}`);
  log(`Resolved browser URL: ${browserUrl}`);

  await openInBrowser(browserUrl, log);
}

function buildBrowserUrl(uiUrl: string, traceUrl: string): string {
  const target = new URL(uiUrl);
  target.searchParams.set('vscode-perfetto-disable-background-loads', '1');
  const routeArgs = new URLSearchParams();
  routeArgs.set('url', traceUrl);
  target.hash = `!/?${routeArgs.toString()}`;
  return target.toString();
}

async function openInBrowser(url: string, log: (message: string) => void): Promise<void> {
  const commandList = await vscode.commands.getCommands(true);

  if (!commandList.includes('workbench.action.browser.open')) {
    throw new Error('VS Code integrated browser is unavailable.');
  }

  log('Opening Perfetto in the integrated browser.');
  await vscode.commands.executeCommand('workbench.action.browser.open', url);
}
function getTraceFileName(resource: vscode.Uri): string {
  return path.posix.basename(resource.path) || resource.toString(true);
}

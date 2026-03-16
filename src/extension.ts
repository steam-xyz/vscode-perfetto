import * as path from 'node:path';
import * as vscode from 'vscode';
import { BundledUiServer } from './bundledUiServer';
import { PerfettoPanel, type PerfettoUiTarget } from './perfettoPanel';

const COMMAND_OPEN_TRACE = 'vscode-perfetto.openTrace';
const COMMAND_SHOW_OUTPUT = 'vscode-perfetto.showOutput';
const COMMAND_TEST_GET_STATE = 'vscode-perfetto._test.getState';
const SUPPORTED_EXTENSIONS = new Set(['.json', '.chrom_trace', '.chrome_trace']);
const OUTPUT_CHANNEL_NAME = 'Perfetto';
const MAX_TEST_LOG_LINES = 200;
let bundledUiServer: BundledUiServer | undefined;

type TestState = {
  logs: string[];
};

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  const testState: TestState = {
    logs: [],
  };
  const log = (message: string): void => {
    const line = `[${new Date().toLocaleTimeString('en-GB', { hour12: false })}] ${message}`;
    testState.logs.push(line);
    if (testState.logs.length > MAX_TEST_LOG_LINES) {
      testState.logs.shift();
    }
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

  if (context.extensionMode === vscode.ExtensionMode.Test) {
    context.subscriptions.push(
      vscode.commands.registerCommand(COMMAND_TEST_GET_STATE, () => ({
        logs: [...testState.logs],
      })),
    );
  }
}

async function openTrace(
  context: vscode.ExtensionContext,
  traceUri: vscode.Uri | undefined,
  log: (message: string) => void,
): Promise<void> {
  if (!traceUri || !isSupportedTrace(traceUri)) {
    void vscode.window.showErrorMessage('Select a .json, .chrom_trace or .chrome_trace file first.');
    return;
  }

  const fileName = getTraceFileName(traceUri);
  const source = traceUri.toString(true);
  const uiTarget = await resolvePerfettoUiTarget(log);
  const panel = PerfettoPanel.createOrShow(context.extensionUri, uiTarget, log);

  try {
    log(`Open requested: ${source}`);
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

async function updateCurrentPanelTarget(log: (message: string) => void): Promise<void> {
  const panel = PerfettoPanel.currentPanel;
  if (!panel) {
    return;
  }

  const uiUrlOverride = getPerfettoUiOverride(log);
  if (!uiUrlOverride) {
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
    return;
  }

  const uiTarget: PerfettoUiTarget = {
    url: uiUrlOverride,
    label: uiUrlOverride,
    isBundled: false,
  };
  log(`Perfetto UI target changed to ${uiTarget.label}`);
  panel.setUiTarget(uiTarget);
}

function isSupportedTrace(resource: vscode.Uri): boolean {
  const extension = path.posix.extname(resource.path).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(extension);
}

function getTraceFileName(resource: vscode.Uri): string {
  return path.posix.basename(resource.path) || resource.toString(true);
}

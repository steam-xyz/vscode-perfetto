import * as path from 'node:path';
import * as vscode from 'vscode';

const VIEW_TYPE = 'vscode-perfetto.viewer';
const CHUNK_SIZE = 256 * 1024;

export type PerfettoUiTarget = {
  url: string;
  label: string;
  isBundled: boolean;
};

export class PerfettoPanel implements vscode.Disposable {
  public static currentPanel: PerfettoPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly log: (message: string) => void;
  private readonly onDispose: () => void;
  private uiTarget: PerfettoUiTarget;

  public static createOrShow(
    extensionUri: vscode.Uri,
    uiTarget: PerfettoUiTarget,
    log: (message: string) => void,
    onDispose: () => void,
  ): PerfettoPanel {
    if (PerfettoPanel.currentPanel) {
      PerfettoPanel.currentPanel.panel.reveal(vscode.ViewColumn.Active);
      PerfettoPanel.currentPanel.setUiTarget(uiTarget);
      return PerfettoPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Perfetto', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    });

    PerfettoPanel.currentPanel = new PerfettoPanel(panel, extensionUri, uiTarget, log, onDispose);
    return PerfettoPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    uiTarget: PerfettoUiTarget,
    log: (message: string) => void,
    onDispose: () => void,
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.uiTarget = uiTarget;
    this.log = log;
    this.onDispose = onDispose;
    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((message) => this.handleWebviewMessage(message), null, this.disposables);
    this.log(`Created webview panel for ${this.uiTarget.label}.`);
  }

  public setUiTarget(uiTarget: PerfettoUiTarget): void {
    this.uiTarget = uiTarget;
    this.log(`Webview target set to ${uiTarget.label}.`);
    void this.panel.webview.postMessage({
      type: 'setUiUrl',
      uiUrl: uiTarget.url,
      uiLabel: uiTarget.label,
      uiIsBundled: uiTarget.isBundled,
    });
  }

  public async openTrace(traceUri: vscode.Uri, bytes: Uint8Array): Promise<void> {
    const fileName = path.posix.basename(traceUri.path) || traceUri.toString(true);
    const transferId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const totalChunks = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_SIZE));

    this.panel.title = `Perfetto: ${fileName}`;
    if (this.uiTarget.isBundled) {
      this.log(`Sending ${fileName} to bundled Perfetto UI via webview bridge in ${totalChunks} chunk(s).`);
    } else {
      this.log(`Sending ${fileName} to webview in ${totalChunks} chunk(s) using ${this.uiTarget.label}.`);
    }

    await this.panel.webview.postMessage({
      type: 'openTraceStart',
      transferId,
      uiUrl: this.uiTarget.url,
      uiLabel: this.uiTarget.label,
      uiIsBundled: this.uiTarget.isBundled,
      fileName,
      totalChunks,
      totalBytes: bytes.byteLength,
    });

    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, bytes.byteLength);

      await this.panel.webview.postMessage({
        type: 'openTraceChunk',
        transferId,
        start,
        data: toChunkBuffer(bytes, start, end),
      });
    }

    await this.panel.webview.postMessage({
      type: 'openTraceEnd',
      transferId,
    });

    this.log(`Finished posting ${fileName} to the webview.`);
  }

  public dispose(): void {
    PerfettoPanel.currentPanel = undefined;
    this.log('Webview panel disposed.');
    this.onDispose();

    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  private getHtml(): string {
    const scriptUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.js'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-src https: http:;"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Perfetto</title>
    <style>
      html, body {
        height: 100%;
        margin: 0;
        background: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
        font-family: var(--vscode-font-family);
      }
      body {
        display: grid;
        grid-template-rows: auto 1fr;
      }
      #status {
        padding: 8px 12px;
        font-size: 12px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }
      #frame {
        width: 100%;
        height: 100%;
        border: 0;
      }
    </style>
  </head>
  <body>
    <div id="status">Connecting to ${escapeHtml(this.uiTarget.label)}...</div>
    <iframe id="frame" title="Perfetto UI"></iframe>
    <script nonce="${nonce}">
      window.__PERFETTO_UI_URL__ = ${JSON.stringify(this.uiTarget.url)};
      window.__PERFETTO_UI_LABEL__ = ${JSON.stringify(this.uiTarget.label)};
      window.__PERFETTO_UI_IS_BUNDLED__ = ${JSON.stringify(this.uiTarget.isBundled)};
    </script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  private handleWebviewMessage(message: unknown): void {
    if (!message || typeof message !== 'object') {
      return;
    }

    const type = 'type' in message ? message.type : undefined;
    if (type !== 'log') {
      return;
    }

    const text = 'message' in message ? message.message : undefined;
    if (typeof text === 'string' && text.length > 0) {
      this.log(`Webview: ${text}`);
    }
  }
}

function getNonce(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function toChunkBuffer(bytes: Uint8Array, start: number, end: number): ArrayBuffer {
  const chunk = bytes.subarray(start, end);
  if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength && chunk.buffer instanceof ArrayBuffer) {
    return chunk.buffer;
  }

  const buffer = new Uint8Array(chunk.byteLength);
  buffer.set(chunk);
  return buffer.buffer;
}

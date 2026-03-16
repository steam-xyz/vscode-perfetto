import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import * as vscode from 'vscode';

const CONTENT_TYPES = new Map<string, string>([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.woff2', 'font/woff2'],
]);

const TRACE_SESSION_TTL_MS = 60 * 60 * 1000;

type TraceSession = {
  createdAt: number;
  fileName: string;
  traceUri: vscode.Uri;
};

export class BundledUiServer implements vscode.Disposable {
  private readonly rootPath: string;
  private readonly log: (message: string) => void;
  private readonly traceSessions = new Map<string, TraceSession>();
  private server: http.Server | undefined;
  private externalBaseUrlPromise: Promise<string> | undefined;

  public constructor(extensionUri: vscode.Uri, log: (message: string) => void) {
    this.rootPath = path.join(extensionUri.fsPath, 'perfetto-ui');
    this.log = log;
  }

  public async getUiUrl(): Promise<string> {
    return `${await this.getBaseUrl()}/`;
  }

  public async createTraceUrl(traceUri: vscode.Uri): Promise<string> {
    const baseUrl = await this.getBaseUrl();
    const sessionId = this.createTraceSession(traceUri);
    const fileName = path.posix.basename(traceUri.path) || traceUri.toString(true);
    return `${baseUrl}/api/traces/${encodeURIComponent(sessionId)}/${toTracePathSegment(fileName)}`;
  }

  public dispose(): void {
    this.externalBaseUrlPromise = undefined;
    this.traceSessions.clear();

    if (!this.server) {
      return;
    }

    this.server.close();
    this.server = undefined;
    this.log('Bundled Perfetto UI server stopped.');
  }

  private createTraceSession(traceUri: vscode.Uri): string {
    this.cleanupTraceSessions();

    const fileName = path.posix.basename(traceUri.path) || traceUri.toString(true);
    const sessionId = randomUUID();
    this.traceSessions.set(sessionId, {
      createdAt: Date.now(),
      fileName,
      traceUri,
    });
    this.log(`Created trace session ${sessionId} for ${fileName}.`);
    return sessionId;
  }

  private cleanupTraceSessions(): void {
    const now = Date.now();

    for (const [sessionId, session] of this.traceSessions) {
      if (now - session.createdAt > TRACE_SESSION_TTL_MS) {
        this.traceSessions.delete(sessionId);
      }
    }
  }

  private async getBaseUrl(): Promise<string> {
    if (!this.externalBaseUrlPromise) {
      this.externalBaseUrlPromise = this.start();
    }

    return this.externalBaseUrlPromise;
  }

  private async start(): Promise<string> {
    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server?.off('error', onError);
        reject(error);
      };

      this.server?.once('error', onError);
      this.server?.listen(0, '127.0.0.1', () => {
        this.server?.off('error', onError);
        resolve();
      });
    });

    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to determine bundled Perfetto UI server address.');
    }

    const localUri = vscode.Uri.parse(`http://127.0.0.1:${address.port}`);
    const externalUri = await vscode.env.asExternalUri(localUri);
    const baseUrl = externalUri.toString().replace(/\/$/, '');
    this.log(`Bundled Perfetto UI server listening at ${baseUrl}`);
    return baseUrl;
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      const method = request.method ?? 'GET';
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      if (url.pathname.startsWith('/api/traces/')) {
        await this.handleTraceRequest(url.pathname.slice('/api/traces/'.length), method, response);
        return;
      }

      if (method !== 'GET' && method !== 'HEAD') {
        response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Method Not Allowed');
        return;
      }

      const filePath = this.resolveFilePath(url.pathname);
      if (!filePath) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Bad Request');
        return;
      }

      const stat = await fsPromises.stat(filePath);
      if (!stat.isFile()) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not Found');
        return;
      }

      if (path.basename(filePath) === 'index.html') {
        const indexHtml = await fsPromises.readFile(filePath, 'utf8');
        const responseBody = injectBridgeScript(indexHtml);
        response.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(responseBody),
          'Content-Type': 'text/html; charset=utf-8',
        });
        response.end(method === 'HEAD' ? undefined : responseBody);
        return;
      }

      const extension = path.extname(filePath).toLowerCase();
      const headers: Record<string, string | number> = {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Content-Length': stat.size,
        'Content-Type': CONTENT_TYPES.get(extension) ?? 'application/octet-stream',
      };

      if (path.basename(filePath) === 'service_worker.js') {
        headers['Service-Worker-Allowed'] = '/';
      }

      response.writeHead(200, headers);
      if (method === 'HEAD') {
        response.end();
        return;
      }

      response.end(await fsPromises.readFile(filePath));
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }

      const code = isNodeError(error) && error.code === 'ENOENT' ? 404 : 500;
      response.writeHead(code, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'text/plain; charset=utf-8',
      });
      response.end(code === 404 ? 'Not Found' : 'Internal Server Error');
    }
  }

  private async handleTraceRequest(
    requestPath: string,
    method: string,
    response: http.ServerResponse,
  ): Promise<void> {
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'text/plain; charset=utf-8',
      });
      response.end('Method Not Allowed');
      return;
    }

    this.cleanupTraceSessions();

    const [encodedSessionId] = requestPath.split('/', 1);
    const sessionId = decodeURIComponent(encodedSessionId ?? '');
    const session = this.traceSessions.get(sessionId);

    if (!session) {
      response.writeHead(404, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
      });
      response.end('Unknown trace session');
      return;
    }

    if (session.traceUri.scheme === 'file') {
      await this.handleLocalTraceRequest(session, method, response);
      return;
    }

    const bytes = await vscode.workspace.fs.readFile(session.traceUri);
    this.writeTraceHeaders(response, bytes.byteLength, session.fileName);
    response.end(method === 'HEAD' ? undefined : Buffer.from(bytes));
  }

  private async handleLocalTraceRequest(
    session: TraceSession,
    method: string,
    response: http.ServerResponse,
  ): Promise<void> {
    const stat = await fsPromises.stat(session.traceUri.fsPath);
    if (!stat.isFile()) {
      response.writeHead(404, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
      });
      response.end('Not Found');
      return;
    }

    this.writeTraceHeaders(response, stat.size, session.fileName);
    if (method === 'HEAD') {
      response.end();
      return;
    }

    await pipeline(fs.createReadStream(session.traceUri.fsPath), response);
  }

  private writeTraceHeaders(response: http.ServerResponse, contentLength: number, fileName: string): void {
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Disposition',
      'Cache-Control': 'no-store',
      'Content-Disposition': `inline; filename="${escapeHeaderValue(fileName)}"`,
      'Content-Length': contentLength,
      'Content-Type': 'application/octet-stream',
    });
  }

  private resolveFilePath(requestUrl: string): string | undefined {
    const url = new URL(requestUrl, 'http://127.0.0.1');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') {
      pathname = '/index.html';
    }

    const resolvedPath = path.resolve(this.rootPath, `.${pathname}`);
    const rootPrefix = this.rootPath.endsWith(path.sep) ? this.rootPath : `${this.rootPath}${path.sep}`;
    if (resolvedPath !== this.rootPath && !resolvedPath.startsWith(rootPrefix)) {
      return undefined;
    }

    return resolvedPath;
  }
}

function injectBridgeScript(html: string): string {
  const bridgeScript = `<script type="text/javascript">
    'use strict';
    (function () {
      const LOG_KEY = '__vscodePerfettoLog__';
      const STATE_KEY = '__vscodePerfettoState__';
      let pendingTrace = undefined;
      let readyNotified = false;
      let readyTimerId = undefined;

      function postMessageToHost(key, payload) {
        try {
          if (!window.parent || window.parent === window) {
            return;
          }

          window.parent.postMessage({
            [key]: payload,
          }, '*');
        } catch (_) {
          // Best-effort bridge only.
        }
      }

      function formatLogArg(value) {
        if (typeof value === 'string') {
          return value;
        }

        if (value instanceof Error) {
          return value.stack || value.message;
        }

        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      }

      function postLog(level, args) {
        postMessageToHost(LOG_KEY, {
          level,
          message: args.map(formatLogArg).join(' '),
        });
      }

      function postState(code, message) {
        postMessageToHost(STATE_KEY, {
          code,
          message,
        });
      }

      function canOpenTraceDirectly() {
        return !!(window.app && typeof window.app.openTraceFromBuffer === 'function');
      }

      function openTraceDirectly(trace) {
        if (!canOpenTraceDirectly()) {
          pendingTrace = trace;
          postLog('debug', ['Buffered trace until Perfetto UI became ready:', trace.title]);
          return;
        }

        pendingTrace = undefined;
        try {
          window.app.openTraceFromBuffer({
            buffer: trace.buffer,
            title: trace.title,
          });
          postLog('info', ['Opened trace via direct bridge:', trace.title]);
        } catch (error) {
          postLog('error', ['Failed to open trace via direct bridge:', error]);
        }
      }

      function maybeNotifyReady() {
        if (readyNotified || !canOpenTraceDirectly()) {
          return;
        }

        readyNotified = true;
        if (readyTimerId !== undefined) {
          window.clearInterval(readyTimerId);
          readyTimerId = undefined;
        }
        postState('trace_ready', 'Perfetto UI is ready to receive traces.');
        if (pendingTrace) {
          openTraceDirectly(pendingTrace);
        }
      }

      function earlyMessageHandler(event) {
        const data = event.data;
        if (data === 'PING') {
          event.stopImmediatePropagation();
          event.source?.postMessage('PONG', '*');
          return;
        }

        if (!data || typeof data !== 'object' || data.__vscodePerfettoOpenTrace__ !== true) {
          return;
        }

        event.stopImmediatePropagation();
        openTraceDirectly(data);
      }

      for (const level of ['debug', 'info', 'log', 'warn', 'error']) {
        const original = typeof console[level] === 'function' ? console[level].bind(console) : console.log.bind(console);
        console[level] = (...args) => {
          original(...args);
          postLog(level, args);
        };
      }

      window.addEventListener('error', (event) => {
        postLog('error', [event.error?.stack || event.error?.message || event.message || 'Unknown iframe error']);
      });
      window.addEventListener('unhandledrejection', (event) => {
        postLog('error', ['Unhandled rejection:', event.reason instanceof Error ? event.reason.stack || event.reason.message : formatLogArg(event.reason)]);
      });
      window.addEventListener('message', earlyMessageHandler, { capture: true, passive: true });
      window.addEventListener('load', maybeNotifyReady);
      readyTimerId = window.setInterval(maybeNotifyReady, 100);
      postLog('debug', ['Perfetto UI bridge installed.']);
    })();
  </script>`;

  return html.replace('</body>', `  ${bridgeScript}\n</body>`);
}

function escapeHeaderValue(value: string): string {
  return value.replaceAll(/[\r\n"]/g, '_');
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return !!value && typeof value === 'object' && 'code' in value;
}

function toTracePathSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'trace.pftrace';
  }

  return trimmed.replaceAll(/[^A-Za-z0-9._-]+/g, '_');
}

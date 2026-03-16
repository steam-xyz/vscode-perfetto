const vscode = acquireVsCodeApi();
const frame = document.getElementById('frame');
const status = document.getElementById('status');

let uiUrl = window.__PERFETTO_UI_URL__ || 'https://ui.perfetto.dev';
let uiLabel = window.__PERFETTO_UI_LABEL__ || 'Perfetto UI';
let uiIsBundled = window.__PERFETTO_UI_IS_BUNDLED__ === true;
let uiOrigin = getOrigin(uiUrl);
let ready = false;
let traceReceiverReady = false;
let pingTimer = undefined;
let transfer = undefined;
let pendingTrace = undefined;
let waitStartedAt = 0;
let lastWaitLogAt = -1;

setUiUrl(uiUrl, uiLabel, uiIsBundled);
log(`Panel initialized. Target UI: ${uiLabel}. Bundled: ${uiIsBundled}.`);

window.addEventListener('message', (event) => {
  if (isPerfettoUiLogMessage(event.data) && isLikelyBundledFrameEvent(event)) {
    log(`Perfetto UI ${event.data.__vscodePerfettoLog__.level}: ${event.data.__vscodePerfettoLog__.message}`);
    return;
  }

  if (isPerfettoUiStateMessage(event.data) && isLikelyBundledFrameEvent(event)) {
    if (event.data.__vscodePerfettoState__.code === 'trace_ready') {
      traceReceiverReady = true;
      openPendingTrace();
    }
    log(`Perfetto UI state: ${event.data.__vscodePerfettoState__.message}`);
    return;
  }

  if (event.data === 'PONG' && event.source === frame.contentWindow && event.origin === uiOrigin) {
    ready = true;
    stopPing();
    const waitMs = waitStartedAt > 0 ? Date.now() - waitStartedAt : 0;
    log(`Received PONG from Perfetto UI after ${waitMs} ms.`);
    openPendingTrace();
    return;
  }

  if (event.source === frame.contentWindow) {
    return;
  }

  const message = event.data;
  if (!message || typeof message !== 'object') {
    return;
  }

  if (message.type === 'setUiUrl') {
    setUiUrl(message.uiUrl, message.uiLabel, message.uiIsBundled);
    return;
  }

  if (message.type === 'openTraceStart') {
    setUiUrl(message.uiUrl, message.uiLabel, message.uiIsBundled);
    transfer = {
      transferId: message.transferId,
      fileName: message.fileName,
      totalBytes: message.totalBytes,
      chunks: new Array(message.totalChunks),
    };
    log(`Receiving trace ${message.fileName}, ${message.totalBytes} bytes in ${message.totalChunks} chunk(s).`);
    setStatus(`Loading ${message.fileName}...`);
    return;
  }

  if (message.type === 'openTraceChunk' && transfer && message.transferId === transfer.transferId) {
    transfer.chunks[message.index] = decodeBase64(message.data);
    return;
  }

  if (message.type === 'openTraceEnd' && transfer && message.transferId === transfer.transferId) {
    pendingTrace = {
      fileName: transfer.fileName,
      buffer: joinChunks(transfer.chunks, transfer.totalBytes),
    };
    log(`Trace ${transfer.fileName} is buffered in the webview.`);
    transfer = undefined;
    openPendingTrace();
  }
});

frame.addEventListener('load', () => {
  if (uiIsBundled) {
    ready = true;
    setStatus(`Opened ${uiLabel}`);
    log(`Iframe loaded for ${uiLabel}.`);
    openPendingTrace();
    return;
  }

  ready = false;
  waitStartedAt = Date.now();
  lastWaitLogAt = -1;
  log(`Iframe loaded for ${uiLabel}. Waiting for PONG.`);
  startPing();
});

function setUiUrl(nextUiUrl, nextUiLabel, nextUiIsBundled) {
  if (typeof nextUiUrl !== 'string' || nextUiUrl.length === 0) {
    return;
  }

  uiUrl = nextUiUrl;
  if (typeof nextUiLabel === 'string' && nextUiLabel.length > 0) {
    uiLabel = nextUiLabel;
  }
  uiIsBundled = nextUiIsBundled === true;
  uiOrigin = getOrigin(uiUrl);
  ready = false;
  traceReceiverReady = false;
  stopPing();
  setStatus(`Connecting to ${uiLabel}...`);
  log(`Connecting iframe to ${uiLabel}. Bundled: ${uiIsBundled}.`);

  if (!sameUrl(frame.src, uiUrl)) {
    frame.src = uiUrl;
  } else {
    if (uiIsBundled) {
      ready = true;
      setStatus(`Opened ${uiLabel}`);
    } else {
      startPing();
    }
  }
}

function startPing() {
  stopPing();
  ping();
  pingTimer = window.setInterval(ping, 1000);
}

function stopPing() {
  if (pingTimer === undefined) {
    return;
  }

  window.clearInterval(pingTimer);
  pingTimer = undefined;
}

function ping() {
  if (!frame.contentWindow) {
    return;
  }

  updateWaitingStatus();

  try {
    frame.contentWindow.postMessage('PING', uiOrigin);
  } catch (error) {
    log(`Failed to post PING to ${uiLabel}: ${toErrorMessage(error)}`);
    setStatus(`Connecting to ${uiLabel}...`);
  }
}

function openPendingTrace() {
  if (!ready || !pendingTrace || !frame.contentWindow) {
    if (pendingTrace) {
      updateWaitingStatus();
    }
    return;
  }

  if (uiIsBundled && !traceReceiverReady) {
    updateWaitingStatus();
    return;
  }

  frame.contentWindow.postMessage(
    uiIsBundled
      ? {
          __vscodePerfettoOpenTrace__: true,
          buffer: pendingTrace.buffer,
          title: pendingTrace.fileName,
        }
      : {
          perfetto: {
            buffer: pendingTrace.buffer,
            title: pendingTrace.fileName,
          },
        },
    uiOrigin,
    [pendingTrace.buffer],
  );

  log(`Trace ${pendingTrace.fileName} sent to Perfetto UI.`);
  setStatus(`Opened ${pendingTrace.fileName}`);
  pendingTrace = undefined;
}

function setStatus(text) {
  status.textContent = text;
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function joinChunks(chunks, totalBytes) {
  const buffer = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    if (!chunk) {
      continue;
    }

    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return buffer.buffer;
}

function getOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return 'https://ui.perfetto.dev';
  }
}

function isPerfettoUiLogMessage(value) {
  return !!(
    value &&
    typeof value === 'object' &&
    '__vscodePerfettoLog__' in value &&
    value.__vscodePerfettoLog__ &&
    typeof value.__vscodePerfettoLog__ === 'object' &&
    typeof value.__vscodePerfettoLog__.level === 'string' &&
    typeof value.__vscodePerfettoLog__.message === 'string'
  );
}

function isPerfettoUiStateMessage(value) {
  return !!(
    value &&
    typeof value === 'object' &&
    '__vscodePerfettoState__' in value &&
    value.__vscodePerfettoState__ &&
    typeof value.__vscodePerfettoState__ === 'object' &&
    typeof value.__vscodePerfettoState__.code === 'string' &&
    typeof value.__vscodePerfettoState__.message === 'string'
  );
}

function isLikelyBundledFrameEvent(event) {
  return uiIsBundled && (event.source === frame.contentWindow || event.source === null || event.origin === uiOrigin);
}

function sameUrl(left, right) {
  if (!left || !right) {
    return left === right;
  }

  try {
    return new URL(left, window.location.href).toString() === new URL(right, window.location.href).toString();
  } catch {
    return left === right;
  }
}

function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function updateWaitingStatus() {
  if (ready) {
    if (pendingTrace && uiIsBundled && !traceReceiverReady) {
      setStatus(`Waiting for ${uiLabel} to accept traces...`);
    }
    return;
  }

  const elapsedSeconds = waitStartedAt > 0 ? Math.floor((Date.now() - waitStartedAt) / 1000) : 0;
  const traceSuffix = pendingTrace ? ' Trace is ready and will open automatically.' : '';
  const debugSuffix = elapsedSeconds >= 5 ? ' See Perfetto output for details.' : '';
  setStatus(`Waiting for ${uiLabel}... ${elapsedSeconds}s.${traceSuffix}${debugSuffix}`);

  if (elapsedSeconds >= 5 && elapsedSeconds % 5 === 0 && elapsedSeconds !== lastWaitLogAt) {
    lastWaitLogAt = elapsedSeconds;
    log(`Still waiting for ${uiLabel}. ${elapsedSeconds}s elapsed.${pendingTrace ? ' Trace is buffered.' : ''}`);
  }
}

function log(message) {
  vscode.postMessage({
    type: 'log',
    message,
  });
}

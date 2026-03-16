import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const COMMAND_OPEN_TRACE = 'vscode-perfetto.openTrace';
const COMMAND_TEST_GET_STATE = 'vscode-perfetto._test.getState';
const TRACE_FILE_NAME = 'softmax.chrome_trace';
const PERFETTO_TAB_LABEL = `Perfetto: ${TRACE_FILE_NAME}`;
const SENT_TRACE_LOG = `Trace ${TRACE_FILE_NAME} sent to Perfetto UI.`;

type TestState = {
  logs: string[];
};

suite('vscode-perfetto e2e', () => {
  let printedLogCount = 0;

  teardown(async function () {
    const state = await getTestState();
    if (!state) {
      return;
    }

    const newLogs = state.logs.slice(printedLogCount);
    printedLogCount = state.logs.length;
    if (newLogs.length === 0) {
      return;
    }

    const testTitle = this.currentTest?.fullTitle() ?? 'unknown test';
    console.log(formatPerfettoLogs(testTitle, newLogs));
  });

  test('opens a trace in the Perfetto webview panel', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'Expected the extension test workspace to be open.');

    const traceUri = vscode.Uri.joinPath(workspaceFolder.uri, 'demos', TRACE_FILE_NAME);
    await vscode.commands.executeCommand(COMMAND_OPEN_TRACE, traceUri);

    await waitFor(async () => {
      const tabLabels = getAllTabLabels();
      assert.ok(
        tabLabels.includes(PERFETTO_TAB_LABEL),
        `Expected to find ${PERFETTO_TAB_LABEL}. Visible tabs: ${tabLabels.join(', ') || '(none)'}.`,
      );
    });

    await waitFor(async () => {
      const state = await getTestState();
      assert.ok(state, 'Expected test state to be available in extension test mode.');
      assert.ok(state.logs.some((line) => line.includes(`Trace queued for ${TRACE_FILE_NAME}.`)), `Missing queued log.\n${state.logs.join('\n')}`);
      assert.ok(state.logs.some((line) => line.includes(SENT_TRACE_LOG)), `Missing trace sent log.\n${state.logs.join('\n')}`);
    });
  });
});

async function getTestState(): Promise<TestState | undefined> {
  return vscode.commands.executeCommand<TestState>(COMMAND_TEST_GET_STATE);
}

async function waitFor(
  check: () => void | Promise<void>,
  timeoutMs = 30_000,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      await delay(intervalMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Timed out.'));
}

function getAllTabLabels(): string[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.label));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatPerfettoLogs(testTitle: string, logs: string[]): string {
  const lines = [`[Perfetto output] ${testTitle}`];
  for (const line of logs) {
    lines.push(`  ${line}`);
  }
  return lines.join('\n');
}

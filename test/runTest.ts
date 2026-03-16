import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite');
  const testWorkspacePath = extensionDevelopmentPath;
  const vscodeExecutablePath = resolveInstalledVSCodeExecutable();

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    extensionTestsEnv: {
      VSCODE_PERFETTO_TEST_MODE: '1',
    },
    launchArgs: [
      testWorkspacePath,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-release-notes',
      '--skip-welcome',
      '--new-window',
    ],
  });
}

function resolveInstalledVSCodeExecutable(): string {
  const cliPath = resolveCodeCliPath();
  const executablePath = toMacExecutableFromCli(cliPath);
  if (executablePath) {
    return executablePath;
  }

  throw new Error(
    [
      `Unable to resolve the Visual Studio Code app from ${cliPath}.`,
      'Make sure `code` points to the desktop VS Code installation.',
    ].join('\n'),
  );
}

function resolveCodeCliPath(): string {
  try {
    const cliPath = execFileSync('which', ['code'], {
      encoding: 'utf8',
    }).trim();
    if (!cliPath) {
      throw new Error('Empty `which code` result.');
    }

    return cliPath;
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to find \`code\` in PATH.\n${details}`);
  }
}

function toMacExecutableFromCli(cliPath: string): string | undefined {
  try {
    const resolvedCliPath = fs.realpathSync(cliPath);
    const suffix = path.join('Contents', 'Resources', 'app', 'bin', 'code');
    if (!resolvedCliPath.endsWith(suffix)) {
      return undefined;
    }

    const appRoot = resolvedCliPath.slice(0, -suffix.length);
    const executablePath = path.join(appRoot, 'Contents', 'MacOS', 'Code');
    return fs.existsSync(executablePath) ? executablePath : undefined;
  } catch {
    return undefined;
  }
}

void main().catch((error) => {
  console.error('Failed to run VS Code e2e tests.');
  console.error(error);
  process.exit(1);
});

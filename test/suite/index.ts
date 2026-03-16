import * as fs from 'node:fs';
import * as path from 'node:path';
import Mocha from 'mocha';

export async function run(): Promise<void> {
  const mocha = new Mocha({
    color: true,
    timeout: 120_000,
    ui: 'tdd',
  });

  const testsRoot = __dirname;
  for (const fileName of fs.readdirSync(testsRoot)) {
    if (!fileName.endsWith('.test.js')) {
      continue;
    }

    mocha.addFile(path.join(testsRoot, fileName));
  }

  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} test(s) failed.`));
        return;
      }

      resolve();
    });
  });
}

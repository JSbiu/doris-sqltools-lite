'use strict';

const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const projectRoot = path.resolve(__dirname, '../..');
  const exitCode = await runTests({
    version: process.env.VSCODE_TEST_VERSION || '1.90.0',
    extensionDevelopmentPath: projectRoot,
    extensionTestsPath: path.join(__dirname, 'suite'),
    launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

'use strict';

// Installs the current VSIX into an isolated VS Code profile and activates it
// through the official test runner. `test:vscode` loads the source directory,
// so this check covers the packaged VSIX path instead.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} = require('@vscode/test-electron');

const projectRoot = path.resolve(__dirname, '..');
const manifest = require(path.join(projectRoot, 'package.json'));

function parseOptions(argv) {
  const options = {};
  for (const argument of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    if (!match) throw new Error(`Invalid argument: ${argument}`);
    options[match[1]] = match[2];
  }
  return options;
}

function removeTemporaryDirectory(target) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(target);
  const relative = path.relative(temporaryRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
      || !path.basename(resolved).startsWith('doris-sqltools-install-')) {
    throw new Error(`Refusing to remove unexpected directory: ${resolved}`);
  }
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch {
    // Chrome/VS Code can keep a short-lived handle; the OS temp directory owns it.
  }
}

function runCli(cli, args, commandArgs) {
  const result = childProcess.spawnSync(cli, [...args, ...commandArgs], {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`${commandArgs.join(' ')} failed:\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const vscodeVersion = options['vscode-version']
    ?? process.env.VSCODE_TEST_VERSION
    ?? '1.90.0';
  const vsixPath = path.resolve(projectRoot, options.vsix
    ?? `${manifest.name}-${manifest.version}.vsix`);
  assert.ok(fs.existsSync(vsixPath), `VSIX not found: ${vsixPath}`);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'doris-sqltools-install-'));
  const extensionsDir = path.join(profile, 'extensions');
  const userDataDir = path.join(profile, 'user-data');
  const devExtension = path.join(profile, 'dev-extension');
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(devExtension, { recursive: true });
  const probePackage = {
    name: 'doris-sqltools-install-probe',
    publisher: 'local',
    version: '1.0.0',
    main: './probe.js',
    engines: { vscode: '^1.90.0' },
    activationEvents: [],
  };
  fs.writeFileSync(path.join(devExtension, 'package.json'), JSON.stringify(probePackage, null, 2));
  fs.writeFileSync(path.join(devExtension, 'probe.js'), 'exports.activate = () => {};\n');

  let success = false;
  try {
    console.log(`Checking packaged VSIX in VS Code ${vscodeVersion}`);
    const executable = await downloadAndUnzipVSCode({ version: vscodeVersion });
    const [cli, ...resolvedArgs] = resolveCliArgsFromVSCodeExecutablePath(executable);
    const profileArgs = resolvedArgs
      .filter((argument) => !/^--(?:extensions|user-data)-dir=/.test(argument))
      .concat(`--extensions-dir=${extensionsDir}`, `--user-data-dir=${userDataDir}`);

    const before = runCli(cli, profileArgs, ['--list-extensions', '--show-versions']);
    assert.ok(!before.includes(`${manifest.publisher}.${manifest.name}@`), 'isolated profile already has the extension');
    runCli(cli, profileArgs, ['--install-extension', vsixPath, '--force']);
    const after = runCli(cli, profileArgs, ['--list-extensions', '--show-versions']);
    const expected = `${manifest.publisher}.${manifest.name}@${manifest.version}`;
    assert.ok(after.split(/\r?\n/).some((line) => line.trim() === expected), `CLI did not list ${expected}:\n${after}`);

    const exitCode = await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: devExtension,
      extensionTestsPath: path.join(projectRoot, 'tests', 'vscode-install-suite.js'),
      extensionTestsEnv: {
        DORIS_SQLTOOLS_EXPECTED_ID: `${manifest.publisher}.${manifest.name}`,
        DORIS_SQLTOOLS_EXPECTED_VERSION: manifest.version,
      },
      launchArgs: [
        `--extensions-dir=${extensionsDir}`,
        `--user-data-dir=${userDataDir}`,
        '--disable-workspace-trust',
      ],
    });
    assert.equal(exitCode, 0, `VSIX activation test exited with ${exitCode}`);
    success = true;
    console.log(`VSIX install check passed: ${expected} (${vscodeVersion})`);
  } finally {
    if (!success) console.error(`Isolated profile kept for diagnosis: ${profile}`);
    else removeTemporaryDirectory(profile);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

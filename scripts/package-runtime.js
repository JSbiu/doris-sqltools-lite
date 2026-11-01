'use strict';

// Packages the extension as a VSIX.
//
// This used to be a lot longer: under pnpm's isolated node_modules, vsce's
// `--dependencies` collection could not see the transitive tree, so the script
// hand-built junction links for every runtime package and wrote a fake npm.cmd
// that answered `npm ls` with the list. The runtime is a single esbuild bundle
// now, so none of that is needed — build the bundle, then let vsce package it
// without dragging node_modules along.

const childProcess = require('node:child_process');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const packageManifest = require(path.join(projectRoot, 'package.json'));
const vsceCommand = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vsce.CMD' : 'vsce',
);
const vsixPath = path.join(projectRoot, `${packageManifest.name}-${packageManifest.version}.vsix`);

function run(command, args, options) {
  return childProcess.spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    ...options,
  });
}

let exitCode = 0;
try {
  const build = run(process.execPath, [path.join(__dirname, 'build.js')]);
  if (build.status !== 0) {
    exitCode = build.status ?? 1;
  } else {
    const result = run(vsceCommand, ['package', '--no-dependencies'], { shell: true });
    if (result.status !== 0) {
      exitCode = result.status ?? 1;
    } else {
      const check = run(process.execPath, [path.join(__dirname, 'check-vsix.js'), vsixPath]);
      exitCode = check.status ?? 1;
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  exitCode = 1;
}

process.exitCode = exitCode;

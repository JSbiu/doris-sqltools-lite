'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const nodeModules = path.join(projectRoot, 'node_modules');
const packagingDirectory = path.join(projectRoot, '.packaging');
const vsceCommand = path.join(nodeModules, '.bin', 'vsce.CMD');
const createdLinks = [];

function readPackage(packageRoot) {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
}

function findPackageRoot(filePath) {
  let current = path.dirname(filePath);
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    current = path.dirname(current);
  }
  throw new Error(`Cannot find package root for ${filePath}`);
}

function collectRuntimePackages() {
  const queue = [{ name: 'mysql2', root: path.join(nodeModules, 'mysql2') }];
  const seen = new Set();
  const packages = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current.root)) {
      continue;
    }
    seen.add(current.root);
    const manifest = readPackage(current.root);
    const lookupRoot = fs.realpathSync(current.root);
    packages.push(current);

    for (const dependencyName of Object.keys(manifest.dependencies ?? {})) {
      const resolved = require.resolve(dependencyName, { paths: [lookupRoot] });
      queue.push({
        name: dependencyName,
        root: findPackageRoot(resolved),
      });
    }
  }

  return packages;
}

function ensureRootLinks(packages) {
  for (const dependency of packages) {
    const linkPath = path.join(nodeModules, ...dependency.name.split('/'));
    if (fs.existsSync(linkPath)) {
      continue;
    }
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(dependency.root, linkPath, 'junction');
    createdLinks.push(linkPath);
  }
}

function writeNpmShim(packages) {
  fs.mkdirSync(packagingDirectory, { recursive: true });
  const packagePaths = [projectRoot, ...packages.map((dependency) => path.join(nodeModules, dependency.name))];
  const lines = [
    '@echo off',
    'if "%~1"=="-v" (',
    '  echo 10.9.0',
    '  exit /b 0',
    ')',
    'if /I "%~1"=="list" (',
    ...packagePaths.map((packagePath) => `  echo ${packagePath}`),
    '  exit /b 0',
    ')',
    'exit /b 1',
    '',
  ];
  fs.writeFileSync(path.join(packagingDirectory, 'npm.cmd'), lines.join('\r\n'), 'utf8');
}

function cleanup() {
  for (const linkPath of createdLinks.reverse()) {
    fs.rmSync(linkPath, { recursive: true, force: true });
  }
  fs.rmSync(packagingDirectory, { recursive: true, force: true });
}

let exitCode = 0;
try {
  const packages = collectRuntimePackages();
  ensureRootLinks(packages);
  writeNpmShim(packages);
  const environment = {
    ...process.env,
    PATH: [packagingDirectory, process.env.PATH].filter(Boolean).join(path.delimiter),
  };
  const result = childProcess.spawnSync(
    vsceCommand,
    ['package', '--dependencies', '--follow-symlinks'],
    { cwd: projectRoot, env: environment, shell: true, stdio: 'inherit' },
  );
  exitCode = result.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  exitCode = 1;
} finally {
  cleanup();
}

process.exitCode = exitCode;

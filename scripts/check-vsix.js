'use strict';

// Checks the VSIX that was actually produced, not the project directory that
// vsce intends to package. The ZIP reader is deliberately small: a VSIX is a
// regular ZIP, and keeping the check dependency-free lets it run on Windows,
// Linux and macOS with the same Node.js entry point.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const projectRoot = path.resolve(__dirname, '..');
const EXTENSION_PREFIX = 'extension/';

const FORBIDDEN_PREFIXES = [
  '.git',
  '.github',
  '.local',
  '.packaging',
  '.vscode',
  '.vscode-test',
  '.workbuddy',
  'node_modules',
  'out',
  'scripts',
  'skills',
  'src',
  'tests',
];

const FORBIDDEN_FILES = new Set([
  '.gitignore',
  '.gitattributes',
  '.vscodeignore',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'eslint.config.mjs',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
]);

const FORBIDDEN_SUFFIXES = ['.map', '.tsbuildinfo', '.vsix'];

function normalizeZipPath(name) {
  return name.replace(/\\/g, '/').replace(/^\.\//, '');
}

function readUInt64LE(buffer, offset) {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('ZIP64 entry is too large to inspect safely');
  }
  return Number(value);
}

function findEndOfCentralDirectory(buffer) {
  const signature = 0x06054b50;
  const minimum = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) {
      return offset;
    }
  }
  throw new Error('end-of-central-directory record not found');
}

function readZipEntries(filePath) {
  const buffer = fs.readFileSync(filePath);
  const endOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('ZIP64 VSIX files are not supported by this local check');
  }

  const entries = new Map();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`invalid central-directory entry at offset ${offset}`);
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = normalizeZipPath(buffer.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.startsWith('/') || name.split('/').includes('..')) {
      throw new Error(`unsafe ZIP entry path: ${name}`);
    }
    if (entries.has(name)) {
      throw new Error(`duplicate ZIP entry: ${name}`);
    }
    if (name.endsWith('/')) {
      continue;
    }
    if ((flags & 0x1) !== 0) {
      throw new Error(`${name} is encrypted`);
    }
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`${name} has an invalid local header`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);

    let contents;
    if (compression === 0) {
      contents = Buffer.from(compressed);
    } else if (compression === 8) {
      contents = zlib.inflateRawSync(compressed);
    } else {
      throw new Error(`${name} uses unsupported compression method ${compression}`);
    }
    entries.set(name, contents);
  }

  return entries;
}

function escapeRegExp(character) {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function globToRegExp(pattern) {
  let normalized = normalizeZipPath(pattern);
  if (normalized.startsWith('/')) {
    normalized = normalized.slice(1);
  }
  if (normalized.endsWith('/')) {
    normalized += '**';
  }

  const hasSlash = normalized.includes('/');
  let expression = hasSlash ? '^' : '^(?:.*/)?';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '*' && normalized[index + 1] === '*') {
      index += 1;
      if (normalized[index + 1] === '/') {
        index += 1;
        expression += '(?:.*/)?';
      } else {
        expression += '.*';
      }
    } else if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += escapeRegExp(character);
    }
  }
  return new RegExp(`${expression}$`);
}

function matchesIgnorePattern(relativePath, pattern) {
  return globToRegExp(pattern).test(normalizeZipPath(relativePath));
}

function isIgnoredByPatterns(relativePath, patterns) {
  let ignored = false;
  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim();
    if (!pattern || pattern.startsWith('#')) {
      continue;
    }
    const negated = pattern.startsWith('!');
    const glob = negated ? pattern.slice(1) : pattern;
    if (matchesIgnorePattern(relativePath, glob)) {
      ignored = !negated;
    }
  }
  return ignored;
}

function extensionEntries(entries) {
  const relative = new Map();
  for (const [name, contents] of entries) {
    if (name.startsWith(EXTENSION_PREFIX)) {
      relative.set(name.slice(EXTENSION_PREFIX.length), contents);
    }
  }
  return relative;
}

function findCaseInsensitive(entries, wanted) {
  const lower = wanted.toLowerCase();
  for (const [name, contents] of entries) {
    if (name.toLowerCase() === lower) {
      return { name, contents };
    }
  }
  return undefined;
}

function packageField(manifest, field) {
  return typeof manifest[field] === 'string' ? manifest[field] : undefined;
}

function validateVsixEntries(entries, expectedManifest, ignorePatterns = []) {
  const problems = [];
  const relative = extensionEntries(entries);
  const packaged = relative.size;
  const packageEntry = relative.get('package.json');
  if (!packageEntry) {
    problems.push('package.json is missing from the VSIX');
  }

  let manifest;
  if (packageEntry) {
    try {
      manifest = JSON.parse(packageEntry.toString('utf8'));
    } catch (error) {
      problems.push(`package.json is not valid JSON: ${error.message}`);
    }
  }

  if (manifest) {
    const expectedId = `${expectedManifest.publisher}.${expectedManifest.name}`;
    const actualId = `${packageField(manifest, 'publisher') ?? ''}.${packageField(manifest, 'name') ?? ''}`;
    if (actualId !== expectedId) {
      problems.push(`package ID is ${actualId || '(missing)'}, expected ${expectedId}`);
    }
    if (packageField(manifest, 'displayName') !== expectedManifest.displayName) {
      problems.push(
        `displayName is ${JSON.stringify(manifest.displayName)}, expected ${JSON.stringify(expectedManifest.displayName)}`,
      );
    }
    if (packageField(manifest, 'version') !== expectedManifest.version) {
      problems.push(
        `version is ${JSON.stringify(manifest.version)}, expected ${JSON.stringify(expectedManifest.version)}`,
      );
    }
    if (packageField(manifest, 'main') !== expectedManifest.main) {
      problems.push(
        `main is ${JSON.stringify(manifest.main)}, expected ${JSON.stringify(expectedManifest.main)}`,
      );
    }
  }

  const runtimePath = normalizeZipPath(String(expectedManifest.main ?? '').replace(/^\.\//, ''));
  const requiredFiles = [
    ['dist/extension.js', 'runtime bundle'],
    ['readme.md', 'README'],
    ['license.txt', 'LICENSE'],
    ['media/icon.svg', 'icon'],
  ];
  for (const [name, label] of requiredFiles) {
    const found = findCaseInsensitive(relative, name);
    if (!found) {
      problems.push(`${label} is missing from the VSIX (expected ${name})`);
    } else if (found.contents.length === 0) {
      problems.push(`${label} is empty in the VSIX (${found.name})`);
    }
  }
  if (runtimePath && runtimePath !== 'dist/extension.js' && !relative.has(runtimePath)) {
    problems.push(`main entry ${runtimePath} is missing from the VSIX`);
  }

  const forbidden = new Map();
  const addForbidden = (name, reason) => {
    const reasons = forbidden.get(name) ?? [];
    if (!reasons.includes(reason)) {
      reasons.push(reason);
    }
    forbidden.set(name, reasons);
  };

  for (const name of relative.keys()) {
    const topLevel = name.split('/')[0];
    if (FORBIDDEN_PREFIXES.includes(topLevel)) {
      addForbidden(name, `${topLevel} is excluded by the local packaging contract`);
    }
    if (FORBIDDEN_FILES.has(name)) {
      addForbidden(name, 'development file is not part of the runtime package');
    }
    if (FORBIDDEN_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
      addForbidden(name, `${path.posix.extname(name) || name} files are not part of the runtime package`);
    }
    if (isIgnoredByPatterns(name, ignorePatterns)) {
      addForbidden(name, 'matches a .vscodeignore exclusion');
    }
  }
  for (const [name, reasons] of forbidden) {
    problems.push(`${name} must not be packaged (${reasons.join('; ')})`);
  }

  return { problems, packaged, ignorePatterns: ignorePatterns.length };
}

function readIgnorePatterns() {
  const ignorePath = path.join(projectRoot, '.vscodeignore');
  const contents = fs.readFileSync(ignorePath, 'utf8');
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function runCheck(filePath) {
  const expectedManifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const ignorePatterns = readIgnorePatterns();
  const entries = readZipEntries(filePath);
  const result = validateVsixEntries(entries, expectedManifest, ignorePatterns);

  if (result.problems.length > 0) {
    console.error(`VSIX check failed: ${filePath}`);
    for (const problem of result.problems) {
      console.error(`  - ${problem}`);
    }
    return 1;
  }

  console.log(`VSIX check passed: ${filePath}`);
  console.log(
    `  ok  ${expectedManifest.publisher}.${expectedManifest.name} ${expectedManifest.version} (${expectedManifest.displayName})`,
  );
  console.log(
    `  ok  ${result.packaged} extension files; package.json, bundle, README, LICENSE and icon are present`,
  );
  console.log(`  ok  ${result.ignorePatterns} .vscodeignore patterns; no excluded or forbidden files found`);
  return 0;
}

function main() {
  const expectedManifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const requestedPath = process.argv[2];
  const filePath = requestedPath
    ? path.resolve(projectRoot, requestedPath)
    : path.join(projectRoot, `${expectedManifest.name}-${expectedManifest.version}.vsix`);

  if (!fs.existsSync(filePath)) {
    console.error(`VSIX not found: ${filePath}`);
    process.exitCode = 1;
    return;
  }
  try {
    process.exitCode = runCheck(filePath);
  } catch (error) {
    console.error(`VSIX check failed: ${filePath}`);
    console.error(`  - ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  globToRegExp,
  isIgnoredByPatterns,
  matchesIgnorePattern,
  readZipEntries,
  validateVsixEntries,
};

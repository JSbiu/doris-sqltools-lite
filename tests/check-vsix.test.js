const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isIgnoredByPatterns,
  matchesIgnorePattern,
  validateVsixEntries,
} = require('../scripts/check-vsix.js');

const expectedManifest = {
  name: 'doris-sqltools-lite',
  publisher: 'local',
  displayName: 'Doris SQLTools Lite',
  version: '9.9.9',
  main: './dist/extension.js',
};

function packageEntries(files) {
  return new Map(
    Object.entries(files).map(([name, contents]) => [
      `extension/${name}`,
      Buffer.isBuffer(contents) ? contents : Buffer.from(contents),
    ]),
  );
}

function validFiles() {
  return {
    'package.json': JSON.stringify(expectedManifest),
    'dist/extension.js': 'module.exports = {};',
    'readme.md': '# Doris SQLTools Lite',
    'LICENSE.txt': 'MIT',
    'media/icon.svg': '<svg />',
  };
}

test('a complete VSIX-package manifest passes', () => {
  const result = validateVsixEntries(packageEntries(validFiles()), expectedManifest, ['src/**']);

  assert.deepEqual(result.problems, []);
});

test('missing runtime and metadata mismatches are reported', () => {
  const files = validFiles();
  delete files['dist/extension.js'];
  files['package.json'] = JSON.stringify({
    ...expectedManifest,
    publisher: 'other',
    displayName: 'Other Extension',
    version: '9.9.8',
  });

  const result = validateVsixEntries(packageEntries(files), expectedManifest);

  assert.ok(result.problems.some((problem) => /runtime bundle is missing/.test(problem)));
  assert.ok(result.problems.some((problem) => /package ID is other\./.test(problem)));
  assert.ok(result.problems.some((problem) => /displayName is "Other Extension"/.test(problem)));
  assert.ok(result.problems.some((problem) => /version is "9\.9\.8"/.test(problem)));
});

test('missing README, LICENSE and icon are reported as separate failures', () => {
  const files = validFiles();
  delete files['readme.md'];
  delete files['LICENSE.txt'];
  delete files['media/icon.svg'];

  const result = validateVsixEntries(packageEntries(files), expectedManifest);

  assert.ok(result.problems.some((problem) => /README is missing/.test(problem)));
  assert.ok(result.problems.some((problem) => /LICENSE is missing/.test(problem)));
  assert.ok(result.problems.some((problem) => /icon is missing/.test(problem)));
});

test('development files, source maps and .vscodeignore exclusions are rejected', () => {
  const files = {
    ...validFiles(),
    '.git/config': 'private',
    'src/extension.ts': 'source',
    'tests/example.test.js': 'test',
    'skills/doris-sqltools-lite/SKILL.md': 'skill',
    'node_modules/pkg/index.js': 'dependency',
    '.vscode-test/vscode.exe': 'test runtime',
    'dist/extension.js.map': '{}',
    '.local/memory.md': 'private',
    'notes/private.md': 'excluded',
  };

  const result = validateVsixEntries(packageEntries(files), expectedManifest, ['notes/**']);

  assert.ok(result.problems.some((problem) => problem.startsWith('.git/config must not be packaged')));
  assert.ok(result.problems.some((problem) => problem.startsWith('src/extension.ts must not be packaged')));
  assert.ok(result.problems.some((problem) => problem.startsWith('tests/example.test.js must not be packaged')));
  assert.ok(result.problems.some((problem) => problem.startsWith('skills/doris-sqltools-lite/SKILL.md must not be packaged')));
  assert.ok(result.problems.some((problem) => problem.startsWith('node_modules/pkg/index.js must not be packaged')));
  assert.ok(result.problems.some((problem) => problem.startsWith('.vscode-test/vscode.exe must not be packaged')));
  assert.ok(result.problems.some((problem) => problem.startsWith('dist/extension.js.map must not be packaged')));
  assert.ok(result.problems.some((problem) => problem.startsWith('.local/memory.md must not be packaged')));
  assert.ok(result.problems.some((problem) => /notes\/private\.md.*\.vscodeignore/.test(problem)));
});

test('the .vscodeignore matcher handles files, directories and negation in order', () => {
  assert.equal(matchesIgnorePattern('docs/private.md', 'docs/**'), true);
  assert.equal(matchesIgnorePattern('dist/extension.js.map', 'dist/*.map'), true);
  assert.equal(matchesIgnorePattern('nested/AGENTS.md', 'AGENTS.md'), true);
  assert.equal(matchesIgnorePattern('docs/usage.md', 'docs/*.md'), true);
  assert.equal(matchesIgnorePattern('docs/nested/usage.md', 'docs/*.md'), false);
  assert.equal(isIgnoredByPatterns('dist/extension.js', ['dist/**', '!dist/extension.js']), false);
  assert.equal(isIgnoredByPatterns('dist/extension.js.map', ['dist/**', '!dist/extension.js']), true);
  assert.equal(isIgnoredByPatterns('src/extension.ts', ['src/**', '!dist/extension.js']), true);
  assert.equal(isIgnoredByPatterns('docs/usage.md', ['# comment', '']), false);
});

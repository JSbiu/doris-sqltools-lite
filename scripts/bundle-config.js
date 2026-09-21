'use strict';

// Shared by scripts/build.js and scripts/check-bundle.js so the probe bundle
// is built with exactly the same module resolution as the shipped one.

const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const outfile = path.join(projectRoot, 'dist', 'extension.js');

// `vscode` is provided by the extension host and must never be bundled.
// `bufferutil` and `utf-8-validate` are optional native accelerators that `ws`
// (reached through thrift) probes with a try/catch require. Neither is
// installed, so esbuild has to be told that leaving them unresolved is fine.
const EXTERNAL = ['vscode', 'bufferutil', 'utf-8-validate'];

module.exports = { EXTERNAL, outfile, projectRoot };

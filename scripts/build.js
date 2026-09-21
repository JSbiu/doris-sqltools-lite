'use strict';

// Bundles src/extension.ts into a single dist/extension.js. The VSIX used to
// ship the whole node_modules tree (722 files) plus a hand-built npm shim to
// talk vsce into collecting it; a bundle removes that entire mechanism.
//
// Usage: node scripts/build.js [--minify] [--watch] [--metafile]

const path = require('node:path');
const esbuild = require('esbuild');
const { EXTERNAL, outfile, projectRoot } = require('./bundle-config');

const relativeOutput = path.relative(projectRoot, outfile).replace(/\\/g, '/');

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

// Groups each input file under the package it came from so the report shows
// where the bytes actually go (a handful of thrift transports we never call
// are the usual suspect).
function summarizeInputs(metafile) {
  const totals = new Map();
  for (const [inputPath, input] of Object.entries(metafile.inputs)) {
    const normalized = inputPath.replace(/\\/g, '/');
    const marker = normalized.lastIndexOf('node_modules/');
    let label;
    if (marker === -1) {
      label = 'our own source';
    } else {
      const rest = normalized.slice(marker + 'node_modules/'.length).split('/');
      label = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
    }
    totals.set(label, (totals.get(label) ?? 0) + input.bytes);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]);
}

function buildOptions({ minify }) {
  return {
    entryPoints: [path.join(projectRoot, 'src', 'extension.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: EXTERNAL,
    sourcemap: true,
    metafile: true,
    minify,
    // Thrift's generated client and a few libraries dispatch on function and
    // class names, so minification must not rename them.
    keepNames: minify,
    logLevel: 'warning',
  };
}

function report(result, { minify }) {
  const output = result.metafile.outputs[relativeOutput];
  const mapOutput = result.metafile.outputs[`${relativeOutput}.map`];
  console.log(`bundled dist/extension.js  ${formatBytes(output?.bytes ?? 0)}  (minify: ${minify})`);
  if (mapOutput) {
    console.log(`        dist/extension.js.map  ${formatBytes(mapOutput.bytes)}  (not shipped)`);
  }

  if (process.argv.includes('--metafile')) {
    console.log('  largest contributors:');
    for (const [label, bytes] of summarizeInputs(result.metafile).slice(0, 12)) {
      console.log(`    ${label.padEnd(28)} ${formatBytes(bytes).padStart(10)}`);
    }
  }
}

async function main() {
  const minify = process.argv.includes('--minify');
  const options = buildOptions({ minify });

  if (process.argv.includes('--watch')) {
    // package.json points `main` at the bundle, so a watch that only refreshed
    // out/ would leave every F5 session running stale code.
    const context = await esbuild.context({
      ...options,
      plugins: [
        {
          name: 'report-on-rebuild',
          setup(build) {
            build.onEnd((result) => {
              if (result.errors.length > 0) {
                return;
              }
              console.log(`[${new Date().toLocaleTimeString()}] rebuilt`);
              report(result, { minify });
            });
          },
        },
      ],
    });
    await context.watch();
    return;
  }

  report(await esbuild.build(options), { minify });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

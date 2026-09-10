'use strict';

// The result panel and the connection form build their HTML inside TypeScript
// template literals, so a broken inline <script> or a selector that no longer
// matches anything only surfaces at runtime, inside a panel. This script
// re-checks the failure modes that have actually bitten us, straight from the
// source (no compile step needed):
//
//   1. every inline <script nonce="..."> block still parses as JavaScript
//   2. the nonce in the script tag matches the one the CSP meta advertises
//   3. every element the script reaches for is still declared in the HTML
//      (id('x') / getElementById('x') / [attr="value"] inside a selector)
//
// Usage: node scripts/check-webview.js [file.ts ...]
// Exits non-zero when something is wrong, so it can gate the test run.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

const defaultTargets = [
  { label: 'result panel', file: 'src/extension.ts' },
  { label: 'connection form', file: 'src/connectionForm.ts' },
];

const scriptBlock = /<script\b[^>]*nonce="\$\{([A-Za-z0-9_$]+)\}"[^>]*>([\s\S]*?)<\/script>/g;
const cspNonce = /script-src 'nonce-\$\{([A-Za-z0-9_$]+)\}'/;
const declaredId = /(?:^|\s)id="([^"]+)"/g;
const referencedIds = [
  /\bgetElementById\(\s*(['"])([^'"]+)\1\s*\)/g,
  /(?<![\w.$])id\(\s*(['"])([^'"]+)\1\s*\)/g,
];
const selectorCall = /querySelector(?:All)?\(\s*(['"])([\s\S]*?)\1\s*\)/g;
const attributeSelector = /\[([A-Za-z0-9_-]+)="([^"]+)"\]/g;

// The inline script is still sitting inside a template literal here, so the
// author-side `${...}` interpolations are present as source text. Swapping them
// for a bare literal keeps the block parseable without guessing their types.
function toCheckableScript(code) {
  return code.replace(/\$\{[^}]*\}/g, '0');
}

function checkTarget(target) {
  const empty = { ...target, blocks: 0, ids: 0, selectors: 0 };
  let source;
  try {
    // resolve, not join: a caller can hand over an absolute path.
    source = fs.readFileSync(path.resolve(projectRoot, target.file), 'utf8');
  } catch (error) {
    return { ...empty, problems: [`cannot read file: ${error.message}`] };
  }

  const problems = new Set();
  const blocks = [...source.matchAll(scriptBlock)];
  if (blocks.length === 0) {
    return { ...empty, problems: ['no inline <script nonce="..."> block found'] };
  }

  // Ids and attributes only count when they live in the markup. The script is
  // stripped first so a literal inside it (`querySelector('[data-x="y"]')`)
  // cannot vouch for itself and hide a selector that no longer matches.
  const html = source.replace(scriptBlock, ' ');
  const ids = new Set([...html.matchAll(declaredId)].map((match) => match[1]));
  const expectedNonce = cspNonce.exec(html)?.[1];
  let selectors = 0;

  for (const block of blocks) {
    const [, nonceVariable, rawScript] = block;
    if (expectedNonce && expectedNonce !== nonceVariable) {
      problems.add(`CSP allows nonce \${${expectedNonce}} but the script tag carries \${${nonceVariable}}`);
    }

    const script = toCheckableScript(rawScript);
    try {
      new vm.Script(script, { filename: `${target.file} (inline script)` });
    } catch (error) {
      problems.add(`inline script does not parse: ${error.message}`);
    }

    for (const pattern of referencedIds) {
      for (const match of script.matchAll(pattern)) {
        if (!ids.has(match[2])) {
          problems.add(`script uses id "${match[2]}" but no element in the HTML declares it`);
        }
      }
    }

    for (const match of script.matchAll(selectorCall)) {
      for (const attribute of match[2].matchAll(attributeSelector)) {
        // Selectors glued together at runtime (`[data-err="' + field + '"]`)
        // pull their own quotes along; there is nothing static to compare.
        if (/['"+]/.test(attribute[2])) {
          continue;
        }
        selectors += 1;
        const token = `${attribute[1]}="${attribute[2]}"`;
        if (!html.includes(token)) {
          problems.add(`selector ${match[2]} expects ${token} but the HTML never declares it`);
        }
      }
    }
  }

  return { ...target, blocks: blocks.length, ids: ids.size, selectors, problems: [...problems] };
}

const requested = process.argv.slice(2);
const targets = requested.length === 0
  ? defaultTargets
  : requested.map((file) => ({ label: path.basename(file), file }));

console.log('webview smoke check');
let failures = 0;
for (const target of targets) {
  const result = checkTarget(target);
  const detail = `${result.blocks} script block(s), ${result.ids} declared id(s), ${result.selectors} attribute selector(s)`;
  if (result.problems.length > 0) {
    failures += 1;
    console.log(`  FAIL  ${result.label} (${result.file}) — ${detail}`);
    for (const problem of result.problems) {
      console.log(`        - ${problem}`);
    }
    continue;
  }
  console.log(`  ok    ${result.label} (${result.file}) — ${detail}`);
}

console.log(failures === 0 ? '  all good' : `  ${failures} file(s) need attention`);
process.exitCode = failures === 0 ? 0 : 1;

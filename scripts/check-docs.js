'use strict';

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

const required = [
  'README.md',
  'CHANGELOG.md',
  'THIRD_PARTY_NOTICES.md',
  'docs/product.md',
  'docs/usage.md',
  'docs/security.md',
  'docs/architecture.md',
  'docs/feedback-schema.md',
  'docs/development.md',
  'docs/release-checklist.md',
  'docs/ux.md',
];

const documents = [...new Set([
  ...required,
  ...fs.readdirSync(path.join(projectRoot, 'docs'))
    .filter((file) => file.endsWith('.md'))
    .map((file) => `docs/${file}`),
  'CONTRIBUTING.md',
  'SECURITY.md',
])].filter((file) => fs.existsSync(path.join(projectRoot, file)));
const historicalDocuments = new Set(['docs/history.md']);

function existsWithExactCase(target) {
  const relative = path.relative(projectRoot, target);
  let current = projectRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    if (!fs.readdirSync(current).includes(segment)) return false;
    current = path.join(current, segment);
  }
  return fs.existsSync(target);
}

const problems = [];
const commandTitles = new Set(manifest.contributes.commands.map((command) => command.title));
const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
const commandPattern = /`(Doris SQLTools Lite: [^`\n]+)`/g;
const stalePatterns = [
  /Doris SQL Lite/,
  /Doris SQLTools Lite: [A-Za-z]/,
  /\bTLS for MySQL and Doris\b/,
  /\bAdd Connection\b/,
  /\bToggle Plain \/ Encrypted Mode\b/,
];

for (const file of required) {
  if (!fs.existsSync(path.join(projectRoot, file))) problems.push(`缺少文档：${file}`);
}

for (const file of documents) {
  const filename = path.join(projectRoot, file);
  const text = fs.readFileSync(filename, 'utf8');
  const fenceCount = (text.match(/^```/gm) ?? []).length;
  if (fenceCount % 2 !== 0) problems.push(`${file}: Markdown 代码围栏数量为奇数`);

  if (!historicalDocuments.has(file)) {
    for (const pattern of stalePatterns) {
      if (pattern.test(text)) problems.push(`${file}: 发现旧界面文案 ${pattern}`);
    }
  }

  if (!historicalDocuments.has(file)) {
    for (const match of text.matchAll(commandPattern)) {
      if (!commandTitles.has(match[1])) problems.push(`${file}: 未在 package.json 找到命令「${match[1]}」`);
    }
  }

  for (const match of text.matchAll(linkPattern)) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('<') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    const target = decodeURIComponent(raw.split('#', 1)[0].split('?', 1)[0]);
    const resolved = path.resolve(path.dirname(filename), target);
    if (!resolved.startsWith(`${projectRoot}${path.sep}`) && resolved !== projectRoot) {
      problems.push(`${file}: 链接越过仓库范围：${raw}`);
    } else if (!existsWithExactCase(resolved)) {
      problems.push(`${file}: 链接目标不存在：${raw}`);
    }
  }
}

const changelog = fs.readFileSync(path.join(projectRoot, 'CHANGELOG.md'), 'utf8');
const versionPattern = new RegExp(`^## \\[${manifest.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'm');
if (!versionPattern.test(changelog)) problems.push(`CHANGELOG.md: 缺少当前版本 ${manifest.version} 的条目`);

console.log('documentation check');
console.log(`  ${documents.length} document(s), ${commandTitles.size} command title(s)`);
if (problems.length > 0) {
  for (const problem of problems) console.log(`  FAIL  ${problem}`);
  process.exitCode = 1;
} else {
  console.log('  all good');
}

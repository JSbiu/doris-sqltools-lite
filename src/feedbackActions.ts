import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { lstat, open, stat, unlink } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { buildExportFileName } from './exportPath';
import { buildBatchReport, buildSqlFeedback, hasBatchDetails, type FeedbackSource, type SqlFeedback } from './sqlFeedback';
import { classifyDatabaseError, formatDatabaseError } from './connectionDiagnostics';
import { getDataMode, PROTECTED_MATERIAL_NOTICE, type DataMode, type ProtectionProjection } from './dataProtection';

export interface FeedbackRecord {
  value: SqlFeedback;
  sourceUri: vscode.Uri;
  currentSource: () => FeedbackSource;
  startedAt: number;
  planText?: string;
  protection?: ProtectionProjection;
  batchProtections?: ReadonlyMap<string, ProtectionProjection>;
  protectRaw?: boolean;
}

let latest: FeedbackRecord | undefined;
const busy = new WeakSet<FeedbackRecord>();
type ArtifactPaths = Pick<SqlFeedback, 'planFile' | 'batchReportFile'>;
const artifacts = new WeakMap<FeedbackRecord, Map<string, ArtifactPaths>>();

function isProtected(record: FeedbackRecord): boolean {
  return !!record.protection || !!record.batchProtections?.size || record.protectRaw === true;
}

function artifactKey(record: FeedbackRecord, mode: DataMode): string {
  return JSON.stringify([mode, record.protection?.info,
    [...record.batchProtections ?? []].map(([name, protection]) => [name, protection.info])]);
}

function captureFeedback(record: FeedbackRecord, mode: DataMode): FeedbackRecord {
  if (!isProtected(record)) return record;
  const protection = record.protection?.withMode(mode);
  const encrypted = mode === 'encrypted';
  const diagnostic = (text?: string): string | undefined => text === undefined ? undefined
    : encrypted ? `${classifyDatabaseError(text).kind}：${PROTECTED_MATERIAL_NOTICE}` : text;
  const paths = artifacts.get(record)?.get(artifactKey(record, mode));
  return {
    ...record, protection, planText: encrypted ? undefined : record.planText,
    value: {
      ...record.value, dataMode: mode, protection: protection?.info,
      parameters: protection?.parameters(record.value.parameters) ?? { ...record.value.parameters },
      error: diagnostic(record.value.error), warning: diagnostic(record.value.warning),
      planFile: encrypted ? undefined : paths?.planFile,
      batchReportFile: paths?.batchReportFile,
      resultFile: record.protection && record.protection.mode !== mode ? undefined : record.value.resultFile,
      batch: record.value.batch ? { ...record.value.batch,
        error: diagnostic(record.value.batch.error),
        records: record.value.batch.records.map((step) => {
          const stepProtection = record.batchProtections?.get(step.name)?.withMode(mode);
          return { ...step, parameters: stepProtection?.parameters(step.parameters) ?? { ...step.parameters },
            protection: stepProtection?.info, error: diagnostic(step.error) };
        }),
      } : undefined,
    },
  };
}

export function rememberFeedback(record: FeedbackRecord): void {
  latest = record;
}

export function latestFeedback(): FeedbackRecord | undefined {
  return latest;
}

export function feedbackText(record: FeedbackRecord): string {
  return renderFeedback(captureFeedback(record, getDataMode()));
}

function renderFeedback(record: FeedbackRecord): string {
  return buildSqlFeedback({ ...record.value, source: record.currentSource() });
}

function sameUri(left: vscode.Uri, right: vscode.Uri): boolean {
  if (left.scheme === 'file' && right.scheme === 'file') {
    const a = resolve(left.fsPath);
    const b = resolve(right.fsPath);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  }
  return left.toString() === right.toString();
}

function checkTarget(record: FeedbackRecord, target: vscode.Uri, extension: string): void {
  if (sameUri(target, record.sourceUri)) throw new Error('不能覆盖原 SQL 文件。');
  if (record.value.resultFile && sameUri(target, vscode.Uri.file(record.value.resultFile))) {
    throw new Error('不能覆盖查询结果文件。');
  }
  if (record.value.batch?.script && sameUri(target, vscode.Uri.file(record.value.batch.script))) {
    throw new Error('不能覆盖批次参数脚本。');
  }
  if (extname(target.path ?? target.fsPath).toLowerCase() !== extension) {
    throw new Error(`请保存为 ${extension} 文件。`);
  }
}

function defaultTarget(record: FeedbackRecord, extension: string): vscode.Uri | undefined {
  const folder = record.sourceUri.scheme === 'untitled'
    ? vscode.workspace.workspaceFolders?.[0]?.uri : vscode.Uri.joinPath(record.sourceUri, '..');
  return folder ? vscode.Uri.joinPath(folder, buildExportFileName(record.value.name, extension, new Date())) : undefined;
}

async function writePlan(record: FeedbackRecord, target: vscode.Uri): Promise<void> {
  checkTarget(record, target, '.txt');
  await vscode.workspace.fs.writeFile(target, Buffer.from(record.planText ?? '', 'utf8'));
  record.value.planFile = target.scheme === 'file' ? target.fsPath : target.toString();
}

async function feedbackAction(
  record: FeedbackRecord | undefined, action: (record: FeedbackRecord) => Promise<boolean>,
): Promise<boolean> {
  if (!record) {
    void vscode.window.showInformationMessage('还没有完成的 SQL 操作反馈。');
    return false;
  }
  if (busy.has(record)) {
    void vscode.window.showInformationMessage('本次反馈正在复制或保存，请等待完成。');
    return false;
  }
  busy.add(record);
  const mode = getDataMode();
  let snapshot: FeedbackRecord | undefined;
  try {
    snapshot = captureFeedback(record, mode);
    return await action(snapshot);
  } catch (error) {
    if (isProtected(record) && (mode === 'encrypted' || getDataMode() === 'encrypted')) {
      throw new Error('反馈操作未完成。若已选择保存位置，请核对是否存在未完成文件。切换到字段原文模式后，可查看详细错误。', { cause: error });
    }
    throw error;
  } finally {
    if (snapshot && isProtected(record)) {
      let paths = artifacts.get(record);
      if (!paths) { paths = new Map(); artifacts.set(record, paths); }
      paths.set(artifactKey(record, mode), { planFile: snapshot.value.planFile, batchReportFile: snapshot.value.batchReportFile });
    }
    busy.delete(record);
  }
}

// Exclusively create feedback artifacts: a failed write removes only the file
// opened by this call. An existing path, including a symlink, is never replaced.
async function writeNewLocalFile(target: vscode.Uri, text: string): Promise<void> {
  if (target.scheme !== 'file') throw new Error('批次报告及其摘要需要保存到本地文件。');
  const file = await open(target.fsPath, 'wx', 0o600);
  try {
    await file.writeFile(text, 'utf8');
    await file.close();
  } catch (error) {
    await file.close().catch(() => undefined);
    try { await unlink(target.fsPath); }
    catch (cleanupError) {
      throw new Error(`文件未保存完成：${formatDatabaseError(error)}；残留文件无法清理：${target.fsPath}；${formatDatabaseError(cleanupError)}`, { cause: cleanupError });
    }
    throw error;
  }
}

async function ensureBatchReport(record: FeedbackRecord, companion?: vscode.Uri): Promise<boolean> {
  if (!hasBatchDetails(record.value)) return true;
  try {
    if (record.value.batchReportFile) {
      const saved = await stat(record.value.batchReportFile).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      if (saved?.isFile()) return true;
      record.value.batchReportFile = undefined;
    }
    const target = companion ?? await vscode.window.showSaveDialog({
      title: '先保存完整批次报告，再复制简短反馈', saveLabel: '保存报告并复制反馈',
      defaultUri: defaultTarget(record, 'batch-report.json'), filters: { '批次报告': ['json'] },
    });
    if (!target) return false;
    checkTarget(record, target, '.json');
    await writeNewLocalFile(target, buildBatchReport({ ...record.value, source: record.currentSource() }));
    record.value.batchReportFile = target.fsPath;
    return true;
  } catch (error) {
    throw new Error(`报告未保存：${formatDatabaseError(error)}`, { cause: error });
  }
}

export async function copyFeedback(record: FeedbackRecord | undefined = latest): Promise<boolean> {
  return feedbackAction(record, async (record) => {
    if (!await ensureBatchReport(record)) return false;
    if (record.planText !== undefined && !record.value.planFile) {
      const target = await vscode.window.showSaveDialog({
        title: '先保存完整计划，再复制简短反馈', saveLabel: '保存计划并复制反馈',
        defaultUri: defaultTarget(record, 'plan.txt'), filters: { '执行计划': ['txt'] },
      });
      if (!target) return false;
      await writePlan(record, target);
    }
    await vscode.env.clipboard.writeText(renderFeedback(record));
    return true;
  });
}

export async function saveFeedback(record: FeedbackRecord | undefined = latest): Promise<boolean> {
  return feedbackAction(record, async (record) => {
    const target = await vscode.window.showSaveDialog({
      title: '保存 SQL 反馈', saveLabel: '保存反馈',
      defaultUri: defaultTarget(record, 'feedback.md'), filters: { Markdown: ['md'] },
    });
    if (!target) return false;
    checkTarget(record, target, '.md');
    if (record.value.action === 'batch') {
      if (target.scheme !== 'file') throw new Error('批次报告及其摘要需要保存到本地文件。');
      const existing = await lstat(target.fsPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      if (existing) throw new Error(`反馈目标已存在，请选择新文件：${target.fsPath}`);
      const name = basename(target.path ?? target.fsPath, '.md');
      const companion = vscode.Uri.joinPath(target, '..', `${name}-${randomUUID().slice(0, 8)}.batch-report.json`);
      if (!await ensureBatchReport(record, companion)) return false;
      await writeNewLocalFile(target, renderFeedback(record));
      return true;
    }
    if (record.planText !== undefined && !record.value.planFile) {
      // One chosen feedback file, one complete plan. A unique companion name
      // avoids overwriting an earlier plan when a summary is saved again.
      const name = basename(target.path ?? target.fsPath, '.md');
      await writePlan(record, vscode.Uri.joinPath(target, '..', `${name}-${randomUUID().slice(0, 8)}.plan.txt`));
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(renderFeedback(record), 'utf8'));
    return true;
  });
}

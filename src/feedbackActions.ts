import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { basename, extname, resolve } from 'node:path';
import { buildExportFileName } from './exportPath';
import { buildSqlFeedback, type FeedbackSource, type SqlFeedback } from './sqlFeedback';

export interface FeedbackRecord {
  value: SqlFeedback;
  sourceUri: vscode.Uri;
  currentSource: () => FeedbackSource;
  startedAt: number;
  planText?: string;
}

let latest: FeedbackRecord | undefined;

export function rememberFeedback(record: FeedbackRecord): void {
  latest = record;
}

export function latestFeedback(): FeedbackRecord | undefined {
  return latest;
}

export function feedbackText(record: FeedbackRecord): string {
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

export async function copyFeedback(record: FeedbackRecord | undefined = latest): Promise<boolean> {
  if (!record) {
    void vscode.window.showInformationMessage('还没有完成的 SQL 操作反馈。');
    return false;
  }
  if (record.planText !== undefined && !record.value.planFile) {
    const target = await vscode.window.showSaveDialog({
      title: '先保存完整计划，再复制简短反馈', saveLabel: '保存计划并复制反馈',
      defaultUri: defaultTarget(record, 'plan.txt'), filters: { '执行计划': ['txt'] },
    });
    if (!target) return false;
    await writePlan(record, target);
  }
  await vscode.env.clipboard.writeText(feedbackText(record));
  return true;
}

export async function saveFeedback(record: FeedbackRecord | undefined = latest): Promise<boolean> {
  if (!record) {
    void vscode.window.showInformationMessage('还没有完成的 SQL 操作反馈。');
    return false;
  }
  const target = await vscode.window.showSaveDialog({
    title: '保存 SQL 反馈', saveLabel: '保存反馈',
    defaultUri: defaultTarget(record, 'feedback.md'), filters: { Markdown: ['md'] },
  });
  if (!target) return false;
  checkTarget(record, target, '.md');
  if (record.planText !== undefined && !record.value.planFile) {
    // One chosen feedback file, one complete plan. A unique companion name
    // avoids overwriting an earlier plan when a summary is saved again.
    const name = basename(target.path ?? target.fsPath, '.md');
    await writePlan(record, vscode.Uri.joinPath(target, '..', `${name}-${randomUUID().slice(0, 8)}.plan.txt`));
  }
  await vscode.workspace.fs.writeFile(target, Buffer.from(feedbackText(record), 'utf8'));
  return true;
}

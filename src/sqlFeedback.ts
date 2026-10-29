import { redactErrorMessage, type DatabaseType } from './connectionSecurity';
import type { BatchFeedback } from './batchExecution';

export interface FeedbackSource {
  path: string;
  startLine: number;
  endLine: number;
  savedAtExecution: boolean;
  changedSinceExecution: boolean | null;
}

export interface SqlFeedback {
  name: string;
  connectionName: string;
  databaseType: DatabaseType | null;
  parameters: Readonly<Record<string, string>>;
  source: FeedbackSource;
  action: 'query' | 'export' | 'explain' | 'batch';
  status: 'success' | 'failed' | 'cancelled';
  submitted: boolean;
  generatedAt: string;
  durationMs: number;
  rowsRead?: number;
  totalRows?: number | null;
  displayedRows?: number;
  readComplete?: boolean;
  truncated?: boolean;
  previewLimit?: number;
  hasResultSet?: boolean;
  affectedRows?: number | null;
  needsReview?: boolean;
  batch?: BatchFeedback;
  resultFile?: string;
  planFile?: string;
  temporaryFile?: string;
  explainKind?: string;
  error?: string;
  warning?: string;
  sessionState?: 'retained' | 'lost' | 'not-opened';
}

function feedbackMessage(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  // Keep multiline diagnostics, but discard frames if a stack was supplied.
  const safe = redactErrorMessage(message.split(/\r?\n[ \t]+at(?:[ \t]+|$)/, 1)[0]);
  const suffix = '… [已截断]';
  return safe.length > 2000 ? safe.slice(0, 2000 - suffix.length) + suffix : safe;
}

export function buildSqlFeedback(feedback: SqlFeedback): string {
  // Explicitly select both levels: runtime snapshots can also carry SQL,
  // plans, result rows and connection credentials that do not belong here.
  const data: SqlFeedback = {
    name: feedback.name,
    connectionName: feedback.connectionName,
    databaseType: feedback.databaseType,
    parameters: Object.fromEntries(Object.entries(feedback.parameters)),
    source: {
      path: feedback.source.path,
      startLine: feedback.source.startLine,
      endLine: feedback.source.endLine,
      savedAtExecution: feedback.source.savedAtExecution,
      changedSinceExecution: feedback.source.changedSinceExecution,
    },
    action: feedback.action,
    status: feedback.status,
    submitted: feedback.submitted,
    generatedAt: feedback.generatedAt,
    durationMs: feedback.durationMs,
    rowsRead: feedback.rowsRead,
    totalRows: feedback.totalRows,
    displayedRows: feedback.displayedRows,
    readComplete: feedback.readComplete,
    truncated: feedback.truncated,
    previewLimit: feedback.previewLimit,
    hasResultSet: feedback.hasResultSet,
    affectedRows: feedback.affectedRows,
    needsReview: feedback.needsReview,
    batch: feedback.batch ? {
      script: feedback.batch.script, batchCount: feedback.batch.batchCount,
      completedBatches: feedback.batch.completedBatches,
      error: feedbackMessage(feedback.batch.error),
      initSteps: [...feedback.batch.initSteps], steps: [...feedback.batch.steps],
      records: feedback.batch.records.map((record) => ({
        phase: record.phase, batchIndex: record.batchIndex, name: record.name,
        connectionName: record.connectionName, databaseType: record.databaseType,
        parameters: Object.fromEntries(Object.entries(record.parameters)),
        startLine: record.startLine, endLine: record.endLine,
        status: record.status, submitted: record.submitted, durationMs: record.durationMs,
        affectedRows: record.affectedRows, sessionState: record.sessionState,
        needsReview: record.needsReview, error: feedbackMessage(record.error),
      })),
    } : undefined,
    resultFile: feedback.resultFile,
    planFile: feedback.planFile,
    temporaryFile: feedback.temporaryFile,
    explainKind: feedback.explainKind,
    error: feedbackMessage(feedback.error),
    warning: feedbackMessage(feedback.warning),
    sessionState: feedback.sessionState,
  };
  const notes: string[] = [];
  if (data.databaseType === null) notes.push(data.batch
    ? '- 各步骤的连接、类型、实际参数与执行状态见 `batch.records`。'
    : '- `databaseType=null`：数据库类型未知。');
  if (data.affectedRows === null || data.batch?.records.some((record) => record.affectedRows === null)) {
    notes.push('- `affectedRows=null`：服务端未提供影响行数。');
  }
  if (data.needsReview || data.batch?.records.some((record) => record.needsReview)) {
    notes.push('- `needsReview=true`：已提交操作的写入结果需核对；不会自动重试或回滚。');
  }
  if (data.batch) notes.push('- `batch.records` 的行号对应 `source.path`；`batchIndex` 从 1 开始，`not-run` 表示未执行。');
  if (data.totalRows === null) notes.push('- `totalRows=null`：总行数未知。');
  if (!data.source.savedAtExecution) notes.push('- `source.savedAtExecution=false`：当时来源未保存。');
  if (data.source.changedSinceExecution === true) {
    notes.push('- `source.changedSinceExecution=true`：来源在执行后已改动。');
  } else if (data.source.changedSinceExecution === null) {
    notes.push('- `source.changedSinceExecution=null`：当前来源尚未核对。');
  }

  // JSON.stringify escapes embedded newlines, so parameter values cannot close
  // this fence or turn their Markdown characters into document structure.
  return [
    '# SQL 执行反馈', '', '```json', JSON.stringify(data), '```',
    ...(notes.length ? ['', ...notes] : []), '',
  ].join('\n');
}

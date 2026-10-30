import { redactErrorMessage, type DatabaseType } from './connectionSecurity';
import type { BatchFeedback } from './batchExecution';
import type { DataMode, ProtectionInfo } from './dataProtection';

export const FEEDBACK_SCHEMA_VERSION = 1 as const;
let extensionVersion: string | undefined;

export function setFeedbackExtensionVersion(version: string | undefined): void {
  extensionVersion = version;
}

export interface FeedbackSource {
  path: string;
  startLine: number;
  endLine: number;
  savedAtExecution: boolean;
  changedSinceExecution: boolean | null;
}

export interface SqlFeedback {
  schemaVersion?: typeof FEEDBACK_SCHEMA_VERSION;
  extensionVersion?: string;
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
  batchReportFile?: string;
  resultFile?: string;
  planFile?: string;
  temporaryFile?: string;
  explainKind?: string;
  error?: string;
  warning?: string;
  sessionState?: 'retained' | 'lost' | 'not-opened';
  dataMode?: DataMode;
  protection?: ProtectionInfo;
}

function protectionInfo(info: ProtectionInfo | undefined): ProtectionInfo | undefined {
  return info ? { mode: info.mode, keyId: info.keyId, fields: Object.fromEntries(Object.entries(info.fields)) } : undefined;
}

function feedbackMessage(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  // Keep multiline diagnostics, but discard frames if a stack was supplied.
  const safe = redactErrorMessage(message.split(/\r?\n[ \t]+at(?:[ \t]+|$)/, 1)[0]);
  const suffix = '… [已截断]';
  return safe.length > 2000 ? safe.slice(0, 2000 - suffix.length) + suffix : safe;
}

function feedbackData(feedback: SqlFeedback): SqlFeedback {
  // Explicitly select both levels: runtime snapshots can also carry SQL,
  // plans, result rows and connection credentials that do not belong here.
  return {
    schemaVersion: feedback.schemaVersion ?? FEEDBACK_SCHEMA_VERSION,
    ...(extensionVersion ? { extensionVersion } : {}),
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
    dataMode: feedback.dataMode,
    protection: protectionInfo(feedback.protection),
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
        protection: protectionInfo(record.protection),
      })),
    } : undefined,
    resultFile: feedback.resultFile,
    batchReportFile: feedback.batchReportFile,
    planFile: feedback.planFile,
    temporaryFile: feedback.temporaryFile,
    explainKind: feedback.explainKind,
    error: feedbackMessage(feedback.error),
    warning: feedbackMessage(feedback.warning),
    sessionState: feedback.sessionState,
  };
}

export function hasBatchDetails(feedback: SqlFeedback): boolean {
  return feedback.action === 'batch' && feedback.batch?.records.some((record) => record.submitted) === true;
}

// A report keeps every whitelisted record. The default clipboard summary only
// samples the endpoints and identifies the interrupted batch.
export function buildBatchReport(feedback: SqlFeedback): string {
  return JSON.stringify(feedbackData(feedback), null, 2) + '\n';
}

function summarizeBatch(batch: BatchFeedback, status: SqlFeedback['status']) {
  const definitions = new Map<string, object>();
  for (const record of batch.records) {
    const key = `${record.phase}\0${record.name}`;
    if (!definitions.has(key)) definitions.set(key, {
      phase: record.phase, name: record.name, connectionName: record.connectionName,
      databaseType: record.databaseType, startLine: record.startLine, endLine: record.endLine,
      protection: record.protection,
    });
  }
  const sample = (index: number) => ({
    batchIndex: index,
    steps: batch.records.filter((record) => record.batchIndex === index).map((record) => ({
      name: record.name, parameters: record.parameters, submitted: record.submitted, status: record.status,
    })),
  });
  const stopped = status === 'success' ? undefined
    : batch.records.find((record) => record.status === 'failed' || record.status === 'cancelled')
      ?? (batch.error ? batch.records.find((record) => record.submitted && record.sessionState === 'lost') : undefined)
      ?? batch.records.find((record) => record.status === 'not-run');
  const group = stopped ? batch.records.filter((record) => record.phase === stopped.phase && record.batchIndex === stopped.batchIndex) : [];
  return {
    script: batch.script, batchCount: batch.batchCount, completedBatches: batch.completedBatches,
    steps: [...definitions.values()],
    firstBatch: batch.batchCount > 0 ? sample(1) : undefined,
    lastBatch: batch.batchCount > 1 ? sample(batch.batchCount) : undefined,
    stopped: stopped ? {
      phase: stopped.phase, batchIndex: stopped.batchIndex, name: stopped.name,
      parameters: stopped.parameters, status: stopped.status, submitted: stopped.submitted,
      sessionState: stopped.sessionState, needsReview: stopped.needsReview,
      completedSteps: group.filter((record) => record.status === 'success').map((record) => record.name),
      needsReviewSteps: group.filter((record) => record.needsReview).map((record) => record.name),
      error: stopped.error ?? batch.error,
    } : undefined,
    error: batch.error,
  };
}

export function buildSqlFeedback(feedback: SqlFeedback): string {
  const data = feedbackData(feedback);
  const output = data.batch ? { ...data, batch: summarizeBatch(data.batch, data.status) } : data;
  const notes: string[] = [];
  if (data.databaseType === null) notes.push(data.batch
    ? '- 各步骤的连接与类型见 `batch.steps`，逐步明细见完整报告的 `batch.records`。'
    : '- `databaseType=null`：数据库类型未知。');
  if (data.affectedRows === null || data.batch?.records.some((record) => record.affectedRows === null)) {
    notes.push('- `affectedRows=null`：服务端未提供影响行数。');
  }
  if (data.needsReview || data.batch?.records.some((record) => record.needsReview)) {
    notes.push('- `needsReview=true`：已提交操作的写入结果需核对；不会自动重试或回滚。');
  }
  if (data.batch) {
    notes.push('- 步骤行号对应 `source.path`；`batchIndex` 从 1 开始，`not-run` 表示未执行。首尾参数仅为样例，是否执行以 `submitted` 和状态为准。');
    if (hasBatchDetails(data) && !data.batchReportFile) notes.push('- 完整批次报告尚未保存。');
  }
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
    '# SQL 执行反馈', '', '```json', JSON.stringify(output), '```',
    ...(notes.length ? ['', ...notes] : []), '',
  ].join('\n');
}

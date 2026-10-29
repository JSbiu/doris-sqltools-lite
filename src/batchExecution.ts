import type { ConnectionProfile, DatabaseType } from './connectionSecurity';
import { classifyDatabaseError, formatDatabaseError } from './connectionDiagnostics';
import { findSqlStatementRanges } from './queryResults';
import { isQueryCancelled, type CancelSignal, type QuerySummary } from './querySession';
import { readBatchDirectives, resolveStatementContext, type StatementContext } from './sqlDirectives';
import { isParameterName, resolveSqlParameters } from './sqlParameters';

export type BatchParameters = Readonly<Record<string, string>>;
export interface BatchDefinition {
  script: string;
  init: StatementContext[];
  steps: StatementContext[];
}
export interface BatchStatement extends StatementContext {
  name: string;
  profile: ConnectionProfile;
}
export interface BatchTask {
  script: string;
  init: BatchStatement[];
  steps: BatchStatement[];
  batches: BatchParameters[];
}
export interface BatchStepFeedback {
  phase: 'init' | 'batch';
  batchIndex?: number;
  name: string;
  connectionName: string;
  databaseType: DatabaseType;
  parameters: BatchParameters;
  startLine: number;
  endLine: number;
  status: 'success' | 'failed' | 'cancelled' | 'not-run';
  submitted: boolean;
  durationMs: number;
  affectedRows?: number | null;
  sessionState?: 'retained' | 'lost' | 'not-opened';
  needsReview?: boolean;
  error?: string;
}
export interface BatchFeedback {
  script: string;
  batchCount: number;
  completedBatches: number;
  initSteps: string[];
  steps: string[];
  records: BatchStepFeedback[];
  error?: string;
}

// Keep the task and its feedback finite without storing one expanded copy of
// a potentially long SQL template for every batch.
const MAX_STEP_EXECUTIONS = 10_000;

export function parseBatchParameters(text: string): BatchParameters[] {
  let data: unknown;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('参数脚本必须只向标准输出写入 UTF-8 JSON 参数数组。'); }
  if (!Array.isArray(data) || !data.length) throw new Error('参数脚本必须返回非空 JSON 参数数组。');
  return data.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`第 ${index + 1} 批参数必须是 JSON 对象。`);
    }
    const entries = Object.entries(item).map(([key, value]) => {
      if (!isParameterName(key) || !['string', 'number', 'boolean'].includes(typeof value)
        || value === '' || (typeof value === 'number' && !Number.isFinite(value))) {
        throw new Error(`第 ${index + 1} 批参数「${key}」需要有效参数名和非空字符串、有限数字或布尔值。`);
      }
      return [key, String(value)];
    });
    return Object.fromEntries(entries);
  });
}

export function readBatchDefinition(document: string): BatchDefinition {
  const directives = readBatchDirectives(document);
  const named = new Map<string, StatementContext>();
  for (const range of findSqlStatementRanges(document)) {
    const context = resolveStatementContext(document, range.start)!;
    if (!context.name) continue;
    if (named.has(context.name)) throw new Error(`SQL 名称「${context.name}」重复，请使用唯一 @name。`);
    named.set(context.name, context);
  }
  const select = (name: string): StatementContext => {
    const context = named.get(name);
    if (!context) throw new Error(`找不到分批步骤「${name}」，请为对应 SQL 声明 @name。`);
    if (context.output !== undefined) throw new Error(`分批步骤「${name}」不能设置 @output；本入口不生成批量结果文件。`);
    return context;
  };
  return { script: directives.script, init: directives.init.map(select), steps: directives.steps.map(select) };
}

function prepareStep(step: BatchStatement, batch: BatchParameters) {
  const resolved = resolveSqlParameters(step.sql, { ...step.parameters, ...batch });
  if (resolved.missing.length) {
    throw new Error(`步骤「${step.name}」缺少参数：${resolved.missing.join('、')}。`);
  }
  if (findSqlStatementRanges(resolved.sql).length !== 1) {
    throw new Error(`步骤「${step.name}」参数替换后必须仍为一条 SQL。`);
  }
  return resolved;
}

export function prepareBatchTask(
  definition: BatchDefinition, batches: BatchParameters[],
  connection: (context: StatementContext) => ConnectionProfile,
): BatchTask {
  if (!batches.length || definition.init.length + definition.steps.length * batches.length > MAX_STEP_EXECUTIONS) {
    throw new Error(`单次任务需要非空批次，且初始化与每批步骤合计不能超过 ${MAX_STEP_EXECUTIONS} 次；请缩小脚本范围。`);
  }
  const statement = (context: StatementContext): BatchStatement => ({
    ...context, name: context.name!, parameters: { ...context.parameters }, profile: { ...connection(context) },
  });
  const task: BatchTask = {
    script: definition.script, init: definition.init.map(statement), steps: definition.steps.map(statement),
    batches: batches.map((batch) => ({ ...batch })),
  };
  // Validate every batch before the first initialization or write. A missing
  // parameter near the end must not leave earlier days partially changed.
  for (const step of task.init) prepareStep(step, {});
  for (const [index, batch] of task.batches.entries()) {
    for (const step of task.steps) {
      try { prepareStep(step, batch); }
      catch (error) { throw new Error(`第 ${index + 1} 批：${(error as Error).message}`, { cause: error }); }
    }
  }
  return task;
}

export function createBatchFeedback(task: BatchTask): BatchFeedback {
  const record = (step: BatchStatement, batch: BatchParameters, batchIndex?: number): BatchStepFeedback => ({
    phase: batchIndex === undefined ? 'init' : 'batch', batchIndex,
    name: step.name, connectionName: step.profile.name, databaseType: step.profile.type,
    parameters: prepareStep(step, batch).used, startLine: step.line, endLine: step.endLine,
    status: 'not-run', submitted: false, durationMs: 0, sessionState: 'not-opened',
  });
  return {
    script: task.script, batchCount: task.batches.length, completedBatches: 0,
    initSteps: task.init.map((step) => step.name), steps: task.steps.map((step) => step.name),
    records: [
      ...task.init.map((step) => record(step, {})),
      ...task.batches.flatMap((batch, index) => task.steps.map((step) => record(step, batch, index + 1))),
    ],
  };
}

export async function runBatchTask(
  task: BatchTask, feedback: BatchFeedback, signal: CancelSignal,
  execute: (step: BatchStatement, sql: string, record: BatchStepFeedback) => Promise<QuerySummary>,
  onProgress: (record: BatchStepFeedback) => void = () => undefined,
): Promise<'success' | 'failed' | 'cancelled'> {
  for (const record of feedback.records) {
    if (signal.requested) return 'cancelled';
    const steps = record.phase === 'init' ? task.init : task.steps;
    const step = steps.find((item) => item.name === record.name)!;
    const parameters = record.batchIndex === undefined ? {} : task.batches[record.batchIndex - 1];
    const started = Date.now();
    onProgress(record);
    try {
      const result = await execute(step, prepareStep(step, parameters).sql, record);
      if (result.hasResultSet) throw new Error('分批步骤返回了结果集；本入口只执行无结果集的写入和初始化，请用普通查询查看结果。');
      record.affectedRows = result.affectedRows;
      record.status = 'success';
      if (record.phase === 'batch' && record.name === task.steps.at(-1)?.name) feedback.completedBatches += 1;
      if (record.sessionState === 'lost') {
        // The server acknowledged this statement. Keep its success distinct
        // from the loss of session state that prevents following steps.
        feedback.error = `步骤「${record.name}」已完成，但连接会话已断开，后续步骤已停止；不会重新连接或重放初始化。`;
        return 'failed';
      }
    } catch (error) {
      const cancelled = signal.requested || isQueryCancelled(error);
      record.status = cancelled ? 'cancelled' : 'failed';
      record.error = formatDatabaseError(error);
      const kind = classifyDatabaseError(error).kind;
      record.needsReview = record.submitted && (cancelled || record.sessionState === 'lost'
        || kind === 'network' || kind === 'unknown' || kind === 'interrupt');
      return cancelled ? 'cancelled' : 'failed';
    } finally { record.durationMs = Date.now() - started; }
  }
  return 'success';
}

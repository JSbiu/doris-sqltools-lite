import type { BatchFeedback, BatchParameters, BatchStepFeedback } from './batchExecution';

export type BatchProgressPhase = 'generating' | 'confirming' | 'connecting' | 'executing' | 'cancelling';

export interface BatchProgressOptions {
  now?: () => number;
  schedule?: (callback: () => void, intervalMs: number) => { dispose(): void };
  parameters?: (record: BatchStepFeedback) => BatchParameters;
}

const PHASE_LABELS: Record<BatchProgressPhase, string> = {
  generating: '生成参数', confirming: '等待启动', connecting: '准备会话',
  executing: '执行 SQL', cancelling: '取消收尾',
};

function scheduleRefresh(callback: () => void, intervalMs: number): { dispose(): void } {
  const timer = setInterval(callback, intervalMs);
  timer.unref();
  return { dispose: () => clearInterval(timer) };
}

function formatElapsed(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}分${seconds % 60}秒`
    : `${Math.floor(minutes / 60)}时${minutes % 60}分${seconds % 60}秒`;
}

function summarizeParameters(parameters: BatchParameters): string {
  const entries = Object.entries(parameters);
  if (!entries.length) return '参数：无';
  let omitted = entries.length > 3;
  const pairs = entries.slice(0, 3).map(([key, value]) => {
    const text = `${key}=${value}`;
    const firstLine = text.split(/[\r\n\u2028\u2029]/u, 1)[0];
    const prefix = firstLine.slice(0, 48).replace(/[\uD800-\uDBFF]$/u, '');
    if (prefix.length === text.length) return text;
    omitted = true;
    return prefix + '…';
  });
  return `参数：${pairs.join('，')}${omitted ? '（已省略，完整参数见报告）' : ''}`;
}

/** One notification's lifetime; dispose after execution or cancellation cleanup settles. */
export class BatchProgress {
  private readonly now: () => number;
  private readonly timer: { dispose(): void };
  private disposed = false;
  private phase: BatchProgressPhase = 'generating';
  private phaseStartedAt: number;
  private taskStartedAt: number | undefined;
  private stepStartedAt: number | undefined;
  private feedback: BatchFeedback | undefined;
  private step: BatchStepFeedback | undefined;
  private connectionName: string | undefined;

  public constructor(private readonly report: (message: string) => void, private readonly options: BatchProgressOptions = {}) {
    this.now = options.now ?? Date.now;
    this.phaseStartedAt = this.now();
    this.timer = (options.schedule ?? scheduleRefresh)(() => this.publish(), 1000);
    this.publish();
  }

  public prepare(feedback: BatchFeedback): void {
    if (this.disposed) return;
    // Keep the original feedback: completedBatches changes after whole batches finish.
    this.feedback = feedback;
    this.step = undefined;
    this.connectionName = undefined;
    this.stepStartedAt = undefined;
    this.taskStartedAt = undefined;
    this.setPhase('confirming');
  }

  public startTask(): void {
    if (this.disposed) return;
    this.taskStartedAt ??= this.now();
    this.setPhase('executing');
  }

  public setStep(record: BatchStepFeedback): void {
    if (this.disposed) return;
    this.step = record;
    this.stepStartedAt = this.now();
    this.connectionName = record.connectionName;
    this.setPhase('executing');
  }

  public setPhase(phase: BatchProgressPhase, connectionName?: string): void {
    if (this.disposed) return;
    if (this.phase !== phase) this.phaseStartedAt = this.now();
    this.phase = phase;
    if (connectionName !== undefined) this.connectionName = connectionName;
    this.publish();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.timer.dispose();
  }

  public refresh(): void { this.publish(); }

  private publish(): void {
    if (this.disposed) return;
    const now = this.now();
    const parts = [PHASE_LABELS[this.phase]];
    if (this.feedback) parts.push(`已完成 ${this.feedback.completedBatches}/${this.feedback.batchCount} 批`);
    if (this.step) {
      parts.push(this.step.phase === 'init' ? '初始化' : `第 ${this.step.batchIndex} 批`, `步骤：${this.step.name}`);
    }
    if (this.connectionName !== undefined) parts.push(`连接：${this.connectionName}`);
    if (this.step) parts.push(summarizeParameters(this.options.parameters?.(this.step) ?? this.step.parameters));
    if (this.taskStartedAt === undefined) {
      parts.push('任务未启动', `阶段 ${formatElapsed(now - this.phaseStartedAt)}`);
    } else {
      parts.push(`任务 ${formatElapsed(now - this.taskStartedAt)}`);
    }
    if (this.stepStartedAt !== undefined) parts.push(`本步 ${formatElapsed(now - this.stepStartedAt)}`);
    this.report(parts.join(' · '));
  }
}

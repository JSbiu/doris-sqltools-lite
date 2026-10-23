import { QueryCancelledError, type QuerySession } from './querySession';

export interface SessionEntry {
  readonly documentKey: string;
  readonly profileId: string;
  session?: QuerySession;
  revision: number;
  valid: boolean;
  closing?: Promise<void>;
}

export interface SessionSnapshot {
  readonly entry: SessionEntry;
  revision: number;
}

export interface DocumentOperation {
  readonly documentKey: string;
  profileId?: string;
  readonly done: Promise<void>;
  cancelled: boolean;
  cancel(): void;
  finish(): void;
}

export class SessionExpiredError extends Error {
  constructor() {
    super('原查询的会话已失效或执行过其他语句，不能重跑导出。请重新执行初始化语句和查询后再导出。');
    this.name = 'SessionExpiredError';
  }
}

// Owns sessions, not database semantics. A document has independent sessions
// per profile but just one operation (including prompts and exports) at a time.
export class DocumentSessions {
  private readonly entries = new Map<string, Map<string, SessionEntry>>();
  private readonly operations = new Map<string, DocumentOperation>();
  private readonly closingDocuments = new Map<string, Promise<void>>();
  private readonly closingProfiles = new Map<string, Promise<void>>();
  private disposed = false;

  public begin(documentKey: string, onCancel: () => void): DocumentOperation | undefined {
    if (this.disposed || this.operations.has(documentKey) || this.closingDocuments.has(documentKey)) return undefined;
    let complete!: () => void;
    const done = new Promise<void>((resolve) => { complete = resolve; });
    const operation: DocumentOperation = {
      documentKey, done, cancelled: false,
      cancel: () => {
        if (operation.cancelled) return;
        operation.cancelled = true;
        onCancel();
      },
      finish: () => {
        if (this.operations.get(documentKey) === operation) this.operations.delete(documentKey);
        complete();
      },
    };
    this.operations.set(documentKey, operation);
    return operation;
  }

  public hasProfile(profileId: string): boolean {
    return [...this.entries.values()].some((profiles) => profiles.has(profileId));
  }

  public async open(
    operation: DocumentOperation, profileId: string, factory: () => Promise<QuerySession>,
  ): Promise<SessionEntry> {
    operation.profileId = profileId;
    this.assertOperation(operation);
    if (this.closingProfiles.has(profileId)) throw new Error('该连接正在释放会话，请稍后重新执行。');
    let profiles = this.entries.get(operation.documentKey);
    const existing = profiles?.get(profileId);
    if (existing?.session) {
      if (existing.session.broken) {
        await this.discard(existing);
        throw new Error('原连接已断开，会话状态已丢失。请重新执行 USE、SET 等初始化语句后再查询；本次语句未自动重试。');
      }
      return existing;
    }
    if (!profiles) {
      profiles = new Map();
      this.entries.set(operation.documentKey, profiles);
    }
    const entry: SessionEntry = { documentKey: operation.documentKey, profileId, revision: 0, valid: true };
    profiles.set(profileId, entry);
    try {
      const session = await factory();
      // A close/reset/config edit may have happened while the password prompt
      // or handshake was awaiting. Never install that late connection.
      if (operation.cancelled || !entry.valid || this.disposed) {
        await session.close().catch(() => undefined);
        throw new QueryCancelledError();
      }
      entry.session = session;
      return entry;
    } catch (error) {
      this.remove(entry);
      throw error;
    }
  }

  public startStatement(operation: DocumentOperation, entry: SessionEntry): QuerySession {
    this.assertOperation(operation);
    if (entry.documentKey !== operation.documentKey || operation.profileId !== entry.profileId || !this.current(entry)) {
      throw new SessionExpiredError();
    }
    entry.revision += 1;
    return entry.session!;
  }

  public snapshot(entry: SessionEntry): SessionSnapshot {
    return { entry, revision: entry.revision };
  }

  public validate(snapshot: SessionSnapshot): SessionEntry {
    if (!this.current(snapshot.entry) || snapshot.entry.revision !== snapshot.revision) throw new SessionExpiredError();
    return snapshot.entry;
  }

  public async discard(entry: SessionEntry): Promise<void> {
    this.remove(entry);
    await this.closeEntry(entry);
  }

  public closeDocument(documentKey: string): Promise<void> {
    const pending = this.closingDocuments.get(documentKey);
    if (pending) return pending;
    const closing = this.closeMatching((entry) => entry.documentKey === documentKey, (op) => op.documentKey === documentKey);
    this.closingDocuments.set(documentKey, closing);
    void closing.finally(() => this.closingDocuments.delete(documentKey));
    return closing;
  }

  public closeProfile(profileId: string): Promise<void> {
    const pending = this.closingProfiles.get(profileId);
    if (pending) return pending;
    const closing = this.closeMatching((entry) => entry.profileId === profileId, (op) => op.profileId === profileId);
    this.closingProfiles.set(profileId, closing);
    void closing.finally(() => this.closingProfiles.delete(profileId));
    return closing;
  }

  public async closeAll(): Promise<void> {
    this.disposed = true;
    await this.closeMatching(() => true, () => true);
    await Promise.all([...this.closingDocuments.values(), ...this.closingProfiles.values()]);
  }

  private current(entry: SessionEntry): boolean {
    return entry.valid && !!entry.session && !entry.session.broken
      && this.entries.get(entry.documentKey)?.get(entry.profileId) === entry;
  }

  private assertOperation(operation: DocumentOperation): void {
    if (operation.cancelled || this.disposed || this.operations.get(operation.documentKey) !== operation) {
      throw new QueryCancelledError();
    }
  }

  private remove(entry: SessionEntry): void {
    entry.valid = false;
    const profiles = this.entries.get(entry.documentKey);
    if (profiles?.get(entry.profileId) === entry) profiles.delete(entry.profileId);
    if (profiles?.size === 0) this.entries.delete(entry.documentKey);
  }

  private closeEntry(entry: SessionEntry): Promise<void> {
    entry.closing ??= entry.session?.close().catch(() => undefined) ?? Promise.resolve();
    return entry.closing;
  }

  private async closeMatching(
    matchEntry: (entry: SessionEntry) => boolean, matchOperation: (op: DocumentOperation) => boolean,
  ): Promise<void> {
    const entries = [...this.entries.values()].flatMap((profiles) => [...profiles.values()]).filter(matchEntry);
    for (const entry of entries) this.remove(entry);
    const operations = [...this.operations.values()].filter(matchOperation);
    for (const operation of operations) operation.cancel();
    // Drivers must finish cancellation/draining before close touches the same
    // protocol stream. Unrelated profiles/documents keep their sessions.
    await Promise.all(operations.map((operation) => operation.done));
    await Promise.all(entries.map((entry) => this.closeEntry(entry)));
  }
}

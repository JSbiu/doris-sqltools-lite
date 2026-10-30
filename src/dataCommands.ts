import * as vscode from 'vscode';
import { open, readFile, unlink } from 'node:fs/promises';
import type { DataKeys } from './dataKeys';
import { decryptValue } from './fieldEncryption';
import { getDataMode, onDataModeChange, setDataMode } from './dataProtection';

function decryptedText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
  return String(value);
}

export function registerDataCommands(context: vscode.ExtensionContext, keys: DataKeys): void {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  status.name = 'Doris SQL Lite Data Mode';
  status.command = 'dorisSqlLite.toggleDataMode';
  const refresh = (): void => {
    status.text = getDataMode() === 'encrypted' ? '$(lock) SQL 加密模式' : '$(unlock) SQL 明文模式';
    status.tooltip = '切换当前窗口结果、参数、复制和导出的模式。只有 SQL 注释声明的字段参与加密。';
    status.show();
  };
  refresh();
  const register = (name: string, action: () => Promise<void> | void): vscode.Disposable =>
    vscode.commands.registerCommand(`dorisSqlLite.${name}`, async () => {
      try { await action(); }
      catch { void vscode.window.showErrorMessage('字段加密操作未完成，请核对密钥文件、密文格式和本地文件权限；未输出密钥或原值。'); }
    });
  context.subscriptions.push(status, onDataModeChange(refresh),
    register('toggleDataMode', () => setDataMode(getDataMode() === 'encrypted' ? 'plain' : 'encrypted')),
    register('exportDataKeys', async () => {
      const target = await vscode.window.showSaveDialog({
        title: '导出数据密钥：文件包含敏感密钥，请自行妥善保管',
        saveLabel: '导出敏感密钥', filters: { JSON: ['json'] },
      });
      if (!target) return;
      if (target.scheme !== 'file') throw new Error('需要本地文件。');
      const text = await keys.exportKeys();
      const file = await open(target.fsPath, 'wx', 0o600);
      try { await file.writeFile(text, 'utf8'); await file.close(); }
      catch (error) {
        await file.close().catch(() => undefined);
        try { await unlink(target.fsPath); }
        catch { void vscode.window.showErrorMessage('密钥导出失败，未完成的密钥文件无法清理，请在所选位置手动删除。'); }
        throw error;
      }
      void vscode.window.showInformationMessage('数据密钥已导出。文件包含敏感密钥，请自行妥善保管。');
    }),
    register('importDataKeys', async () => {
      const targets = await vscode.window.showOpenDialog({
        title: '导入数据密钥（保留现有密钥）', canSelectMany: false, filters: { JSON: ['json'] },
      });
      if (!targets?.length) return;
      if (targets[0].scheme !== 'file') throw new Error('需要本地文件。');
      await keys.importKeys(await readFile(targets[0].fsPath, 'utf8'));
      void vscode.window.showInformationMessage('数据密钥已导入，旧密钥已保留。已有结果继续使用执行时的密钥。');
    }),
    register('decryptSelectedValue', async () => {
      const editor = vscode.window.activeTextEditor;
      const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection).trim() : undefined;
      const token = selected || await vscode.window.showInputBox({ title: '解密单个值', prompt: '输入完整 enc: 密文，仅在本机解密', ignoreFocusOut: true });
      if (!token) return;
      await keys.loadToken(token);
      const raw = decryptValue(token, (id) => keys.lookup(id));
      const choice = await vscode.window.showQuickPick(['在本机查看明文', '复制明文'], { title: '解密成功，选择明文的输出位置' });
      if (choice === '复制明文') await vscode.env.clipboard.writeText(decryptedText(raw));
      if (choice === '在本机查看明文') {
        const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: decryptedText(raw) });
        await vscode.window.showTextDocument(document, { preview: true });
      }
    }),
  );
}

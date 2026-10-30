# 开发与验证

## 环境

- Windows 10/11、Linux 或 macOS。
- Node.js 22 或更新版本。扩展 bundle 的目标运行时仍是 Node 20。
- pnpm 11.25.0。
- VS Code 1.90.0 或更新版本。

安装依赖：

```powershell
pnpm install --frozen-lockfile
```

`pnpm-workspace.yaml` 使用 hoisted 布局，适配当前 Windows 文件系统。VS Code 类型固定为 `@types/vscode@1.90.0`，与 `engines.vscode` 的最低版本保持一致。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm run compile` | TypeScript 编译到 `out/` |
| `pnpm run build` | esbuild 生成 `dist/extension.js` |
| `pnpm run watch` | 监听源码并重建 bundle |
| `pnpm run watch:types` | 只监听 TypeScript 类型编译 |
| `pnpm run lint` | ESLint |
| `pnpm run check:webview` | 检查四个 Webview 脚本、nonce 和选择器 |
| `pnpm run check:bundle` | 在 VS Code 之外激活 bundle 并探测两个驱动 |
| `pnpm run check:notices` | 检查第三方依赖声明与当前安装依赖一致 |
| `pnpm run preview:webviews` | 把真实 Webview HTML 输出到系统临时目录 |
| `pnpm test` | 编译、Webview、bundle 和全部 Node 测试 |
| `pnpm run test:vscode` | 启动指定 VS Code 版本的集成测试 |
| `pnpm run package` | 构建并生成 VSIX |

## 本地调试

在 VS Code 中打开仓库：

1. 运行 `pnpm run build`。
2. 按 F5，使用 `.vscode/launch.json` 启动扩展开发主机。
3. F5 加载的是 `dist/extension.js`。

只运行 `tsc -w` 会更新 `out/`，不会更新调试宿主加载的 bundle。开发扩展运行行为时使用 `pnpm run watch`。

## 测试分层

### Node 单元测试

```powershell
pnpm test
```

测试文件位于 `tests/**/*.test.js`，加载 `out/` 中的编译结果。纯逻辑模块不导入 `vscode`，因此可以直接 `require`。

测试覆盖：

- SQL 语句范围、参数、注释和 LIMIT 策略。
- MySQL、Spark 假驱动的结果、取消与错误路径。
- 文件会话、互斥、快照失效和分批执行。
- TSV、报告、路径与排他写入。
- Webview HTML、内联脚本和可访问性契约。
- 字段加密向量、密钥存储与反馈投影。

### VS Code 集成测试

```powershell
pnpm run test:vscode
```

默认下载并运行 VS Code `1.90.0`。可用环境变量切换版本：

```powershell
$env:VSCODE_TEST_VERSION = 'stable'
pnpm run test:vscode
```

测试入口：

- `tests/vscode/runTest.js`
- `tests/vscode/suite/index.js`

集成测试验证扩展激活、命令注册、配置 schema 和连接表单入口。下载的 VS Code 位于 `.vscode-test/`，已被 Git 忽略。

## Webview 预览

```powershell
pnpm run preview:webviews
```

脚本从 `out/` 加载真实渲染函数，把连接、参数、计划和结果页写到系统临时目录。输出 JSON 包含 HTML 文件路径。

视觉验收至少检查：

- 1200px 桌面宽度。
- 720px 窄编辑器。
- 420px 侧栏。
- 320px 极窄窗口。
- 页面没有横向溢出。
- 结果表在自身区域滚动。
- 操作按钮保持单行文字。

完整页面职责、状态模型、键盘与高对比主题检查见 [界面与交互规范](ux.md)。

## Bundle 检查

```powershell
pnpm run build
pnpm run check:bundle
```

检查器在系统临时目录构建驱动 probe，避免依赖 `.local` 或个人目录。它验证：

- `dist/extension.js` 能加载和激活。
- 22 个命令完成注册。
- `mysql2` 与 `hive-driver` 在 bundle 中可解析。
- Hive 传输、认证和协议类型可用。

## 打包

```powershell
pnpm run package
```

产物：

```text
doris-sqltools-lite-<version>.vsix
```

VSIX 只包含运行所需文件。安装前核对：

1. `package.json` 版本。
2. VSIX 文件清单。
3. 包内 README 与 LICENSE。
4. bundle 大小。

本机安装：

```powershell
code --install-extension .\doris-sqltools-lite-<version>.vsix --force
code --list-extensions --show-versions
```

安装后执行 `Developer: Reload Window`。

## 真实 MySQL / Doris 检查

先编译：

```powershell
pnpm run compile
```

对一次性 MySQL 或 Doris 实例运行：

```powershell
node scripts/check-live-mysql.js `
  --host=127.0.0.1 `
  --port=3306 `
  --user=e2e `
  --password=<password> `
  --database=e2e `
  --seed
```

`--seed` 会创建 `types_demo` 与 `big_rows`，并 TRUNCATE 这两张表。只对一次性数据库使用。

检查内容包括：

- 小结果类型与列名。
- BIGINT、DECIMAL、NULL、BINARY。
- 30,000 行预览上限。
- INSERT / UPDATE / DELETE / DDL 影响行数。
- 错误后会话可用性。
- 取消后连接干净。
- 全量重跑导出文件。

## 真实 Spark Thrift 检查

```powershell
node scripts/check-live-spark.js `
  --host=127.0.0.1 `
  --port=10000 `
  --user=hive `
  --password=<password> `
  --auth=plain
```

`--auth` 取 `plain` 或 `nosasl`，必须与服务端启动参数一致。

脚本会创建 `e2e_db` 和 `e2e_types`，并对一次性 Spark Thrift 实例运行。检查内容包括：

- 协议版本协商与 SASL/PLAIN 握手。
- 标量、复杂类型和大整数。
- DDL / DML 与结果读取。
- 200,000 行 streaming。
- 取消后会话状态。
- 多次语句后的协议稳定性。

## 文档检查

```powershell
node scripts/check-docs.js
```

检查器验证：

- README 和 docs 的本地 Markdown 链接存在。
- 文档中的 `Doris SQLTools Lite:` 命令标题存在于 `package.json`。
- CHANGELOG 包含当前版本。
- 必需的 1.0 文档文件齐全。

`pnpm test` 还会运行 `scripts/generate-third-party-notices.js --check`，确认 `THIRD_PARTY_NOTICES.md` 与当前生产依赖版本和许可证文本一致。依赖升级后运行：

```powershell
pnpm run generate:notices
```

## 常见开发问题

### F5 后仍运行旧代码

用 `pnpm run watch` 重建 bundle。`out/` 只供测试和类型检查。

### 测试找不到 `out/`

先运行 `pnpm run compile` 或直接运行 `pnpm test`。

### Webview 脚本改动后测试失败

运行 `pnpm run check:webview`。检查器会定位未声明的 id、nonce 不匹配和选择器失效。

### CI 与本地依赖不同

CI 使用 `pnpm install --frozen-lockfile`。更新依赖后同步提交 `package.json` 与 `pnpm-lock.yaml`。

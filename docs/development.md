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
| `pnpm run check:webview` | 检查连接、参数和输出 Webview 脚本、nonce 和选择器 |
| `pnpm run check:layout` | 用无头 Chrome 检查连接、参数和输出面板布局、主题变量、响应式和 200% 缩放 |
| `pnpm run check:bundle` | 在 VS Code 之外激活 bundle 并探测两个驱动 |
| `pnpm run check:notices` | 检查第三方依赖声明与当前安装依赖一致 |
| `pnpm run check:vsix` | 单独检查当前版本的实际 VSIX 内容 |
| `pnpm run check:vsix-install` | 在隔离 VS Code 配置中安装并激活当前 VSIX |
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

集成测试验证扩展激活、运行中的命令清单与 `package.json` 一致、关键配置的 schema/default/scope，以及添加连接 Webview 通过公开 Tab API 打开、关闭并在关闭后再次打开。等待界面变化时有 5 秒上限，结束时清理测试创建的标签页。下载的 VS Code 位于 `.vscode-test/`，已被 Git 忽略。

这组测试证明扩展宿主可激活、公开命令和配置契约可用、连接表单确实创建为 Webview 标签页；数据库连接、表单填写和保存仍由真实使用验收覆盖。

## Webview 预览

```powershell
pnpm run preview:webviews
```

脚本从 `out/` 加载真实渲染函数，把连接、参数、输出面板的结果/计划 Tab 写到系统临时目录。输出 JSON 包含 HTML 文件路径。

视觉验收至少检查：

- 1200px 桌面宽度。
- 720px 窄编辑器。
- 420px 侧栏。
- 320px 极窄窗口。
- 页面没有横向溢出。
- 结果表在自身区域滚动。
- 操作按钮保持单行文字。

完整页面职责、状态模型、键盘与高对比主题检查见 [界面与交互规范](ux.md)。

`pnpm run check:layout` 会先调用 `pnpm run preview:webviews` 生成真实 HTML，再通过 Chrome DevTools Protocol 检查 320px、420px、720px、1200px 与 100%/200% 设备比例下的页面级横向溢出、主题焦点变量、`aria-live` 状态区和结果表自身滚动。默认是 Chrome/Edge 的常用安装路径；可用 `CHROME_PATH` 指定其他可执行文件。主题变量覆盖不等于 VS Code 窗口内主题切换，完整键盘流程仍需实际窗口验收。

## Bundle 检查

```powershell
pnpm run build
pnpm run check:bundle
```

检查器在系统临时目录构建驱动 probe，避免依赖 `.local` 或个人目录。它验证：

- `dist/extension.js` 能加载和激活。
- 21 个命令完成注册。
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

`pnpm run package` 在 `vsce package` 成功后自动检查实际生成的 VSIX。也可单独运行：

```powershell
pnpm run check:vsix
```

检查器读取 ZIP 中央目录，验证：

1. 包内 `package.json` 的 publisher、name、displayName、version 和 main 与仓库一致。
2. `dist/extension.js`、README、LICENSE 和 `media/icon.svg` 存在且非空。
3. 源码、测试、脚本、skill、node_modules、source map、本机目录和其他 `.vscodeignore` 排除项没有进入包内。

检查器使用 Node.js 内置 `fs` 与 `zlib`，可在 Windows、Linux 和 macOS 运行。

`pnpm run check:vsix-install` 默认使用 VS Code `1.90.0` 的隔离用户目录，先确认目录中没有本扩展，再安装当前 VSIX，并通过官方扩展测试启动器核对版本、激活、21 个命令与关键配置。可传入 `--vscode-version=1.145.1` 复验其他版本，例如：`node scripts/check-vsix-install.js --vscode-version=1.145.1`。它不需要复用本机日常 VS Code 的扩展目录，也不连接数据库；窗口级 Reload Window、密码/密钥保留和命令面板人工观察仍需单独验收。

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

### 锁文件与本地依赖

验证前使用 `pnpm install --frozen-lockfile`。更新依赖后同步提交 `package.json` 与 `pnpm-lock.yaml`。

# Doris SQLTools Lite

面向 VS Code 的 MySQL、Apache Doris 与 Spark Thrift SQL 工作台。文件中的 SQL 直接执行，连接、参数、会话、结果、执行计划和 AI 审核材料沿同一条可核对工作流组织。

当前发布线：`0.9.9`，目标版本：`1.0.0`。

## 核心能力

- 光标级执行：`Ctrl+Enter` 执行光标所在或最近一条 SQL。
- 文件级连接：文件默认连接、语句级连接覆盖和按连接保留会话。
- SQL 参数：`${name}`、默认值、候选值、参数页和实际发送 SQL 预览。
- 执行计划：MySQL `EXPLAIN`、Doris `EXPLAIN VERBOSE`、Spark `EXPLAIN FORMATTED`。
- 完整导出：`@output` 或面板按钮流式写出完整 TSV。
- 顺序批次：PowerShell 生成参数，扩展预检全部批次并逐条执行。
- 字段保护：注释声明字段，窗口内即时切换字段密文与字段原文。
- AI 反馈：版本化 JSON，默认不含 SQL 正文、结果行或密码。
- 统一界面：连接、参数、计划和结果页共享视觉与响应式规则。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [使用指南](docs/usage.md) | 连接、SQL 注释、参数、执行、计划、结果、导出、会话和批次 |
| [安全模型](docs/security.md) | SecretStorage、TLS、字段密文、密钥与工作区信任 |
| [反馈 schema v1](docs/feedback-schema.md) | AI 反馈字段、批次摘要、完整报告和兼容规则 |
| [架构](docs/architecture.md) | 模块分层、会话模型、驱动、Webview、文件完成点和测试边界 |
| [开发与验证](docs/development.md) | 环境、构建、测试、预览、真实数据库检查和打包 |
| [产品定位](docs/product.md) | 目标用户、产品原则、1.0 承诺和版本策略 |
| [界面与交互](docs/ux.md) | 共享布局、页面职责、状态、响应式、可访问性和验收流程 |
| [发布检查清单](docs/release-checklist.md) | 稳定版发布门禁 |
| [变更日志](https://github.com/JSbiu/doris-sqltools-lite/blob/main/CHANGELOG.md) | 版本阶段和主要变化 |
| [历史与设计记录](docs/history.md) | 旧版实现背景、实测和设计沿革 |
| [Skill](https://github.com/JSbiu/doris-sqltools-lite/blob/main/skills/doris-sqltools-lite/SKILL.md) | 使用本扩展编写 SQL 时的 AI 操作约定 |

## 支持范围

| 数据源 | 协议 | 认证与传输 |
| --- | --- | --- |
| MySQL | MySQL protocol | 密码、TLS、私有 PEM CA |
| Apache Doris | MySQL protocol | 密码、TLS、私有 PEM CA |
| Spark Thrift | HiveServer2 Thrift | SASL/PLAIN、NOSASL、binary transport |

VS Code 最低版本：`1.90.0`。

扩展运行时由单个 bundle 提供，安装后不依赖本机 npm、独立 SQLTools 或其他数据库扩展。

## 安装

从仓库构建并安装：

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm run package
code --install-extension .\doris-sqltools-lite-0.9.9.vsix --force
```

安装后执行 `Developer: Reload Window`。用以下命令核对版本：

```powershell
code --list-extensions --show-versions
```

## 快速开始

1. 在活动栏打开 **Doris SQLTools Lite**。
2. 在“连接”视图执行 **添加连接**。
3. 选择 Doris、MySQL 或 Spark Thrift，填写连接目标并测试。
4. 新建 `.sql` 文件，在第一条 SQL 前声明默认连接。
5. 将光标放在 SQL 上，按 `Ctrl+Enter`。

```sql
-- @default-connection: 分析 Doris
-- @default-param: biz_date = 2026-10-30
-- @default-encrypt: {"user_id":"user"}

-- @name: 订单汇总
SELECT dt, COUNT(*) AS order_count
FROM orders
WHERE dt = '${biz_date}'
GROUP BY dt;
```

连接名称、表名、字段和参数按实际任务替换。

## 常用工作流

### 查询与结果

- `Ctrl+Enter` 执行当前语句。
- 结果面板复用同一个标签页，支持筛选、三态排序、复制和导出。
- 有结果集的语句显示面板；真实无结果集的写入只显示完成通知。
- 面板保留 `maxResultRows` 行；完整导出写出全部结果。

### 执行计划

- 将光标放在 SQL 上，按 `Ctrl+Alt+Enter`。
- 计划页保留完整缩进和全部行。
- “复制 AI 反馈 / 保存 AI 反馈…”引用完整计划文件。
- 需要含 SQL、请求和计划的快照时，显式使用“复制完整材料”。

### 完整 TSV

```sql
-- @output: results/orders_2026-10-30.tsv
SELECT * FROM orders WHERE dt = '2026-10-30';
```

`@output` 查询只提交一次，逐行写盘，不追加预览 LIMIT。已有文件不覆盖。

### 顺序批次

```sql
-- @batch-script: scripts/days.ps1
-- @batch-init: ["设置变量"]
-- @batch-steps: ["清理当天", "回填当天"]
```

执行 `Doris SQLTools Lite: 顺序分批执行 SQL`。脚本输出参数数组，扩展预检全部批次后按顺序执行。完整用法见 [使用指南](docs/usage.md#顺序分批执行)。

### 字段密文

```sql
-- @default-encrypt: {"user_id":"user","owner_id":"user"}
```

窗口初始显示字段密文。状态栏、结果页和计划页的模式按钮共享切换。详细算法与密钥管理见 [安全模型](docs/security.md)。

## 命令

| 命令 ID | 标题 |
| --- | --- |
| `dorisSqlLite.addConnection` | `Doris SQLTools Lite: 添加连接` |
| `dorisSqlLite.newQuery` | `Doris SQLTools Lite: 新建 SQL 查询` |
| `dorisSqlLite.setConnection` | `Doris SQLTools Lite: 为当前文件选择连接` |
| `dorisSqlLite.resetFileSessions` | `Doris SQLTools Lite: 重置当前文件的会话` |
| `dorisSqlLite.editConnection` | `Doris SQLTools Lite: 编辑连接` |
| `dorisSqlLite.runQuery` | `Doris SQLTools Lite: 执行光标处 SQL` |
| `dorisSqlLite.runQueryToTsv` | `Doris SQLTools Lite: 执行并导出完整 TSV` |
| `dorisSqlLite.runBatch` | `Doris SQLTools Lite: 顺序分批执行 SQL` |
| `dorisSqlLite.copyLastFeedback` | `Doris SQLTools Lite: 复制最近一次执行反馈` |
| `dorisSqlLite.saveLastFeedback` | `Doris SQLTools Lite: 保存最近一次执行反馈` |
| `dorisSqlLite.toggleDataMode` | `Doris SQLTools Lite: 切换字段密文 / 字段原文` |
| `dorisSqlLite.exportDataKeys` | `Doris SQLTools Lite: 导出字段加密密钥` |
| `dorisSqlLite.importDataKeys` | `Doris SQLTools Lite: 导入字段加密密钥` |
| `dorisSqlLite.decryptSelectedValue` | `Doris SQLTools Lite: 解密选中字段值` |
| `dorisSqlLite.cancelQuery` | `Doris SQLTools Lite: 取消当前查询` |
| `dorisSqlLite.explainQuery` | `Doris SQLTools Lite: 查看光标处执行计划` |
| `dorisSqlLite.testConnection` | `Doris SQLTools Lite: 测试连接` |
| `dorisSqlLite.removeConnection` | `Doris SQLTools Lite: 删除连接` |
| `dorisSqlLite.forgetPassword` | `Doris SQLTools Lite: 清除已保存密码` |
| `dorisSqlLite.setExportDirectory` | `Doris SQLTools Lite: 设置默认导出目录` |
| `dorisSqlLite.clearExportDirectory` | `Doris SQLTools Lite: 清除默认导出目录` |
| `dorisSqlLite.forgetSqlParameters` | `Doris SQLTools Lite: 清除当前文件的查询参数` |

## 配置

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `dorisSqlLite.connections` | `[]` | 非敏感连接元数据，用户级 `machine` 作用域 |
| `dorisSqlLite.maxResultRows` | `1000` | 面板保留和复制使用的最大行数 |
| `dorisSqlLite.exportDirectory` | `""` | TSV 默认目录；空值表示每次选择 |
| `dorisSqlLite.exportChunkRows` | `5000` | 导出时每批写入行数 |
| `dorisSqlLite.escapeSpreadsheetFormulas` | `true` | 转义电子表格公式形状的单元格 |
| `dorisSqlLite.sqlParameters` | `true` | 启用 `${name}` 参数替换 |
| `dorisSqlLite.readRowLimit` | `0` | 读取停止上限；`0` 跟随预览上限，`-1` 读取完整结果 |
| `dorisSqlLite.queryIdleTimeoutMs` | `300000` | 状态请求或相邻数据行的空闲超时 |

## 安全摘要

- 密码只保存在 VS Code SecretStorage。
- 连接清单不含密码，使用用户设置 `scope: machine`。
- SQL 参数保存在本机扩展状态。
- 字段密钥独立保存在 SecretStorage。
- MySQL / Doris TLS 默认校验证书链和 DNS 主机名。
- 分批脚本只在受信任工作区运行。
- 扩展不自动发送 SQL、结果、计划或参数到远端服务。

完整边界与报告入口见 [安全模型](docs/security.md) 和 [SECURITY.md](SECURITY.md)。

## AI 反馈

反馈 `schemaVersion=1`，包含：

- 扩展版本、SQL 名称、连接名称与类型。
- 实际参数和来源路径、行号。
- 操作、状态、提交情况、耗时和行数。
- 结果、计划与批次报告路径。
- 会话状态、是否需要核对和脱敏诊断。

默认反馈不包含 SQL 正文、计划正文、结果行或连接凭证。完整字段与示例见 [反馈 schema v1](docs/feedback-schema.md)。

## 开发

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm run test:vscode
pnpm run package
```

常用辅助命令：

```powershell
pnpm run preview:webviews
pnpm run check:docs
pnpm run check:webview
pnpm run check:bundle
```

开发环境要求 Node.js 22+ 与 pnpm 11.25.0。扩展 bundle 目标运行时为 Node 20，最低 VS Code 版本为 1.90.0。详细说明见 [开发与验证](docs/development.md)。

## 产品边界

当前工作流聚焦：

- 一次一条 SQL，配合文件级会话。
- 手工触发的计划和顺序批次。
- 有界结果预览与完整文件导出。
- 显式生成、显式复制、显式保存的 AI 材料。
- 单值解密和版本化反馈。

SQL 智能补全、对象编辑、SSH 隧道编排、事务工作台和自动 AI 调用属于外部工具或后续版本方向。1.0 的范围与承诺见 [产品定位](docs/product.md)。

## 许可

MIT。字段加密声明见 [LICENSE](https://github.com/JSbiu/doris-sqltools-lite/blob/main/LICENSE)，运行时依赖的完整许可证文本见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

# Doris SQLTools Lite

面向 VS Code 的 MySQL、Apache Doris 与 Spark Thrift SQL 工作台。文件中的 SQL 直接执行，结果和执行计划进入同一个输出面板；复制只分“原始内容”和“带上下文”，导出只负责完整产物。

当前发布线：`0.9.12`，目标版本：`1.0.0`。

## 核心能力

- 光标级执行：`Ctrl+Enter` 执行光标所在或最近一条 SQL。
- 统一输出：结果和计划共用同一个面板、两个 Tab、两个动作：复制、导出。
- 文件级连接：文件默认连接、语句级连接覆盖和按连接保留会话。
- SQL 参数：`${name}`、默认值、候选值、参数页和实际发送 SQL 预览。
- 执行计划：MySQL `EXPLAIN`、Doris `EXPLAIN VERBOSE`、Spark `EXPLAIN FORMATTED`。
- 复制模式：`@copy: extra` 给 AI 引用包，`@copy: origin` 只给计划原文或原始 TSV。
- 完整导出：`@output` 或面板“导出”流式写出完整 TSV。
- 字段保护：`@encrypt` 声明的结果字段按当前输出模式处理；不再设置全局模式入口。
- 顺序批次：作为高级命令保留，不进入日常右键菜单和输出面板。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [使用指南](docs/usage.md) | 连接、SQL 注释、参数、执行、计划、结果、导出、会话和批次 |
| [安全模型](docs/security.md) | SecretStorage、TLS、字段保护、密钥与工作区信任 |
| [反馈 schema v1（1.x 兼容）](docs/feedback-schema.md) | 旧反馈字段与兼容规则；1.0 输出界面不再使用 |
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
code --install-extension .\doris-sqltools-lite-0.9.12.vsix --force
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
5. 将光标放在 SQL 上，按 `Ctrl+Enter` 查看结果，或按 `Ctrl+Alt+Enter` 查看计划。
6. 在输出面板按 **复制** 或 **导出**。

```sql
-- @default-connection: 分析 Doris
-- @default-param: biz_date = 2026-10-30
-- @copy: extra

-- @name: 订单汇总
SELECT dt, COUNT(*) AS order_count
FROM orders
WHERE dt = '${biz_date}'
GROUP BY dt;
```

连接名称、表名、字段和参数按实际任务替换。

## 常用工作流

### 统一输出面板

- `Ctrl+Enter` 执行当前语句。
- `Ctrl+Alt+Enter` 获取当前语句的执行计划。
- 结果和计划进入同一个输出面板的“结果 / 计划”两个 Tab；取计划不覆盖结果，取结果不覆盖同一 SQL 的计划。
- 面板只有两个动作：**复制**、**导出**。筛选和三态排序只改变当前表格，不影响复制和导出的顺序。
- 有结果集的语句显示面板；真实无结果集的写入只显示完成通知。
- 面板保留 `maxResultRows` 行；完整导出写出全部结果。

### 复制：origin / extra

`-- @copy: extra` 是默认值：

- 计划 Tab 复制引用、引擎/连接、参数、耗时和计划正文。
- 结果 Tab 复制引用、引擎/连接、参数、耗时、行列数和原始 TSV。
- SQL 不复制正文，只给文件引用，例如 `[orders.sql:12-24](D:/queries/orders.sql:12)`；Codex 点开就是 VS Code 对应行。

`-- @copy: origin` 只复制当前内容：

- 计划 Tab 复制纯计划正文。
- 结果 Tab 复制纯 TSV，可直接贴到表格。

复制只使用面板已加载的行；需要完整结果时使用导出。

### 执行计划

- 将光标放在 SQL 上，按 `Ctrl+Alt+Enter`。
- 计划 Tab 保留完整缩进和全部行。
- 计划正文始终可见；字段保护只影响结果数据和导出，不再遮挡计划或 SQL 引用。

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

### 字段保护

```sql
-- @encrypt: {"user_id":"user","owner_id":"user"}
```

字段保护由 SQL 注释声明，AI 通过 skill 生成 SQL 时可以直接决定保护哪些字段。声明的结果字段按当前输出模式处理，结果 Tab 只显示只读的“N 字段已保护”徽章；没有全局状态栏。密钥导入导出和切换原文留在命令面板。详细算法与密钥管理见 [安全模型](docs/security.md)。

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
| `dorisSqlLite.copySqlReference` | `Doris SQLTools Lite: 复制 SQL 引用` |
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

## 复制给 AI

输出面板的“复制”根据 `@copy` 生成：

- `extra`：引用链接、引擎/连接、实际参数、耗时、计划正文或结果摘要与 TSV。
- `origin`：只复制当前 Tab 的原始内容，适合贴表格或交给其他工具。

SQL 正文不进入复制包；`[orders.sql:12-24](D:/queries/orders.sql:12)` 指向源文件，AI 按行号读取。结果和计划 `extra` 对未保存 SQL 只标“未保存 SQL”，不复制正文；显式“复制 SQL 引用”或错误引用才回退为带语言标记的原始 SQL 模板。计划请求、审核清单和固定提示语不重复复制；计划审核要求由 skill 维护。
受保护参数同样按当前字段模式输出：字段密文模式下 `extra` 只带密文，字段原文模式下才带明文。

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
- 结果与计划进入同一个输出面板。
- 有界结果预览与完整文件导出。
- `@copy: origin` 的纯内容和 `@copy: extra` 的 AI 引用包。
- 由 SQL 注释声明的字段保护。

顺序批次保留为高级命令，不进入日常右键菜单；AI 反馈 JSON、计划请求和审核清单不再出现在复制/保存界面。

SQL 智能补全、对象编辑、SSH 隧道编排、事务工作台和自动 AI 调用属于外部工具或后续版本方向。1.0 的范围与承诺见 [产品定位](docs/product.md)。

## 许可

MIT。字段加密声明见 [LICENSE](https://github.com/JSbiu/doris-sqltools-lite/blob/main/LICENSE)，运行时依赖的完整许可证文本见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

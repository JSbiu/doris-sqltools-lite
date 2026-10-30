# 架构与运行模型

## 运行形态

扩展入口是 `src/extension.ts`。构建脚本用 esbuild 把扩展与运行时依赖打包成 `dist/extension.js`，VSIX 只包含：

- `dist/extension.js`
- `package.json`
- README
- LICENSE
- 图标

`vscode` 模块由扩展宿主提供，始终作为 external。`bufferutil` 与 `utf-8-validate` 是 Thrift 运行时可选探测的原生加速器，也保持 external。

构建目标是 Node 20 CommonJS。TypeScript 编译到 `out/`，供单元测试直接 `require`。

## 模块分层

### VS Code 接口层

| 模块 | 职责 |
| --- | --- |
| `extension.ts` | 激活、命令、树视图、状态栏、查询编排、结果面板、导出与计划入口 |
| `connectionForm.ts` | 连接添加/编辑 Webview |
| `parameterForm.ts` | SQL 参数确认 Webview |
| `planPanel.ts` | 执行计划 Webview |
| `webviewTheme.ts` | 四个 Webview 的共享视觉、响应式和可访问性规则 |
| `dataCommands.ts` | 字段模式、密钥导入导出与单值解密命令 |

VS Code 接口层可以组合纯逻辑模块，纯逻辑模块不反向依赖 UI。

### 连接与驱动

| 模块 | 职责 |
| --- | --- |
| `connectionSecurity.ts` | 连接元数据规范化与凭据脱敏 |
| `connectionDraft.ts` | 连接串、JDBC URL、mysql 命令行解析与表单草稿 |
| `connectionManager.ts` | 用户设置、SecretStorage、认证失败重试 |
| `connectionDiagnostics.ts` | 数据库错误分类和中文建议 |
| `sessionFactory.ts` | 按类型选择 MySQL 或 Hive 适配器 |
| `querySession.ts` | 统一会话、取消信号和行 sink 接口 |
| `mysqlSession.ts` | MySQL/Doris streaming、取消、DDL/DML |
| `hiveSession.ts` | HiveServer2/Spark Thrift 握手、轮询、fetch、取消 |
| `hiveResult.ts` | Hive 列式结果解码与类型保持 |
| `idleGuard.ts` | 状态请求和行间空闲超时 |

两个驱动向 UI 暴露相同的 `QuerySession` 语义。协议差异留在驱动内部。

### SQL 与结果

| 模块 | 职责 |
| --- | --- |
| `queryResults.ts` | SQL 语句范围、行收集、结果 view |
| `rowLimit.ts` | 预览 LIMIT 注入与危险尾部语法保护 |
| `sqlDirectives.ts` | 文件注释、连接、参数、输出、字段和批次解析 |
| `sqlParameters.ts` | `${...}` 扫描、默认值、候选和替换 |
| `executionPlan.ts` | 各引擎 EXPLAIN SQL 与计划文本 |
| `directExport.ts` | 一次执行并导出前的语句类型检查 |
| `exports.ts` | TSV 编码与公式转义 |
| `tsvFileWriter.ts` | 临时文件、流式写盘、排他发布 |
| `exportPath.ts` | 默认文件名与相对路径 |

### 会话与任务

| 模块 | 职责 |
| --- | --- |
| `documentSessions.ts` | 文件级互斥、按连接保留会话、快照失效 |
| `batchExecution.ts` | 分批定义、预检、顺序执行和逐步记录 |
| `batchScript.ts` | PowerShell 进程、字节上限、取消和进程树终止 |
| `batchProgress.ts` | 长任务通知、阶段、参数摘要与计时 |

同一文件的一次操作持有 `DocumentOperation`。计划、查询、导出、参数表单和批次通过该锁互斥。不同文件拥有独立操作。

### 字段保护与反馈

| 模块 | 职责 |
| --- | --- |
| `fieldEncryption.ts` | AES-256-SIV、类型编码、token 校验 |
| `dataKeys.ts` | SecretStorage 密钥生成、缓存、导入和活动指针 |
| `dataProtection.ts` | 字段规则投影、参数解码、sink 保护 |
| `sqlFeedback.ts` | 反馈白名单、schema 版本、摘要与完整报告 |
| `feedbackActions.ts` | 剪贴板、Markdown、计划与批次报告写入 |

字段密钥与连接密码分开管理。反馈投影保留原执行记录，模式切换只改变展示和输出快照。

## 查询流程

```text
编辑器 SQL
  -> resolveStatementContext
  -> connection resolution
  -> parameter resolution / parameter form
  -> document operation lock
  -> session lookup or open
  -> row LIMIT planning
  -> driver execute
  -> result collector or TSV writer
  -> result panel / notification
  -> feedback record
```

### 会话复用

文件以连接 ID 为键保留会话。切换连接不会修改原连接会话。会话快照绑定：

- 会话条目
- revision
- 语句次序
- 来源文件状态

截断结果的全量导出使用该快照重跑原 SQL。快照失效时要求重新查询。

## 预览上限

默认路径有三种：

1. 普通 SELECT：必要时注入 `LIMIT maxResultRows + 1`，确认是否截断。
2. 行读取上限：达到显式上限后请求取消。
3. `readRowLimit=-1`：读取完整答案。

危险尾部语法包括行锁、`INTO`、`PROCEDURE` 和 Spark 的 `DISTRIBUTE BY` / `SORT BY` / `CLUSTER BY`。这些语句不注入 LIMIT，改用读取上限或完整读取路径。

## TSV 完成点

流式写入流程：

```text
open temporary file
  -> write header
  -> write bounded row blocks
  -> close temporary file
  -> exclusive hard link to final path
  -> remove temporary name
```

正式链接成功是完成点。链接后清理失败返回 `cleanupWarning`，结果文件仍有效；链接前失败会删除本次创建的临时文件。

## 取消

统一取消信号进入两个驱动：

- MySQL/Doris：另一条控制连接执行 `KILL QUERY`。
- Spark Thrift：HiveServer2 `CancelOperation`。

驱动等待已开始的本地写盘完成。取消本身有期限；迟到的 KILL 或 operation 不能影响下一条语句。

## 字段投影

字段规则在查询准备阶段确定。预览原值留在扩展宿主内存中，展示时按当前模式投影。复制、导出、报告和参数表单在操作开始时固定模式快照。

字段保护 sink 可以在驱动回调中延迟列错误，避免在事件回调里抛出未捕获异常。

## Webview

四个页面共享：

- 页头与任务说明
- 状态徽章
- 分区卡片
- 固定操作栏
- 键盘焦点
- 窄侧栏单列布局
- 表格自身滚动
- `aria-live` 状态区

真实 HTML 由 `scripts/preview-webviews.js` 生成。`scripts/check-webview.js` 检查内联脚本、nonce 和静态选择器。

布局、状态和可访问性验收基线见 [界面与交互规范](ux.md)。

## 测试边界

Node 单元测试覆盖：

- 纯解析、状态机和数据库驱动假流。
- Webview 实际 HTML 与内联脚本。
- 临时文件、取消、错误和竞争条件。
- 反馈 schema 与字段保护。

VS Code 集成测试覆盖：

- 最低 VS Code 版本激活。
- 扩展 ID 与 22 个命令注册。
- 配置 schema 存在。
- 连接表单命令可以执行。

真实数据库脚本覆盖假流无法证明的协议行为。它们按需对一次性实例运行。

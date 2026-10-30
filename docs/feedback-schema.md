# AI 反馈 JSON 契约

本文定义 `schemaVersion=1` 的 SQL 反馈。反馈由扩展在白名单字段上生成，可复制到剪贴板、保存为 Markdown，或作为批次报告保存为 JSON。

## 版本与兼容

- `schemaVersion`：当前固定为 `1`。
- `extensionVersion`：产生材料的扩展版本。
- 新字段可以在 `1.x` 中追加。消费者应忽略未知字段。
- 删除字段、更改字段含义或更改枚举语义需要提升 `schemaVersion`。
- Markdown 反馈把 JSON 放在 ` ```json ` 代码块中；批次报告保存为格式化 JSON 文件。

## 嵌套限制

- 默认反馈保留最终调用的白名单字段。
- SQL 正文、执行计划正文、结果行和连接凭证不进入默认 JSON。
- `error` 与 `warning` 经过凭据脱敏，最高 2000 字符；超长内容以 `… [已截断]` 结尾。
- Stack frame 被丢弃，多行诊断中属于业务信息的内容可以保留。
- 路径在本地文件存在时为绝对文件路径；其他 URI 使用 URI 字符串。

## 顶层字段

以下表格是当前版本的完整字段白名单。`schemaVersion`、身份与来源、操作状态、完成时间和耗时构成核心结构；行数、产物、字段保护和计划字段只在对应操作产生时出现。JSON 序列化会省略值为 `undefined` 的属性。

### 身份与来源

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schemaVersion` | `1` | 反馈契约版本 |
| `extensionVersion` | `string` | 产生反馈的扩展版本 |
| `name` | `string` | SQL 或批次任务名称 |
| `connectionName` | `string` | 连接显示名称 |
| `databaseType` | `"MySQL" \| "Doris" \| "Spark" \| null` | 数据库类型；准备阶段失败时可为 `null` |
| `parameters` | `object<string,string>` | 本次实际使用的参数；字段密文模式按规则投影 |
| `source.path` | `string` | SQL 来源文件绝对路径或 URI |
| `source.startLine` | `number` | 执行范围的起始行 |
| `source.endLine` | `number` | 执行范围的结束行 |
| `source.savedAtExecution` | `boolean` | 执行时来源文件是否已保存 |
| `source.changedSinceExecution` | `boolean \| null` | 执行后是否检测到改动；`null` 表示当前状态未核对 |

### 操作状态

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `action` | `"query" \| "export" \| "explain" \| "batch"` | 操作类型 |
| `status` | `"success" \| "failed" \| "cancelled"` | 最终状态 |
| `submitted` | `boolean` | 本操作是否向数据库提交过 SQL |
| `generatedAt` | `string` | ISO 8601 完成时间 |
| `durationMs` | `number` | 操作持续时间，单位毫秒 |
| `sessionState` | `"retained" \| "lost" \| "not-opened"` | 结束时业务会话状态 |
| `needsReview` | `boolean` | 已提交操作的结果或写入是否需要人工核对 |
| `error` | `string` | 脱敏后的错误摘要 |
| `warning` | `string` | 脱敏后的警告摘要 |

`submitted=false` 可以表示执行前取消、连接失败、参数失败，也可以表示把完整内存结果直接保存为文件。判断时需要同时读取 `action` 和 `status`。

### 结果与行数

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `rowsRead` | `number` | 驱动实际读到的行数 |
| `totalRows` | `number \| null` | 查询总行数；`null` 表示未知 |
| `displayedRows` | `number` | 面板保留或显示的行数 |
| `readComplete` | `boolean` | 本次是否读取完整结果 |
| `truncated` | `boolean` | 面板结果是否被截断 |
| `previewLimit` | `number` | 扩展自动追加的预览上限 |
| `hasResultSet` | `boolean` | 语句是否返回结果集 |
| `affectedRows` | `number \| null` | 服务端提供的影响行数；`null` 表示未知 |

### 产物路径

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `resultFile` | `string` | 已完成的完整结果文件 |
| `planFile` | `string` | 已保存的完整计划文件 |
| `batchReportFile` | `string` | 已保存的完整批次报告 |
| `temporaryFile` | `string` | 清理失败后明确报告的残留路径 |

产物字段只在文件完成后填写。取消、失败或清理失败不会把未完成文件写成成功产物。

### 字段保护

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `dataMode` | `"plain" \| "encrypted"` | 复制或保存开始时固定的输出模式 |
| `protection.mode` | `"plain" \| "encrypted"` | 投影模式 |
| `protection.keyId` | `string` | 非敏感密钥标识 |
| `protection.fields` | `object<string,string>` | 字段名到逻辑域 |

没有声明保护字段时，这些字段可以省略。

### 计划

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `explainKind` | `string` | 计划类型或适配器标记 |

完整计划正文通过 `planFile` 引用。

## 普通查询示例

```json
{
  "schemaVersion": 1,
  "extensionVersion": "0.9.9",
  "name": "订单明细",
  "connectionName": "分析 Doris",
  "databaseType": "Doris",
  "parameters": {
    "biz_date": "2026-10-30"
  },
  "source": {
    "path": "D:\\queries\\orders.sql",
    "startLine": 12,
    "endLine": 18,
    "savedAtExecution": true,
    "changedSinceExecution": false
  },
  "action": "query",
  "status": "success",
  "submitted": true,
  "generatedAt": "2026-10-30T09:15:30.000Z",
  "durationMs": 842,
  "rowsRead": 12840,
  "totalRows": 12840,
  "displayedRows": 1000,
  "readComplete": true,
  "truncated": true,
  "hasResultSet": true,
  "affectedRows": null,
  "sessionState": "retained"
}
```

## 批次完整报告

批次报告的 `batch` 保留全部已授权明细：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `batch.script` | `string` | 参数脚本路径 |
| `batch.batchCount` | `number` | 批次数 |
| `batch.completedBatches` | `number` | 全部步骤成功的批次数 |
| `batch.initSteps` | `string[]` | 初始化步骤名 |
| `batch.steps` | `string[]` | 每批步骤名 |
| `batch.records` | `object[]` | 初始化与逐批步骤的完整记录 |
| `batch.error` | `string` | 任务级错误摘要 |

`batch.records` 每项包含：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `phase` | `"init" \| "batch"` | 初始化或普通批次 |
| `batchIndex` | `number` | 从 1 开始的批次序号；初始化省略 |
| `name` | `string` | 步骤名称 |
| `connectionName` | `string` | 步骤连接名称 |
| `databaseType` | `"MySQL" \| "Doris" \| "Spark"` | 步骤数据库类型 |
| `parameters` | `object<string,string>` | 该步骤实际参数 |
| `startLine` | `number` | 步骤 SQL 起始行 |
| `endLine` | `number` | 步骤 SQL 结束行 |
| `status` | `"success" \| "failed" \| "cancelled" \| "not-run"` | 步骤状态 |
| `submitted` | `boolean` | 该步骤是否提交过 SQL |
| `durationMs` | `number` | 步骤耗时 |
| `affectedRows` | `number \| null` | 影响行数 |
| `sessionState` | `"retained" \| "lost" \| "not-opened"` | 步骤结束时会话状态 |
| `needsReview` | `boolean` | 已提交写入是否需要核对 |
| `error` | `string` | 脱敏后的步骤错误 |
| `protection` | `object` | 步骤字段保护信息 |

## 批次默认摘要

剪贴板和 Markdown 默认批次摘要使用紧凑结构：

```json
{
  "batch": {
    "script": "scripts/days.ps1",
    "batchCount": 2,
    "completedBatches": 1,
    "steps": [
      {
        "phase": "batch",
        "name": "清理当天",
        "connectionName": "分析 Doris",
        "databaseType": "Doris",
        "startLine": 20,
        "endLine": 22
      }
    ],
    "firstBatch": {
      "batchIndex": 1,
      "steps": [
        {
          "name": "清理当天",
          "parameters": { "biz_date": "2026-10-30" },
          "submitted": true,
          "status": "success"
        }
      ]
    },
    "lastBatch": {
      "batchIndex": 2,
      "steps": [
        {
          "name": "清理当天",
          "parameters": { "biz_date": "2026-10-31" },
          "submitted": false,
          "status": "not-run"
        }
      ]
    },
    "stopped": {
      "phase": "batch",
      "batchIndex": 2,
      "name": "回填当天",
      "parameters": { "biz_date": "2026-10-31" },
      "status": "failed",
      "submitted": true,
      "sessionState": "lost",
      "needsReview": true,
      "completedSteps": ["清理当天"],
      "needsReviewSteps": ["回填当天"]
    }
  }
}
```

摘要中的 `firstBatch` 与 `lastBatch` 是样例，不表示中间批次连续成功。逐批结论以 `submitted`、`status`、`completedBatches` 和 `stopped` 为准。完整明细只保存在 `batchReportFile`。

## 字段密文模式

- `parameters`、批次步骤参数、错误和警告按操作开始时固定的模式投影。
- `dataMode=encrypted` 时，已声明参数使用字段密文；未声明参数保持普通输出。
- 字段密文模式下，自由格式错误改为“错误类别 + 结构化提示”。
- `protection.fields` 只包含字段名和逻辑域，不包含密钥材料。
- `resultFile` 与报告路径按模式隔离。已有文件不会在模式切换后自动改写。

## 消费者检查清单

读取反馈时依次核对：

1. `schemaVersion` 与 `extensionVersion`。
2. `name`、`connectionName`、`databaseType`。
3. `action`、`status`、`submitted`、`sessionState`。
4. `source.path` 与执行时行号。
5. `parameters`、`dataMode`、`protection`。
6. `rowsRead`、`totalRows`、`displayedRows`、`readComplete`。
7. `resultFile`、`planFile`、`batchReportFile`。
8. 批次的 `completedBatches`、`stopped` 和完整报告 `batch.records`。

`needsReview=true`、`totalRows=null`、`affectedRows=null`、`sessionState=lost` 和 `temporaryFile` 都需要人工确认，不能按成功完成推断。

# 使用指南

本文覆盖连接、SQL 文件、参数、执行、计划、结果、复制、导出、会话、分批任务和字段保护。安全模型见 [security.md](security.md)，旧反馈字段见 [feedback-schema.md](feedback-schema.md)。

## 工作模型

- 一个 SQL 文件可以服务多个连接。
- 文件首次使用某条连接时选择目标，之后按连接 ID 复用该文件的会话。
- 普通执行一次提交一条 SQL。光标所在语句、选区或紧邻的 `@name` 注释决定执行范围。
- 同一文件的查询、计划、导出、参数表单和分批任务互斥；不同文件可以并行。
- 连接和会话只存在于当前扩展窗口。Reload Window 后重新选择连接，并重新执行 `USE`、`SET` 等初始化语句。

## 添加连接

在活动栏打开 **Doris SQLTools Lite**，在“连接”视图点击添加，或执行：

`Doris SQLTools Lite: 添加连接`

连接表单分为：

1. **快速导入**：粘贴 `mysql://`、`jdbc:mysql://`、`jdbc:hive2://`、`host:port`、`user@host` 或 `mysql` 命令行。
2. **连接目标**：类型、名称、主机、端口、默认数据库、用户名和密码。
3. **传输安全**：MySQL / Doris 的 TLS、证书校验和私有 CA。
4. **密码策略**：编辑连接时保留、覆盖或清除已保存密码。

密码通过 VS Code SecretStorage 保存。连接元数据保存在用户设置 `dorisSqlLite.connections`，作用域为 `machine`。

### 类型与默认端口

| 类型 | 默认端口 | 协议 |
| --- | ---: | --- |
| Doris | 9030 | MySQL 协议 |
| MySQL | 3306 | MySQL 协议 |
| Spark Thrift | 10000 | HiveServer2 Thrift |

切换类型时会带出默认端口。手动改过的端口保持不变。

### TLS

MySQL / Doris 可以启用 TLS。默认执行以下校验：

- 校验证书链。
- 主机是 DNS 名称时校验证书主机名。
- 私有 CA 通过 `sslCaFile` 指定本地 PEM 文件。

关闭 `sslVerify` 会进入显式的“接受服务器证书”兼容模式，适用于已确认可信的私有或临时证书目标。

Spark Thrift 的连接表单使用 SASL/PLAIN 或 NOSASL 传输，TLS 字段只属于 MySQL / Doris。

### Spark Thrift 认证

- **SASL/PLAIN**：对应服务端 `--auth none` 或 LDAP。`none` 不校验密码，LDAP 使用真实账号密码。
- **NOSASL**：对应服务端 `--auth nosasl`，使用裸 Thrift socket。

认证方式需要与服务端启动参数一致。握手有独立超时，不匹配时会停止并提示检查认证方式。

## SQL 文件注释

注释写在语句前，扩展按顺序解析。

| 注释 | 范围 | 作用 |
| --- | --- | --- |
| `-- @default-connection: 名称或ID` | 文件第一条 SQL 前 | 为整个文件提供默认连接 |
| `-- @connection: 名称或ID` | 语句前 | 覆盖当前语句连接 |
| `-- @name: 名称` | 语句前 | 为结果、计划和批次步骤提供稳定名称 |
| `-- @default-param: name = value` | 文件第一条 SQL 前 | 为文件参数提供默认值 |
| `-- @param: name = value` | 语句前 | 为当前语句提供参数值 |
| `-- @output: 路径.tsv` | 语句前 | 执行并流式导出完整 TSV |
| `-- @copy: origin\|extra` | 语句前 | 复制当前 Tab 的原始内容，或带上下文的引用包 |
| `-- @default-encrypt: {"字段":"域"}` | 文件第一条 SQL 前 | 为文件声明结果字段保护规则 |
| `-- @encrypt: {"字段":"域"}` | 语句前 | 合并当前语句的结果字段保护规则 |
| `-- @batch-script: 路径.ps1` | 文件第一条 SQL 前 | 指定分批参数脚本 |
| `-- @batch-steps: ["步骤A","步骤B"]` | 文件第一条 SQL 前 | 指定每批的顺序步骤 |
| `-- @batch-init: ["初始化"]` | 文件第一条 SQL 前 | 指定任务开始时只运行一次的步骤 |

示例：

```sql
-- @default-connection: 分析 Doris
-- @default-param: biz_date = 2026-10-30
-- @copy: extra
-- @default-encrypt: {"user_id":"user","owner_id":"user"}

-- @name: 订单汇总
-- @output: results/orders_2026-10-30.tsv
SELECT dt, COUNT(*) AS order_count
FROM orders
WHERE dt = '${biz_date}'
GROUP BY dt;
```

连接名称精确匹配。存在重名时使用连接 ID。注释只保存连接引用，不保存账号、主机或密码。

## SQL 参数

### 基本语法

```text
${name}
${name=default}
${name=A, B, C}
${name=CA(Canada), US(United States)}
$${name}
```

- 参数值按原文插入，扩展不加引号或转义。
- 文本值通常写成 `'${name}'`，数值写成 `${n}`。
- `${name=A, B, C}` 是候选列表，未选择前不算有值。
- `${name=CA(Canada)}` 为候选值提供显示名。
- `$${name}` 把 `${name}` 原样交给服务端，可用于 Spark conf 引用。
- 参数名限定为 `[A-Za-z_][A-Za-z0-9_.-]*`。

### 优先级

分批参数 > 当前语句 `@param` > 文件 `@default-param` > 行内默认值 > 历史记住值。

参数完整时直接执行；缺少值时打开参数页。参数页显示：

- 参数名、来源和只读状态。
- 当前使用值或候选值。
- 实际发送的 SQL。
- 缺失参数数量。

注释值以编辑器为准，参数页只读。历史值按“文件 + 参数名”保存在本机扩展状态。

## 执行 SQL

快捷键：

- `Ctrl+Enter`：执行光标所在或最近的一条 SQL。
- `Ctrl+Alt+Enter`：获取光标所在或选中 SQL 的执行计划。

命令：

- `Doris SQLTools Lite: 执行光标处 SQL`
- `Doris SQLTools Lite: 执行并导出完整 TSV`
- `Doris SQLTools Lite: 顺序分批执行 SQL`

执行规则：

1. 有选区时执行选区内的单条 SQL。
2. 选区包含多条 SQL 时提示分开执行。
3. 没有选区时使用光标所在或最近的一条 SQL。
4. 只选择 SQL 正文时，仍继承前面的连接、参数、名称、输出和字段保护注释。
5. SQL 参数替换后仍须是一条语句。

执行过程中当前文件保持锁定。进度通知和状态栏提供取消入口。

## 执行计划

执行 `Doris SQLTools Lite: 查看光标处执行计划`：

- MySQL 使用 `EXPLAIN`。
- Doris 使用 `EXPLAIN VERBOSE`。
- Spark 使用 `EXPLAIN FORMATTED`。

计划按原 SQL 读取完整文本，不追加预览 `LIMIT`。结果和计划进入同一个输出面板的“结果 / 计划”两个 Tab；取计划不覆盖结果。计划 Tab 始终显示完整计划，字段保护只作用于结果数据和导出。

计划 Tab 的“复制”遵循 `@copy`：

- `extra`：复制引用、引擎/连接、参数、耗时和计划正文。
- `origin`：只复制计划正文。

计划请求（实际 `EXPLAIN` 语句）和审核清单不进入复制包；审核要求由 skill 维护。

## 结果面板

输出面板的“结果”Tab 复用同一个标签页，显示：

- 连接类型、数据库、耗时、行数、列数和名称。
- 当前结果是否声明了字段保护。
- 截断状态与实际读取范围。
- 可排序表格、筛选框和原始顺序状态。

排序按三态循环：升序、降序、原始顺序。排序依据驱动返回的 JavaScript 类型：

- 有限数字按数值排序。
- 文本按区分大小写的 UTF-16 文本排序。
- `NULL` 在两个方向都排在最后。
- 相同值保持查询返回顺序。

排序和筛选只改变当前表格。复制与导出保持查询返回顺序。

实际无结果集的 INSERT、UPDATE、DELETE、USE、SET 等操作完成时只显示通知。返回结果集的语句，包括零行 SELECT，仍打开结果页。

## 结果行数

`dorisSqlLite.maxResultRows` 控制面板保留和复制使用的最大行数，默认 1000。

`dorisSqlLite.readRowLimit` 控制读取停止位置：

- `0`：跟随 `maxResultRows`，达到上限后停止读取并中断语句。
- 正数：设置显式读取上限，下限为 `maxResultRows`。
- `-1`：读取完整结果以获得精确总数，大结果会明显变慢。

预览被截断时：

- 面板保留的行可以筛选、排序和复制。
- “导出 TSV”会重新执行原查询并写出完整结果。
- 已读取行数与总行数是两个不同字段。

## 完整 TSV 导出

### `@output`

```sql
-- @name: 订单明细
-- @output: results/orders_2026-10-30.tsv
SELECT * FROM orders WHERE dt = '2026-10-30';
```

按 `Ctrl+Enter` 时：

- 查询只提交一次。
- 结果逐行写入 TSV，内存只保留有界批次。
- 不追加预览 `LIMIT`。
- 已有目标文件不覆盖。
- 相对路径按已保存 SQL 文件所在目录解析。
- 父目录自动创建。

未保存文件使用绝对路径，或者改用 `Doris SQLTools Lite: 执行并导出完整 TSV` 选择保存位置。

### 面板导出

输出面板只有两个动作：

- **复制**：按 `@copy` 复制当前 Tab。`extra` 带引用、参数、耗时和内容；`origin` 只复制内容。
- **导出**：结果 Tab 导出完整 TSV；计划 Tab 导出计划 `.txt`。结果导出使用默认导出目录，未配置时选择位置。

TSV 使用 UTF-8、无 BOM，并保留列头。默认转义可能被电子表格当作公式的单元格；下游需要原值时关闭 `dorisSqlLite.escapeSpreadsheetFormulas`。

### 文件完成语义

- 本地文件先写入同目录 `.partial`。
- 完成时使用排他链接发布正式文件。
- 取消、数据库错误或磁盘错误会清理本次创建的临时文件。
- 清理失败会给出残留路径。
- 导出开始后不换路径重跑，也不覆盖已有文件。

## 会话

每个 SQL 文件按连接 ID 保留会话。切换连接再回来，原 `USE`、`SET`、临时表等状态仍保留。

以下操作会释放会话：

- 关闭 SQL 文件。
- 执行 `Doris SQLTools Lite: 重置当前文件的会话`。
- 修改连接目标或认证信息。
- 删除连接、清除密码或连接断开。
- 扩展停用或 Reload Window。

重置或断线后重新执行必要初始化语句。扩展不会自动重放失败语句。

## 顺序分批执行

分批入口：

`Doris SQLTools Lite: 顺序分批执行 SQL`

### 文件声明

```sql
-- @batch-script: scripts/days.ps1
-- @batch-init: ["设置变量"]
-- @batch-steps: ["清理当天", "回填当天"]

-- @name: 设置变量
SET @job = 'orders';

-- @name: 清理当天
DELETE FROM orders WHERE dt = '${biz_date}';

-- @name: 回填当天
INSERT INTO orders SELECT * FROM order_source WHERE dt = '${biz_date}';
```

### 参数脚本

PowerShell 输出 UTF-8 JSON 数组：

```powershell
$batches = @(
  @{ biz_date = '2026-10-30' },
  @{ biz_date = '2026-10-31' }
)
ConvertTo-Json -InputObject $batches -Compress
```

脚本要求：

- 工作区受信任。
- 本机有 PowerShell。优先 `pwsh`，Windows 找不到时回退 `powershell.exe`。
- `dorisSqlLite.sqlParameters` 已启用。
- stdout 只写 JSON。
- stderr 最多 8 KiB，stdout 最多 4 MiB。
- 每项参数是非空字符串、有限数字或布尔值。
- 初始化与每批步骤合计不超过 10,000 次。

### 启动与状态

扩展在提交 SQL 前检查全部批次参数和步骤。确认页显示批次数、首尾参数、初始化、步骤与连接。

任务开始后：

- SQL 模板和参数固定。
- 初始化和步骤顺序执行。
- 每次只有一个 SQL 在执行。
- 进度通知持续显示当前批次、步骤、连接、参数摘要和耗时。
- 已开始执行的 SQL 不自动重试、回滚或重放。
- 失败或取消后停止后续步骤。
- 已确认成功但会话随后丢失时，该步骤保留成功状态，后续步骤停止。

完整逐步记录写入批次报告。默认复制摘要，报告路径由 `batchReportFile` 给出。

## 字段保护

字段保护详见 [security.md](security.md)。日常使用要点：

- 只有 `@default-encrypt` / `@encrypt` 声明的结果字段参与转换。
- 字段保护由 skill 在生成 SQL 时决定；例如 AI 可以把 ID 字段写入 `@encrypt`。
- 声明保护字段时，结果页显示只读的“N 字段已保护”徽章；没有全局状态栏。
- 字段保护不影响计划正文和 SQL 引用，AI 仍可审核计划。
- 密钥导入导出、切换原文和单值解密保留在命令面板。
- 复制、导出在操作开始时固定规则和密钥。

## 复制与导出

结果和计划共用“复制”动作：

- `@copy: extra`（默认）：引用链接 + 引擎/连接 + 实际参数 + 耗时 + 行列数/保护字段 + 计划正文或 TSV。结果只保留 TSV 表头作为列定义，不重复复制 `列:` 清单。
- `@copy: origin`：只复制计划正文或 TSV，适合贴表格和交给其他工具。

SQL 正文不进入复制包，只给 Codex 文件引用，例如 `【D:/queries/orders.sql†L12-L24】`。粘贴到 Codex 后显示为可点击文件，右键可用 VS Code 打开到对应行。结果和计划 `extra` 对未保存 SQL 只标“未保存 SQL”，不复制正文；显式“复制 SQL 引用”或错误引用才回退为带语言标记的原始 SQL 模板。计划请求和审核清单不重复复制。AI 反馈 JSON 不再出现在 1.0 的输出界面。
受保护参数也按当前字段模式输出：字段密文模式下 `extra` 只带密文，字段原文模式下才带明文。

## 常见问题

### 当前文件没有连接

执行 `Doris SQLTools Lite: 为当前文件选择连接`，或在 SQL 前添加 `-- @connection:` / 文件头 `-- @default-connection:`。

### 查询没有返回数据库对象

确认默认数据库或语句中的库名。会话保留时，可以先执行 `USE 库名`。

### 导出目标已存在

选择新文件名。扩展保护已有文件和硬链接，不覆盖目标。

### 截断结果无法直接导出

在截断后未插入其他语句时，面板导出会在原会话重跑原查询。会话、语句次序或文件状态改变后，重新查询并导出。

### Spark 连接一直等待

检查 SASL/PLAIN 与 NOSASL 是否和服务端启动参数一致，并确认防火墙允许 Thrift 端口。

### 字段密文无法解密

核对密钥 ID、逻辑域、密文完整性和本机 SecretStorage。丢失密钥后，密文无法仅凭 token 还原。

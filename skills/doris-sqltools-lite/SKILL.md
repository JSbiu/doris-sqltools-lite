---
name: doris-sqltools-lite
description: 为 Doris SQLTools Lite VS Code 扩展编写可执行 SQL，处理字段保护、计划审核、复制引用、顺序分批补数、导出和会话问题。当用户或当前项目约定使用本工具时采用；不用于扩展源码开发或未选用本工具的普通 SQL 工作。
---

# Doris SQLTools Lite 使用

按 1.0 输出模型核对（2026-11-10）。扩展负责执行、结果、计划和复制；业务口径、表结构、方言、文件归属和执行权限沿用当前任务及项目规则。

## 连接与传输

MySQL / Doris 使用 `ssl=true` 启用 TLS；`sslVerify` 默认开启，负责校验证书链，并在主机为 DNS 名称时校验主机名。私有 CA 通过 `sslCaFile` 指向本地 PEM 文件；`sslVerify=false` 对应接受服务器证书的显式兼容模式，使用前确认目标主机可信。Spark Thrift 使用 SASL/PLAIN 或 NOSASL，连接表单中的 TLS 选项仅属于 MySQL / Doris。

## 编写 SQL 文件

从现有上下文确认目标引擎、已保存连接的真实名称或 ID、参数取值和语句用途。连接名称精确匹配，重名时使用 ID；查不到时只澄清缺失项，或明确标为待填草案，不编造可用连接。SQL 注释只引用连接名称或 ID，不写账号密码、主机或连接串。

| 注释 | 作用与位置 |
| --- | --- |
| `-- @default-connection: 连接名称或ID` | 文件默认连接，只能写在第一条 SQL 之前 |
| `-- @default-param: 参数名 = 值` | 文件默认参数，每个参数一行，只能写在第一条 SQL 之前 |
| `-- @default-encrypt: {"user_id":"user"}` | 文件默认保护字段及逻辑域，只能写在第一条 SQL 之前 |
| `-- @name: 语句用途` | 紧接该条 SQL 前，显示在进度和输出面板 |
| `-- @connection: 连接名称或ID` | 覆盖当前语句的连接，不延续到下一条 |
| `-- @param: 参数名 = 值` | 覆盖当前语句的参数，不延续到下一条 |
| `-- @encrypt: {"space_id":"space"}` | 当前语句的保护字段及逻辑域，与默认合并，同名覆盖 |
| `-- @copy: origin\|extra` | 复制当前 Tab 的原始内容，或带引用、参数、耗时的上下文包 |
| `-- @output: 路径.tsv` | 当前语句执行一次并导出完整结果，取计划时忽略 |
| `-- @batch-script: ./backfill-params.ps1` | 文件头指定生成批次参数的 PowerShell 脚本 |
| `-- @batch-steps: ["清理当天", "回填当天"]` | 文件头指定每批执行的 `@name` 及顺序 |
| `-- @batch-init: ["会话设置"]` | 文件头指定任务开始时只执行一次的初始化步骤，可省略 |

为独立语句写有业务含义的 `@name`。注释字段使用英文小写与半角冒号；同一范围内不重复声明同一设置或参数。只有 SQL 前的 `--` 注释有效，块注释和 SQL 正文中的同名文字不作为配置。

示例：

```sql
-- @default-connection: Spark数仓
-- @default-param: c_date = 2026-10-26
-- @copy: extra

-- @name: 订单日汇总
SELECT dt, COUNT(*) AS order_count
FROM orders
WHERE dt = '${c_date}'
GROUP BY dt;
```

参数优先级：当前语句注释 > 文件默认注释 > `${name=default}` 行内默认值。值按原文替换，不自动加引号或转义；日期和文本通常写在 SQL 的 `'${c_date}'` 中，数值按目标类型使用。注释值不能为空，逗号、等号和分号仍属于值，不表示候选列表。`$${name}` 表示把 `${name}` 原样交给服务端。

## 字段保护

需要保护结果字段时，由当前任务决定字段和逻辑域，并写入 SQL 注释；例如 AI 判断 ID 字段需要保护：

```sql
-- @encrypt: {"user_id":"user","owner_id":"user"}
```

- 扩展按声明投影结果数据和导出；未声明字段继续原值输出。
- 计划正文和 SQL 引用始终可见，字段保护不遮挡计划。
- 结果页只显示只读的“N 字段已保护”徽章；没有全局状态栏。
- 切换原文、密钥导入导出、单值解密在命令面板，不属于日常复制/导出。
- 丢失密钥后，单独持有密文无法恢复原值。

## 查看计划、复制与执行

- `Ctrl+Alt+Enter` 或 `Doris SQLTools Lite: 查看光标处执行计划`：对光标所在或选中的单条 SQL 取计划，复用该语句的连接、参数和会话，不修改原 SQL。Spark 使用 `EXPLAIN FORMATTED`，Doris 使用 `EXPLAIN VERBOSE`，MySQL 使用普通 `EXPLAIN`。
- 结果和计划进入同一个输出面板的“结果 / 计划”两个 Tab；取计划不覆盖结果。面板只有“复制”和“导出”两个动作。
- `@copy: extra` 复制引用链接、引擎/连接、实际参数、耗时，以及当前 Tab 的计划正文或结果摘要与 TSV。
- `@copy: origin` 只复制当前 Tab 的原始内容：计划正文或纯 TSV。
- SQL 正文不进入复制包，只给 Markdown 文件引用，例如 `[orders.sql:12-24](D:/queries/orders.sql:12)`。按行号读取来源文件，不要求用户重复粘贴 SQL。
- 结果和计划 `extra` 对未保存 SQL 只标“未保存 SQL”，不复制正文；显式“复制 SQL 引用”或错误引用才回退为带语言标记的原始 SQL 模板。
- 受保护参数按当前字段模式输出；字段密文模式下 `extra` 只带密文。
- 计划请求（实际 `EXPLAIN` 语句）和审核清单不进入复制包；审核清单由本 skill 维护。
- `Ctrl+Enter` 或 `Doris SQLTools Lite: 执行光标处 SQL`：一次执行一条 SQL；有 `@output` 时直接导出完整结果；实际无结果集时只通知，零行 SELECT 仍打开空结果页。

### 计划审核清单

收到 `extra` 计划包后，按来源引用读取 SQL，结合实际参数检查：

- 分区裁剪与扫描范围。
- 过滤条件下推。
- Join 条件、Join 方式与数据膨胀。
- Shuffle / Exchange。
- 排序与聚合。
- 明显的笛卡尔积或重复扫描。

先指出有计划证据的问题，再给修改建议；缺少统计信息或表结构时明确说明，不把估算当作实际运行结果。SQL、参数、连接或会话设置改变后，原计划不能作为新版本已审核的证据。

## 复制与导出

- `origin` 结果用于直接贴表格：纯 TSV，含列头，不带标题、参数或耗时。
- `origin` 计划用于直接阅读：纯计划正文。
- `extra` 结果用于 AI：引用、引擎/连接、参数、耗时、行列数和 TSV。
- `extra` 计划用于 AI：引用、引擎/连接、参数、耗时和计划正文。
- 复制只取面板已加载的行；完整结果用“导出”。导出会写全量，必要时重跑查询。
- 导出结果使用默认导出目录，未配置时选择位置；计划导出为 `.txt`。已有目标不覆盖。

## 会话与导出

- 每个 SQL 文件按连接 ID 保留独立会话；切换连接再回来保留 `USE`、`SET` 等状态。
- 同一文件的查询、计划、参数选择、导出和分批任务互斥；其他文件可独立执行。
- 取消可用进度通知、状态栏或 `Doris SQLTools Lite: 取消当前查询`。取消后会话仍健康则保留。
- 关闭文件、重置会话、修改连接目标/认证信息等会释放相应会话；不自动重放失败语句。
- 完整 TSV 先写唯一 `.partial`，完成后发布正式文件；取消、数据库或磁盘失败会清理临时文件。

## 顺序分批补数

顺序批次保留为高级命令，不进入日常右键菜单。只在当前电脑、VS Code 保持打开时使用；每条 SQL 仍放在同一源文件，`.ps1` 只生成参数，不向脚本传递数据库密码。

```sql
-- @default-connection: Doris数仓
-- @batch-script: ./backfill-params.ps1
-- @batch-steps: ["清理当天", "回填当天"]

-- @name: 清理当天
DELETE FROM order_summary WHERE dt = '${biz_date}';

-- @name: 回填当天
INSERT INTO order_summary
SELECT * FROM order_source WHERE dt = '${biz_date}';
```

脚本 stdout 只输出非空 UTF-8 JSON 数组；需受信任工作区、启用 `sqlParameters`、本机可用 PowerShell。扩展先预检全部批次，再显示数量、首尾参数、步骤与连接；用户确认后才提交 SQL。失败或取消后停止后续步骤，不自动重试、回滚或重放。

当前未支持自动执行文件全部语句、独立命令行/服务器调度、并行批次、自动断点续跑、路径参数替换及自动 AI 审核；不要发明其他指令。

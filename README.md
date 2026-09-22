# Doris SQLTools Lite

一个面向 Windows + VS Code 的极简 MySQL / Doris / Spark Thrift 查询插件 MVP。

## 协作入口

项目规则见 [AGENTS.md](AGENTS.md)。本机偏好与必要上下文位于 `.local/memory.md`（如存在），历史记录按需放在 `.local/archive/` 或 `.local/checkpoints/`，均不进入 Git。共享知识与具体需求记录以项目文档为准。

## 安全模型

- 连接元数据（名称、类型、主机、端口、database、用户名、SSL）保存在**用户设置**里（`dorisSqlLite.connections` 的 `scope` 是 `machine`）：既不会被工作区设置覆盖，也不会随 VS Code Settings Sync 上传。
- 早期版本会把元数据写进当前工作区的 `.vscode/settings.json`，内网主机名和账号名可能跟着项目仓库走。扩展启动时会把这类条目找回并写进用户设置，连接列表不会丢；但**项目文件里那份旧副本不会被自动删除** —— VS Code 不允许对 `machine` 作用域的设置在更窄的作用域执行写入（包括删除）。需要手动到设置编辑器里删掉它，并确认项目的 `.vscode/settings.json` 已被 Git 忽略。
- 密码只保存到 VS Code `ExtensionContext.secrets`（SecretStorage），不会写进任何 `settings.json`。
- 添加连接时密码留空表示「先不保存」，首次连接时会提示输入一次；之后连接自动读取密码。
- 手动输入的密码只在连接成功后才写入 SecretStorage，输错不会被记住。
- 已保存的密码如果认证失败会被自动清除并重新询问一次，不会反复用错误密码重试。
- 扩展启动时会把可识别的旧连接配置中的 `password` 迁移到 SecretStorage，并从连接元数据中清理。
- `Doris` 使用 MySQL 协议连接 FE 的 `9030` 端口。
- `Spark` 走的是 Spark Thrift Server 的 **HiveServer2 Thrift 协议**（默认 `10000` 端口），和 MySQL 协议无关，用的是独立驱动。认证支持 `SASL/PLAIN`（`hive.server2.authentication` 为 `none` 或 `ldap`）与 `NOSASL`；**不支持 Kerberos** —— 它依赖需要本机编译的原生模块，没法随 VSIX 分发。连接清单里不含密码，只有连接元数据；Spark 的认证方式字段同理。
- 扩展不记录密码、连接字符串或查询结果到日志。错误提示会脱敏已知密码，以及 `password=` / `pwd:` / `token=`、`mysql://user:pass@`、`IDENTIFIED BY …`、`SET PASSWORD …` 这类写法。
- 结果不会外发。但要知道两点：结果面板会保留最近一次结果的前 `maxResultRows` 行（标签页隐藏时也是；其余行只在读取时计数，随即丢弃），`复制 TSV` 会把结果写进系统剪贴板并由其保留。共享机器上请注意剪贴板历史与其他窗口。
- SQL 参数的值（`${...}`）保存在 VS Code 扩展状态里，按「文件 + 参数名」记录：**不写 `settings.json`，也不参与 Settings Sync**。它们是业务数据（时间区间、ID），不是密钥，所以不进 SecretStorage；但它们会以明文留在本机的扩展状态目录里，与密码的保管级别不同。

这提供的是“安全存储 + 自动使用”，不是防御同一 Windows 用户下的恶意进程或恶意 VS Code 扩展。任何能控制当前用户的代码，最终都可能在连接时读取到解密后的密码。

## 使用

1. 打开扩展开发主机或安装打包出的 `.vsix`。
2. 在活动栏打开 `Doris SQL Lite`。
3. 点击 `Add Connection`，在弹出的连接表单里一次填完类型、名称、主机、端口、database、用户名、密码和 SSL（类型选 `Spark Thrift` 时会多出一个「认证方式」下拉）。可以先点 `测试连接` 验证，再点 `保存`。
4. 右键连接创建 SQL 查询。第一次执行当前文件时选择连接；同一文件后续语句会复用这条活动连接，因此 `USE`、临时表和会话变量会继续生效。第一次选择的连接也会作为本次 VS Code 会话的默认连接；当前文件如果已指定连接，则优先使用当前文件的连接。
5. 按 `Ctrl+Enter` 或右键 `Doris SQL Lite: Run Query at Cursor`：有选区时执行选中的单条 SQL；没有选区时自动执行光标所在或最近的一条 SQL。语句里含 `${...}` 参数时会先弹出参数面板（见下节）。
6. 查询可以取消：进度通知上的取消按钮，或命令面板执行 `Doris SQL Lite: Cancel Query`。取消走 `KILL QUERY`，活动连接会保留，`USE`、临时表和会话变量继续生效；服务端不响应时会退化为断开该连接。同一 SQL 文件不会并发启动重复查询。
7. 结果复用同一个面板，可查看连接、database、耗时、行列数和截断提示，并支持行号、筛选、TSV 导出和复制。**面板最多保留 `maxResultRows` 行（默认 1000）；导出写的是全部结果（结果被截断时会重新执行一次查询），复制只复制当前显示的那部分。**

当前 SQL 文件使用的连接会显示在 VS Code 状态栏，点击即可切换。也可以在 SQL 编辑器中右键选择 `Doris SQL Lite: Set Connection`。连接选择和活动连接只保存在当前扩展会话内，不会写入工作区配置；关闭 SQL 文件、切换连接、修改/删除连接或扩展停用时会释放活动连接。

在连接列表中右键选择 `Doris SQL Lite: Edit Connection`，会打开同一个表单并带入当前值，只改需要改的字段即可：

- 密码留空 = 保持已保存的密码；填写 = 覆盖；勾选「清除已保存的密码」= 删除本机保存的密码。
- 保存前会校验名称、主机、端口、用户名，并提示重名和指向同一 `host:port` 的重复连接。
- 只有连接目标（类型、主机、端口、用户名、database、SSL）发生变化时，才会关闭这条连接的活动会话，并在提示里说明。
- 顶部支持粘贴连接串（`mysql://user:password@host:9030/db`、`jdbc:mysql://…` 或 `host:port`）自动拆分成字段；密码只进 SecretStorage。

命令面板调用 `Edit Connection` 时会先让你选择要编辑的连接。

database 默认留空且不是必填项，连接和 `Test Connection` 仍可用；但首次查询未限定库名的表时可能出现 `No database selected`。可以在当前文件先执行 `USE hue`，后续语句会复用同一条连接；也可以按需配置默认 database 或使用 `库名.表名`。

如果数据库密码发生变化，可在连接右键菜单执行 `Forget Saved Password`，下次连接时重新输入；密码输错时也会自动清除并重新询问一次。连接与查询失败的报错会转成中文说明并给出下一步建议（端口不通、主机不可解析、database 不存在、账号无权限等），原始报错与错误码保留在消息尾部，密码仍会脱敏。

结果导出只包含查询结果，不包含连接信息或密码；TSV 会处理字段中的引号、换行和制表符。结果页中的 `NULL` 会明确显示，TSV 中仍按空字段导出。导出为 UTF-8 且不带 BOM，用 VS Code 或其他按 UTF-8 打开的工具都没问题。

**导出会防表格公式注入**：以 `=`、`@` 开头，或以 `+`/`-` 开头且后面不是纯数字的单元格，会加上前导单引号 `'`。Excel / LibreOffice / Google Sheets 把 `'` 当作「这是文本」的标记并在单元格里隐去，所以显示的仍是原值，但不会被当公式执行 —— 否则一段用户可控的文本被粘贴进表格就是一个可执行的载荷。纯数字（含负数、科学计数法）不受影响。需要完全原值的下游工具可以关掉 `dorisSqlLite.escapeSpreadsheetFormulas`。

导出写的是**全部结果集**，与面板显示行数无关；分块写入文件（每块行数由 `dorisSqlLite.exportChunkRows` 控制，默认 5000），过程带可取消的进度条，中途取消或写失败会删掉未写完的文件（不会留下半截 TSV 冒充完整结果）。复制只取当前面板显示的那些行，截断时会提示「已复制当前显示的 X 行（共 Y 行）」。超过 10 万行的导出会先弹一次确认，避免误点产生超大文件。

**结果超出面板保留上限时，导出会重新执行一次该查询。** 面板只保留前 `maxResultRows` 行，其余行在读取时就被丢弃（只计数），所以内存里并没有完整结果集可以写出。点导出时会明确提示这一点，扩展另开一条连接重跑该语句、把行直接流式写进文件。代价是导出的内容以「重新执行时」为准：如果表在两次执行之间变了，导出结果可能与面板上看到的不一致；有副作用的语句（存储过程、`INSERT ... RETURNING` 之类）建议先确认再导出。

**内存不再随结果集大小增长。** 驱动按行推给扩展，扩展只保留前 `maxResultRows` 行（默认 1000），其余行流过去即丢弃、只累加计数。所以 `SELECT * FROM 大表` 的内存占用由保留上限决定，和结果集大小无关 —— 过去 10 列 × 100 万行要整份驻留约 296 MB，现在和 10 行的结果一样小。统计里的「共 N 行」仍然准确，因为计数是完整的。

## SQL 参数（Hue 风格，0.8.0）

在 SQL 里写 `${name}`，执行前会弹出参数面板，替换在本地完成后才发给服务端。**对 MySQL、Doris、Spark 三者行为一致** —— 替换发生在扩展这一侧，与协议无关。

```sql
SELECT source_group_id, created_ms
FROM   week_bounds
WHERE  create_time >= '${family_created_from}'
  AND  create_time <  '${family_created_to}'
  AND  week_end_ms  <= ${as_of=2026-09-01}
```

- **引号由模板负责**：文本值写 `'${name}'`，数值写 `${n}`。扩展原样插入，不加引号也不做转义（与 Hue 相同）；面板底部的「实际发送的 SQL」就是这个约定的一道保险，引号写错一眼可见。
- `${name=默认值}`：没有值时用默认值。`${name=A, B, C}` 表示候选值（面板给下拉，未选前不算有值）；`${name=CA(Canada)}` 可以给候选加显示名。同一个参数出现多次时，默认值只需写一处。
- **值只存在本机**：按「文件 + 参数名」记在 VS Code 扩展状态里，再次执行时预填上次用的值，确认后才真的跑。改了 SQL 里的默认值会让记住的值失效，不会让旧值一直盖住新默认值。清除用命令 `Doris SQL Lite: Forget This File's Query Parameters`。
- **`$${name}` 是转义**：把 `${name}` 原样交给服务端。这是给「想用 Spark 自己的 conf 替换」留的路 —— `SELECT '$${spark.sql.shuffle.partitions}'` 由 Spark 解析成 `2`。
- 参数没填完时「执行」按钮不可用；只有「原样发送」才会把未替换的模板直接发出去。
- 想要服务端行为可以关掉 `dorisSqlLite.sqlParameters`。参数名限定为 `[A-Za-z_][A-Za-z0-9_.-]*`，所以正则字面量里的 `${1}` 之类不会被误改。

**为什么这不是"可选便利"**：Spark 会把 `${name}` 当成 Spark conf 的键来解析，而**未定义的键会静默变成空字符串，不报错**（Spark 3.2.0 实测）。于是 `WHERE t >= '${as_of}'` 在没赋值时变成 `WHERE t >= ''`，`CAST` 之后是 `NULL`，查询返回空结果且毫无提示。MySQL/Doris 相反：它们不做替换，`${}` 会原样进语法、直接报语法错。前者才是危险的，参数面板就是为了在语句离开本机之前把值摆明。

## v0.7.5 流式查询

- 驱动改成**按行推送**：MySQL 走 `Query.stream()`（`for await` 自带背压），Spark 走 `fetch()` 逐批 + 每批 `flush()`，不再用会把整份结果堆在内存里的 `fetchAll()`。
- 面板只保留前 `maxResultRows` 行，其余行流过去即丢弃、只累加计数。内存占用由保留上限决定，不再随结果集大小增长。
- 查询进度显示「已读取 N 行…」，长查询期间能看出在推进而不是卡住。
- 结果被截断时，导出改为**重新执行该查询并流式写入文件**（另开一条连接，不干扰你正在用的会话），导出前会提示；未被截断时仍直接写内存里的行，行为不变。`QueryResultView` 不再持有 `allRows`。
- 取消语义不变：MySQL 仍是 `KILL QUERY`，Spark 仍是 `CancelOperation`。
- 新增 `tests/mysql-session.test.js`、`tests/hive-session.test.js`（用假流 / 假 operation 驱动，不需要真实数据库），结果层测试改为覆盖流式收集器。

## v0.5 导出全量结果

- 导出不再受 1000 行限制：`QueryResultView` 现在同时保留全量 `allRows` 与用于渲染的 `rows`，导出写全量，复制仍只复制面板显示的那些行。
- 导出改为分块生成 + 分块写文件（`toTsvBlocks`，默认每块 5000 行），不再一次性拼一个巨型字符串。
- 超过 10 万行的导出会先弹确认；面板截断提示改为「共 N 行，显示前 M 行。导出为全部 N 行；复制为当前显示的 M 行」。
- 复制在结果被截断时明确提示复制了多少行，需要全量时指向导出。
- `dorisSqlLite.maxResultRows` 语义明确为**面板渲染行数**（也决定复制范围），不再影响导出。
- 导出的 TSV 不带 BOM，按 UTF-8 打开即可。

## v0.4 连接诊断与查询取消

- 密码不再被错误地记住：手动输入的密码只在握手成功后写入 SecretStorage；已保存的密码认证失败时自动清除并重新询问一次。
- 错误信息中文化：按 `error.code` 与消息特征归类为认证、网络、database、权限、SSL、服务端、SQL 等，并附带「建议」。
- 取消查询不再拆连接：额外开一条控制连接执行 `KILL QUERY <thread id>`，原连接保留，会话状态不丢；没有可用密码或服务端不响应时回退为断开连接（5 秒兜底）。
- 新增 `Doris SQL Lite: Cancel Query` 命令，除进度通知的取消按钮外多一个入口，可自行绑定快捷键。
- 新增 `tests/connection-diagnostics.test.js`（15 例）。

## v0.3 连接表单

- 添加/编辑连接从 8 步串行弹窗改成单页 Webview 表单：字段可来回修改，切走标签页内容不丢（retainContextWhenHidden）。
- 保存前可用 `测试连接` 直接验证，不必先存再右键测。
- 内联校验：名称/主机/用户名必填、端口范围即时提示，重名阻断保存，重复 `host:port` 给出警告。
- 切换类型自动带出默认端口（Doris 9030 / MySQL 3306），且不会覆盖你手动改过的端口。
- 密码语义明确：新增留空 = 不保存（首次连接再问）；编辑留空 = 保持原密码。彻底区分「空密码」与「没保存密码」。
- 支持从连接串导入，含 URL 编码的密码。
- `Enter` 保存、`Esc` 取消；表单同时只开一个，重复点 `Add Connection` 会复用。

## v0.2 体验优化

- 光标级 SQL 执行：多语句文件不再要求每次手动选中 SQL。
- 当前连接可见：状态栏持续显示当前文件或会话默认连接。
- 查询可控：支持取消和同文件重复执行保护，并展示端到端耗时。
- 结果页聚合：复用单一结果标签，支持筛选、行号、空结果、DML 成功态和截断提醒。
- 连接流程更稳：database 不再带项目特定默认值，输入会自动清理首尾空格，命令面板调用编辑/删除/清除密码时也会先选择连接。


## Spark Thrift（HiveServer2）

类型选 `Spark Thrift` 后，连接走 Spark Thrift Server 的 HiveServer2 Thrift 协议，其余体验（结果面板、筛选、导出、取消、状态栏）与 MySQL/Doris 完全一致。

- **端口**：预填 `10000`（HiveServer2 默认端口）。服务端如果通过 `hive.server2.thrift.port` 改过端口，按实际值填。
- **认证方式**（表单里按类型出现，对上服务端的启动参数即可，不确定就保持默认）：
  - `SASL/PLAIN`（默认）—— 对应服务端 `--auth none`（HiveServer2 默认）或 `ldap`。
    `none` 模式不校验密码，**密码留空即可**；只有 `ldap` 才需要填真实密码。
  - `NOSASL` —— 对应服务端 `--auth nosasl`，裸 Thrift socket，密码可以留空。
  - Kerberos 不支持：它依赖需要本机编译的原生 `kerberos` 模块，没法随 VSIX 分发。
- **协议版本**：从 `HIVE_CLI_SERVICE_PROTOCOL_V10` 起逐级向下重试到 `V6`。Spark 各版本打包的 Hive 版本不同（Spark 2.x 是 Hive 1.2，Spark 3.x/4.x 是 Hive 2.3+），协议版本不匹配时握手会直接失败，所以这里自动降级，不需要手动配置。
- **database**：HiveServer2 的 `OpenSession` 没有「默认库」参数，因此扩展在会话建立后用 `` USE `库名` `` 选中它，和 beeline 的做法一致。留空则不执行 `USE`，后续语句写 `库名.表名` 即可。
- **取消查询**：走 HiveServer2 的 `CancelOperation`，会话保留。这与 MySQL 那条「另开一条连接执行 `KILL QUERY`」的路径不同。
- **连接串导入**：除 `mysql://` / `jdbc:mysql://` / `host:port` 外，也认 `jdbc:hive2://host:10000/db` 与 `hive2://`，并会剥掉 beeline 追加的会话属性（如 `;principal=hive/_HOST@REALM`）。
- **结果类型**：`BIGINT` 超出 `Number.MAX_SAFE_INTEGER` 时以字符串返回，不丢精度（驱动自带的转换会丢）。`DECIMAL`、`DATE`、`TIMESTAMP` 以及 `ARRAY`/`MAP`/`STRUCT` 按服务端返回的原文展示与导出；`BINARY` 显示为 `0x…`。
- **已知边界**：一次只执行一条 SQL；只支持 `binary` 传输模式（不支持 `http`）；不做连接池。

## 本地验证与打包

- 构建 bundle：`node scripts/build.js`
- Bundle 冒烟检查：`node scripts/check-bundle.js`（在 VS Code 之外加载 `dist/extension.js`、跑一遍 `activate()`、并验证两个驱动在 bundle 内可用）
- Webview 检查：`node scripts/check-webview.js`
- 编译（只有测试需要，产物在 `out/`）：`node_modules/.bin/tsc.CMD -p .`
- 测试：`node --test "tests/**/*.test.js"`（glob 由 Node 自己展开。**不要写成 `node --test tests`** —— 在 Windows 上 Node 会把它当成模块路径而失败）
- 打包：`node scripts/package-runtime.js`（会先构建 bundle）
- 对**真实 MySQL** 跑端到端流式检查：`node scripts/check-live-mysql.js --host=127.0.0.1 --port=3306 --user=root --password=… --database=… [--seed]`
- 对**真实 Spark Thrift Server** 跑端到端检查：`node scripts/check-live-spark.js --host=127.0.0.1 --port=10000 --auth=plain`。`--auth` 取 `plain` 或 `nosasl`，必须和服务端启动参数一致。脚本会自建 `e2e_types` 表和 `e2e_db` 库，所以只对一次性测试实例使用。

`scripts/check-live-mysql.js` 不在 `pnpm test` 里，因为它需要一台可连的服务器；改动驱动层（`src/mysqlSession.ts`、`src/hiveSession.ts`、`src/querySession.ts`）后建议手动跑一次。它验证的是假流测不到的东西：真实 `Query.stream()` 行为、非 SELECT 语句的 `affectedRows`、**取消之后连接是否仍然干净**、以及重查导出的落盘结果。`--seed` 会自己建两张表并灌数据（7 行类型样本 + 3 万行），**会 TRUNCATE 这两张表**，所以请指向一次性库。

`pnpm test` 把上面几步串成一条链。改动 `src/` 后需要重建 bundle：`pnpm run watch`，或用 `pnpm run watch:types` 只做类型检查的 watch —— **F5 调试加载的是 `dist/extension.js`，只跑 `tsc -w` 会让调试主机一直执行旧代码。**

扩展的运行时是**单个 esbuild bundle**（`dist/extension.js`）。VSIX 里只有这个文件加 `package.json`、README、LICENSE 和图标，不再打包 `node_modules`（722 个文件降到 7 个）。安装后的扩展不依赖本机的 npm 或 SQLTools。

## 当前 MVP 边界

- 每个 SQL 文件在当前扩展会话中最多保持一条活动连接；不同文件各自独立，关闭文件或扩展停用时释放，不做连接池。
- 一次执行只接受一条 SQL；无选区时自动选择光标所在语句，选区包含多条语句时仍会提示分开执行。
- 结果面板默认最多保留并渲染 1000 行（可通过 `dorisSqlLite.maxResultRows` 调整），面板不做虚拟滚动。超出的部分不保留，只计入「共 N 行」。
- 查询结果不会被整份留在内存里：驱动按行推送，扩展只保留前 `maxResultRows` 行。导出时如果结果被截断，会重新执行一次该查询并流式写文件。
- Spark Thrift 不支持 Kerberos 认证，也不支持 `http` 传输模式；结果集里复杂类型的展示取决于服务端返回的文本形式。
- Spark 的认证方式选错时，服务端**不会回包也不会报错**（例如服务端是 `--auth nosasl` 却选了 `SASL/PLAIN`）。扩展会在 20 秒后中断握手并提示检查认证方式，不会一直转圈。
- 目前不包含 SSH 隧道、SQL 智能补全、事务控制和可编辑表格。

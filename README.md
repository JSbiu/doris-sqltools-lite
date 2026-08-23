# Doris SQLTools Lite

一个面向 Windows + VS Code 的极简 MySQL/Doris 查询插件 MVP。

## 安全模型

- 工作区配置只保存连接名称、主机、端口、数据库和用户名。
- 密码只保存到 VS Code `ExtensionContext.secrets`（SecretStorage），不会写进 `settings.json`。
- 第一次添加连接或在新机器上首次使用时输入一次密码；之后连接自动读取密码。
- 扩展启动时会把可识别的旧连接配置中的 `password` 迁移到 SecretStorage，并从连接元数据中清理。
- `Doris` 使用 MySQL 协议连接 FE 的 `9030` 端口。
- 扩展不记录密码、连接字符串或查询结果到日志。

这提供的是“安全存储 + 自动使用”，不是防御同一 Windows 用户下的恶意进程或恶意 VS Code 扩展。任何能控制当前用户的代码，最终都可能在连接时读取到解密后的密码。

## 使用

1. 打开扩展开发主机或安装打包出的 `.vsix`。
2. 在活动栏打开 `Doris SQL Lite`。
3. 点击 `Add Connection`，选择 `Doris` 或 `MySQL`，首次输入密码。
4. 右键连接创建 SQL 查询。第一次选择的连接会作为本次 VS Code 会话的默认连接；当前文件如果已指定连接，则优先使用当前文件的连接。
5. 按 `Ctrl+Enter` 或右键 `Doris SQL Lite: Run Query at Cursor`：有选区时执行选中的单条 SQL；没有选区时自动执行光标所在或最近的一条 SQL。
6. 查询进度通知支持取消；同一 SQL 文件不会并发启动重复查询。
7. 结果复用同一个面板，可查看连接、database、耗时、行列数和截断提示，并支持行号、筛选、TSV 导出和复制。

当前 SQL 文件使用的连接会显示在 VS Code 状态栏，点击即可切换。也可以在 SQL 编辑器中右键选择 `Doris SQL Lite: Set Connection`。连接选择只保存在当前扩展会话内，不会写入工作区配置。

在连接列表中右键选择 `Doris SQL Lite: Edit Connection`，可以修改连接类型、名称、主机、端口、database、用户名和密码。修改密码时仍只保存到 VS Code SecretStorage。

database 默认留空且不是必填项，连接和 `Test Connection` 仍可用；但查询未限定库名的表时可能出现 `No database selected`。由于每次查询都会新建连接，建议按需配置默认 database 或使用 `库名.表名`。

如果数据库密码发生变化，可在连接右键菜单执行 `Forget Saved Password`，下次连接时重新输入。

结果导出或复制只包含当前结果面板中的数据，不包含连接信息或密码；TSV 会处理字段中的引号、换行和制表符。结果页中的 `NULL` 会明确显示，TSV 中仍按空字段导出。

## v0.2 体验优化

- 光标级 SQL 执行：多语句文件不再要求每次手动选中 SQL。
- 当前连接可见：状态栏持续显示当前文件或会话默认连接。
- 查询可控：支持取消和同文件重复执行保护，并展示端到端耗时。
- 结果页聚合：复用单一结果标签，支持筛选、行号、空结果、DML 成功态和截断提醒。
- 连接流程更稳：database 不再带项目特定默认值，输入会自动清理首尾空格，命令面板调用编辑/删除/清除密码时也会先选择连接。


## 本地验证与打包

- 编译：`node_modules/.bin/tsc.CMD -p .`
- 测试：`node --test tests/connection-security.test.js tests/query-results.test.js tests/exports.test.js`
- 打包：`node scripts/package-runtime.js`

打包脚本会把 `mysql2` 及其生产依赖一并放入 VSIX；安装后的扩展不依赖本机的 npm 或 SQLTools。

## 当前 MVP 边界

- 每次查询创建并关闭一个 MySQL 连接，不做连接池。
- 一次执行只接受一条 SQL；无选区时自动选择光标所在语句，选区包含多条语句时仍会提示分开执行。
- 结果默认最多保留 1000 行，可通过 `dorisSqlLite.maxResultRows` 调整。
- 目前不包含 SSH 隧道、SQL 智能补全、事务控制和可编辑表格。

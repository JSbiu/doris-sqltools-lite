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
4. 右键连接创建 SQL 查询。第一次选择的连接会作为本次 VS Code 会话的默认连接；当前文件如果已指定连接，则优先使用当前文件的连接。选中 SQL 后右键选择 `Doris SQL Lite: Run Query`，或按 `Ctrl+Enter` 执行。没有选中内容时会执行整个 SQL 文件。
5. 在结果面板导出 TSV 文件，也可以点击 `Copy to Clipboard`；两者都使用带表头的 TSV 格式，适合直接粘贴到 Excel。

如果要更换当前文件的连接，在 SQL 编辑器中右键选择 `Doris SQL Lite: Set Connection`。连接选择只保存在当前扩展会话内，不会写入工作区配置。

在连接列表中右键选择 `Doris SQL Lite: Edit Connection`，可以修改连接类型、名称、主机、端口、database、用户名和密码。修改密码时仍只保存到 VS Code SecretStorage。

database 可以留空，连接和 `Test Connection` 仍可用；但查询未限定库名的表时可能出现 `No database selected`。由于每次查询都会新建连接，建议配置默认 database 或使用 `库名.表名`。

如果数据库密码发生变化，可在连接右键菜单执行 `Forget Saved Password`，下次连接时重新输入。

结果导出或复制只包含当前结果面板中的数据，不包含连接信息或密码；TSV 会处理字段中的引号、换行和制表符。

## 本地验证与打包

- 编译：`node_modules/.bin/tsc.CMD -p .`
- 测试：`node --test tests/connection-security.test.js tests/query-results.test.js tests/exports.test.js`
- 打包：`node scripts/package-runtime.js`

打包脚本会把 `mysql2` 及其生产依赖一并放入 VSIX；安装后的扩展不依赖本机的 npm 或 SQLTools。

## 当前 MVP 边界

- 每次查询创建并关闭一个 MySQL 连接，不做连接池。
- 一次执行只接受一条 SQL；检测到多语句时会提示分开执行，避免只展示第一组结果。
- 结果默认最多保留 1000 行，可通过 `dorisSqlLite.maxResultRows` 调整。
- 目前不包含 SSH 隧道、SQL 智能补全、事务控制和可编辑表格。

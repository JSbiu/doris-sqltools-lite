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
4. 右键连接创建 SQL 查询，`Ctrl+Enter` 执行当前文件或选中的 SQL。
5. 在结果面板导出 CSV、JSON 或 TSV。

## 从 SQLTools 迁移

执行命令 `Doris SQL Lite: Import SQLTools Connections`：

- 复制 SQLTools 的 MySQL/MariaDB/TiDB 连接元数据；
- 把已有明文密码迁移进 SecretStorage；
- 只从可导入的 SQLTools 连接中删除 `password` 字段，其他驱动的配置不会修改。

迁移前会弹窗确认。Doris 连接会根据端口 `9030` 或连接名自动标记为 Doris。

## 当前 MVP 边界

- 每次查询创建并关闭一个 MySQL 连接，不做连接池。
- 结果默认最多保留 1000 行，可通过 `dorisSqlLite.maxResultRows` 调整。
- 目前不包含 SSH 隧道、SQL 智能补全、事务控制和可编辑表格。

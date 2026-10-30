# 发布检查清单

## 版本

- [ ] `package.json` 版本已更新。
- [ ] `CHANGELOG.md` 有对应版本条目。
- [ ] README 和 skill 的版本说明已同步。
- [ ] 版本号变更符合项目规则。

## 自动化

- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm run check:notices`
- [ ] `node scripts/check-docs.js`
- [ ] `pnpm run test:vscode`
- [ ] `git diff --check`

`pnpm test` 必须覆盖编译、Webview、bundle 和全部 Node 测试。

## Webview

- [ ] `pnpm run preview:webviews`
- [ ] 检查 1200px、720px、420px、320px。
- [ ] 页面级横向滚动为 0。
- [ ] 结果表多列完整显示并在表格内滚动。
- [ ] 操作按钮文字不换行。
- [ ] 键盘焦点清晰。
- [ ] `aria-live` 状态可以播报。
- [ ] 浅色与深色主题都保持层级。
- [ ] 高对比主题与 200% 缩放可完成主流程。
- [ ] 只用键盘可以完成连接、参数、计划和结果操作。
- [ ] [界面与交互规范](ux.md) 中的状态模型逐项通过。

## VS Code 集成

- [ ] 最低版本 `1.90.0` 激活通过。
- [ ] 当前 stable 激活通过。
- [ ] 22 个命令全部注册。
- [ ] 配置 schema 可读取。
- [ ] 连接表单可以打开。
- [ ] 安装后 Reload Window，实际窗口确认加载新版本。

## 数据库验证

- [ ] MySQL 非生产实例通过 `check-live-mysql.js`。
- [ ] Doris 非生产实例通过 `check-live-mysql.js`。
- [ ] Spark Thrift 非生产实例通过 `check-live-spark.js`。
- [ ] MySQL / Doris TLS 目标已验证证书链和主机名。
- [ ] Spark SASL/PLAIN 与 NOSASL 按实际服务端配置验证。
- [ ] 取消后会话可用。
- [ ] 查询、计划和导出使用同一会话语义。

## 数据安全

- [ ] 密码不出现在设置、日志、反馈和测试夹具。
- [ ] SecretStorage 保存与清除路径验证。
- [ ] 字段密文导出、导入、切换和单值解密验证。
- [ ] 密钥丢失、域不符、密文篡改在提交前失败。
- [ ] 字段密文模式不生成包含原文的反馈正文。
- [ ] 密钥文件导入导出不覆盖已有目标。

## 文件与失败路径

- [ ] 已有 TSV、计划、反馈和报告不被覆盖。
- [ ] 取消后未完成文件清理。
- [ ] 清理失败显示残留路径。
- [ ] 会话丢失后停止后续步骤。
- [ ] 失败语句不自动重试。
- [ ] 批次完成数、未执行步骤和需核对步骤准确。

## VSIX

- [ ] `pnpm run package`
- [ ] 包内版本正确。
- [ ] 包内 README、LICENSE、图标和 bundle 齐全。
- [ ] 包内没有源码、测试、skill、node_modules、source map 或本机目录。
- [ ] VSIX 大小合理。
- [ ] 干净安装通过。
- [ ] 从上一发布版本升级通过。
- [ ] `code --list-extensions --show-versions` 核对安装版本。

## 文档

- [ ] README 快速开始可从零完成。
- [ ] 命令标题与设置说明使用中文。
- [ ] `docs/usage.md` 覆盖主工作流。
- [ ] `docs/security.md` 与当前安全实现一致。
- [ ] `docs/feedback-schema.md` 与反馈构建代码一致。
- [ ] `docs/development.md` 可完成构建、测试和打包。
- [ ] `docs/product.md` 与 1.0 范围一致。
- [ ] `docs/ux.md` 与四个页面的实际结构与文案一致。
- [ ] skill 源文件与本机安装副本一致。

## 交付

- [ ] 检查 `git status` 与提交范围。
- [ ] 保留无关工作区改动。
- [ ] 推送前 fetch 并核对远端。
- [ ] 提交信息符合约定。
- [ ] 推送 `origin/main`。
- [ ] 记录提交号、产物、验证结果和未验证范围。

## 发布后

- [ ] 在真实工作区使用一个完整观察周期。
- [ ] 收集阻断主流程、数据正确性和安全相关反馈。
- [ ] 修复项进入补丁版本并重新执行受影响检查。
- [ ] 1.0 发布门槛满足后再更新主版本。

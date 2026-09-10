# 项目规则 — doris-sqltools-lite

## 项目定位
- 独立的 VS Code 扩展，支持 MySQL 与 Apache Doris。
- 项目根：`D:/workspace/Projects/doris-sqltools-lite`

## 安全模型
- 连接元数据可存于 VS Code settings。
- 密码只通过 VS Code SecretStorage 存储。
- 禁止将密码写入源码、设置样例、日志或测试夹具。

## 协作流程
- 功能/修复改动时，按需要在 `package.json` 递增扩展版本；改动后须跑：TypeScript 直接编译 + 本地 Node.js 测试 + VSIX 打包，再交付。
- **版本语义**（2026-09-10 修订，与用户确认过）：
  - **一批交付只升一次版本号**。同一批改动内的多个提交共用一个版本，禁止逐个跳（历史反例：08-18 一天从 0.1.0 连跳到 0.1.9；08-28 一天连跳 0.2.2 → 0.2.3 → 0.2.4 → 0.3.0）。
  - 新功能 / 用户可见的行为变化 → 升第二位（minor，如 0.6.0 → 0.7.0）。
  - 纯修复（无新能力）→ 升第三位（patch，如 0.6.0 → 0.6.1），同一批只升一次。
  - 重构、测试、打包脚本、文档、记忆等**内部改动不升版本号**，同一版本内可多次提交。
  - 无 git tag 惯例，版本体现在 `package.json` + vsix 文件名。
- 用户授权验证后自动逻辑 Git 提交并推送 `origin/main`；完成的请求改动不遗留未提交。
- 除非用户显式要求，不修改 `D:/work/program/etl-welove-sparksql`。
- 未经显式确认，不连接真实生产数据库。

## 工程约定
- 新增 `src/` 模块若含纯逻辑，务必**不 import vscode**，否则 `node --test` 无法直接 require（tests/ 引的是 `out/*.js`）。
- 改动后除编译/测试/lint 外，跑 `node scripts/check-webview.js`（已挂在 `npm test` 链里）：校验 Webview 内联 `<script>` 能解析、nonce 与 CSP 声明一致、脚本引用的 id 与 `[attr="value"]` 选择器在 HTML 里确有声明。

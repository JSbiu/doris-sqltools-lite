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
- **版本语义**：功能缺口修复按 patch（0.2.2→0.2.3），新功能按 minor。无 git tag 惯例，版本体现在 `package.json` + vsix 文件名。
- 用户授权验证后自动逻辑 Git 提交并推送 `origin/main`；完成的请求改动不遗留未提交。
- 除非用户显式要求，不修改 `D:/work/program/etl-welove-sparksql`。
- 未经显式确认，不连接真实生产数据库。

## 工程约定
- 新增 `src/` 模块若含纯逻辑，务必**不 import vscode**，否则 `node --test` 无法直接 require（tests/ 引的是 `out/*.js`）。
- 改动后除编译/测试/lint 外，对 Webview 内联脚本做一次语法与 id 引用冒烟检查（提取 `<script>` 内容用 `vm.Script` 校验）。

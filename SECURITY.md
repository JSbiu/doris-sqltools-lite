# 安全策略

Doris SQLTools Lite 的完整安全模型见 [docs/security.md](docs/security.md)。

## 支持范围

当前维护线为最新的 `0.9.x` 与 `1.x`。安全问题优先修复最新发布版本，并在需要时提供升级说明。

## 私下报告

通过 GitHub Security Advisory 私下报告：

<https://github.com/JSbiu/doris-sqltools-lite/security/advisories/new>

请在报告中提供：

- 受影响版本。
- 操作系统与 VS Code 版本。
- 复现条件和最小步骤。
- 实际影响。
- 已脱敏的日志或材料。

请使用测试凭据和合成数据。公开 issue 中不要包含真实密码、连接串、字段密钥或业务结果。

## 响应流程

1. 确认报告范围与影响版本。
2. 在本地复现并确定最小修复。
3. 为可自动化的缺陷增加回归测试。
4. 更新安全说明、反馈 schema 或迁移文档。
5. 打包、安装并验证修复版本。

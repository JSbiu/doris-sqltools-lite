# 贡献与维护

## 开始

1. 阅读 [产品定位](docs/product.md)、[架构](docs/architecture.md) 和 [开发与验证](docs/development.md)。
2. 从可独立验收的结果组织改动。
3. 复用现有 TypeScript、Node test、esbuild、vsce 和 pnpm 入口。

## 本地检查

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm run test:vscode
pnpm run package
```

文档改动至少运行：

```powershell
pnpm run check:docs
```

Webview 改动同时运行：

```powershell
pnpm run preview:webviews
```

## 设计约束

- 纯逻辑模块保持不导入 `vscode`，便于 Node 单元测试直接加载。
- 命令 ID、配置键、字段密文 token 和反馈 schema v1 是兼容契约。
- 数据库驱动共享会话、取消、结果和错误语义。
- 文件、密钥和反馈产物使用显式完成点，不覆盖已有目标。
- Webview 使用共享主题和可访问状态区。
- 使用字段密文/字段原文、普通输出和中文任务文案。

## 提交

- 一个提交表达一件完整、可解释的事。
- 提交标题使用 `type(scope): 中文结果描述`。
- 保留无关工作区改动。
- 推送前核对远端状态。
- 发布相关改动同步版本、CHANGELOG、README 和 skill。

## 文档

稳定共享知识放在 README、`docs/` 和 `CHANGELOG.md`。本机路径、个人偏好和临时材料留在 `.local/`，不进入 Git。

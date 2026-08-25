# 贡献指南

## 技术栈

大微阁基于 Electron 43、React 和 TypeScript 构建，Agent 能力使用 pi runtime 0.84.2。TypeScript 开启严格模式，渲染进程通过受控 IPC 与主进程通信。

## 目录结构

- `src/main/`：Electron 主进程、Agent runtime、持久化与系统能力。
- `src/renderer/`：React 界面、状态管理与样式。
- `src/shared/`：IPC 契约和主进程、渲染进程共用的类型。
- `tests/`：自动化测试。
- `build/`：打包所需资源。

## 开发命令

```bash
npm run typecheck
npm run lint
npm run test
npm run dist:win
```

## 开发约定

- 界面文案以中文为主，表达清楚、自然。
- UI 调整沿用现有水墨风 design token，不另建相近色值或重复样式体系。
- 新增依赖时，在 PR 中说明用途、必要性和许可证。
- 主进程与渲染进程之间的新能力应通过类型明确的 IPC 契约提供。
- 不要提交 API Key、用户数据库、构建产物或本地配置。

## PR 自检清单

- [ ] `npm run typecheck` 通过。
- [ ] `npm run lint` 通过。
- [ ] `npm run test` 通过。
- [ ] UI 变化附有截图，并说明可见行为的变化。
- [ ] 新增依赖已说明理由和许可证。

# 第三方依赖与素材声明

大微阁使用了以下开源软件与设计素材,在此声明归属与感谢。

## 运行时依赖

| 项目 | 许可证 | 用途 |
|---|---|---|
| [Electron](https://www.electronjs.org) | MIT | 桌面应用框架 |
| [React](https://react.dev) / react-dom | MIT | 界面 |
| [pi](https://github.com/earendil-works/pi)(@earendil-works/pi-agent-core、pi-ai、pi-session-backend-sqlite-node) | MIT | Agent 运行时与模型接入 |
| [typebox](https://github.com/sinclairzx81/typebox) | MIT | 运行时数据校验 |
| [mammoth](https://github.com/mwilliamson/mammoth.js) | BSD-2-Clause | 读取 Word 文档 |
| [docx](https://github.com/dolanmiu/docx) | MIT | 生成 Word 文档 |
| [PptxGenJS](https://github.com/gitbrent/PptxGenJS) | MIT | 生成 PowerPoint 演示文稿 |
| [jszip](https://github.com/Stuk/jszip)(PptxGenJS 运行时依赖) | MIT OR GPL-3.0(以 MIT 条款使用) | 生成 pptx 的 zip 容器 |
| [SheetJS Community Edition](https://sheetjs.com) | Apache-2.0 | 读写 Excel/CSV(从官方渠道 cdn.sheetjs.com 安装) |

Apache-2.0 声明:本软件使用了 SheetJS Community Edition。版权所有 © SheetJS LLC。Apache License 2.0 全文见 <https://www.apache.org/licenses/LICENSE-2.0>。

## 设计参考声明

- 记忆系统架构(三层文件布局/显式记忆工具/摘要注入/渐进披露的设计思路)参考了 [OpenAI Codex](https://github.com/openai/codex)(Apache-2.0)的记忆系统设计。本项目的中文记忆整理提示词为本项目独立编写,未逐字复制其原文。
- 文件编辑的多级容错匹配策略参考了 Codex 的设计思路(本项目为独立实现)。

## 界面素材

| 素材 | 来源 | 许可证 |
|---|---|---|
| 宣纸纹理 `rice-paper-warm.webp` | [shuimo-ui](https://github.com/higuaifan/shuimo-ui)(higuaifan) | MIT |
| 山层 `l-base.webp`、`r-base.webp` | [shuimo-ui](https://github.com/higuaifan/shuimo-ui)(higuaifan) | MIT |

MIT 许可证副本随素材保存于 `src/renderer/assets/THIRD_PARTY_LICENSES/SHUIMO_UI_MIT.txt`。

## 开发依赖(部分)

vite、vitest、TypeScript、ESLint、Playwright、@vitejs/plugin-react 等均为 MIT 许可,详见各自仓库与随包 LICENSE 文件。

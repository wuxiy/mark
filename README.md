# Mark

> 面向持续更新的开源知识源，提供安静的个人阅读、标注与回访空间。

Mark 把公开 GitHub 文档仓库汇入单用户书架，在电脑 Web 浏览器中阅读 Markdown、保存个人标注，并跟随上游变化。应用使用 React + Fastify + SQLite，原文保存在只读 Git 镜像中，笔记不会写回仓库。

![Reader 设计基准](prototypes/reader-v0.1.png)

**当前状态：V0.1 开发中。** 已有可运行的 Web 页面和 API；本地构建、自动化测试及两个公开仓库的浏览器导入、阅读和跨来源英文搜索已验证。Docker 容器、目标 NAS、多来源长期同步及外部模型的实际连接尚待验收。图片是已确认的设计基准，细节以运行界面和后续验收为准。

## 已实现的主流程

- 添加公开 GitHub 仓库，按目录阅读 Markdown、相对图片和链接；可手动或定时同步，在 Settings 调整频率，并暂停、恢复、重命名或移除单个来源。
- 保存阅读进度、完成状态、书签、划线与笔记；在 My Marks 回访，变化后无法确认的标注进入待复核。
- 在 Updates 查看新增、修改、删除及双版本对照；跨来源搜索当前已发布文档。
- 可选 Ask：配置兼容模型后，基于文档片段回答并提供可打开的引用；未配置时阅读和搜索照常使用。

## 本地运行

需要 Node.js `>=24.12.0` 和 Git。先创建 `secrets/initial-password`，写入一行至少 12 个字符的初始密码；首次运行会将密码哈希保存到数据目录。

```bash
npm ci
npm run build
MARK_DATA_DIR=.data MARK_INITIAL_PASSWORD_FILE=secrets/initial-password npm start
```

打开 `http://127.0.0.1:3100`。开发时可分别运行 `npm run dev:api` 和 `npm run dev:web`，Vite 会把 `/api` 代理到本地 API 服务。

| 命令 | 用途 |
| --- | --- |
| `npm run check` | 前后端 TypeScript 检查 |
| `npm test` | 来源、同步、阅读记录、标注、搜索、差异及问答降级测试 |
| `npm run build` | 构建页面和 API |
| `npm start` | 启动已构建的同源服务 |

## 部署与文档

[部署与备份恢复](DEPLOYMENT.md)提供 Docker Compose、模型配置和停机备份步骤。Compose 配置已做语法检查；目标 NAS 的容器启动、备份恢复及多来源验收尚未完成。

| 文档 | 内容 |
| --- | --- |
| [产品文档](PRODUCT.md) | 定位、用户场景、V0.1 范围与验收标准 |
| [技术文档](TECHNICAL.md) | 架构、数据模型、同步与标注方案 |
| [设计文档](DESIGN.md) | 信息架构、阅读器交互、视觉规范与宽屏浏览器布局 |
| [Web 产品原型](PROTOTYPE.md) | 页面图、流程与状态设计 |
| [实施与验收清单](IMPLEMENTATION_PLAN.md) | 分阶段工作与可验证的验收项 |

本轮只设计和实现电脑 Web 浏览器视图；手机浏览器布局不在当前范围。

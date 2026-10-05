# Mark 部署与恢复

Mark 是单用户 Web 应用。浏览器访问同一服务提供的页面和 API；持久化目录同时保存 SQLite 数据库和 Git 镜像。当前服务器使用原生 Node + systemd；Docker Compose 是可选部署方式，完整备份恢复演练仍需独立验收。

## 原生 Node + systemd 启动

以下路径、运行用户和端口均为部署示例，按目标环境填写；实际服务器信息不纳入 Git。

| 项目 | 路径或值 |
| --- | --- |
| 项目 | `/srv/mark` |
| Node | Node.js ≥ 24.12.0，使用目标环境的可执行文件路径 |
| 服务 | `mark.service`，以专用普通用户运行 |
| 配置 | 项目根目录 `.env`，systemd `EnvironmentFile` 读取，权限 `600` |
| 数据 | 项目 `data/`，保留原 SQLite 与 Git 镜像 |
| 监听 | `127.0.0.1:3100`；跨主机代理时按需调整，页面和 API 同源 |
| HTTPS 入口 | 部署时设置的浏览器域名，例如 `https://mark.example.com` |

更新时先保存原构建目录、依赖配置和 `.env`，检查远程源码是否已有修改；执行 `npm ci`、`npm run build` 后仅重启 Mark：

```bash
sudo systemctl restart mark
systemctl is-active mark
curl --fail http://127.0.0.1:3100/api/health
```

authentik 的独立客户端、Owner 绑定、密钥文件、可信内部 HTTPS 通道与回退步骤见 [统一认证文档](docs/AUTHENTIK.md)。保留原初始密码文件，禁止用新密码文件覆盖已有 Owner 凭据。

2026-10-06 已完成统一认证发布与外部 HTTPS 浏览器验证：Work-OS 登录一次后可进入 Mark，原密码可回退；Mark 退出不影响其他应用。发布前后原业务行内容与密码哈希一致。原文件备份与原始验证证据仅保留在私有运行环境；公开验收摘要见统一认证文档。

备份原生运行的服务时，使用 `sudo systemctl stop mark` 停止写入，再快照完整 `data/` 目录；完成后 `sudo systemctl start mark`。不要只复制数据库或在 OIDC 发布时回滚业务数据。

## Docker Compose 启动

1. 复制 `.env.example` 为 `.env`。默认使用 `3100` 端口、`./data` 数据目录、每 60 分钟检查一次来源。`MARK_SYNC_INTERVAL_MINUTES` 仅设置首次启动的默认频率，之后可在 Web Settings 中调整；设为 `0` 可关闭定时检查，手动同步仍可用。
2. 创建 `secrets/initial-password`，写入一行至少 12 个字符的初始密码。首次启动会把密码哈希写入数据库；后续启动继续使用数据库中的密码。该文件和 `.env` 均已加入 `.gitignore`。
3. 创建数据目录，并确保容器内 UID 1000 可以写入。NAS 上使用绑定目录时，应检查该目录的所有者和权限。
4. 执行：

```bash
docker compose build
docker compose up -d
docker compose ps
```

打开 `http://NAS地址:3100`，登录后从 Library 添加公开 GitHub 仓库。若前面有 HTTPS 反向代理，请在 `.env` 设置 `MARK_SECURE_COOKIE=1`。

## 可选 Ask

Ask 使用兼容 Chat Completions 的模型服务。只有同时设置 `MARK_MODEL_BASE_URL` 和 `MARK_MODEL_NAME` 才会启用；服务要求密钥时再设置 `MARK_MODEL_API_KEY`。例如 base URL 以 `/v1` 结尾，Mark 会调用其 `/chat/completions` 路径。未配置或请求失败不影响阅读、标注和关键词搜索。Ask 会把检索到的文档片段发送给配置的服务，页面在提问前提示这一点。

## 备份与恢复

使用停止服务后的目录快照，同时备份 `mark.db`、SQLite WAL 文件（如存在）和 `repos/`。只复制数据库不足以保证历史版本可读。

```bash
docker compose down
mkdir -p backups
tar -C data -czf backups/mark-backup.tar.gz .
```

在新的空目录恢复，并让 Compose 指向恢复目录：

```bash
mkdir -p restored-data
tar -C restored-data -xzf backups/mark-backup.tar.gz
MARK_DATA_HOST_DIR=./restored-data docker compose up -d
```

恢复目录同样需要允许容器 UID 1000 写入。登录后检查已添加来源、历史更新、书签、阅读位置与笔记。若恢复版本需继续长期使用，把 `MARK_DATA_HOST_DIR=./restored-data` 写入 `.env`。

## 检查

```bash
docker compose ps
docker compose logs --tail=100 mark
```

`/api/health` 返回 `{"ok":true}` 只说明服务可访问；它不能代替导入、历史版本或备份恢复验收。当前开发环境没有运行中的 Docker daemon，Compose 语法已检查，容器启动与 NAS 恢复尚未验证。

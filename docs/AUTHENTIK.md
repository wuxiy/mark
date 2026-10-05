# Mark 统一认证

Mark 通过 Work-OS 的 authentik 使用 OIDC Authorization Code + PKCE 登录。仍只有一个 Owner；固定的 `issuer + sub` 进入原有 Mark 会话，个人数据、初始密码和 SQLite 结构均不改变。不使用邮件地址匹配，也不创建多账号。

## 接入约定

| 项目 | 值 |
| --- | --- |
| 浏览器入口 | 部署时设置的 HTTPS 域名，例如 `https://mark.example.com` |
| 客户端 | `workos-mark`，confidential，独立密钥 |
| issuer | authentik 为 Mark 签发的 issuer，例如 `https://auth.example.com/application/o/mark/` |
| 精确回调 | `<Mark HTTPS origin>/api/auth/oidc/callback` |
| Owner | 已确认的 Work-OS Owner UUID subject；不使用管理员账户 |
| scope | `openid` |
| 本地会话 | 原 `mark_session`，HttpOnly / Secure / host-only / SameSite=Strict，30 天 |
| 登录事务 | `__Host-mark-oidc`，HttpOnly / Secure / host-only / SameSite=Lax，5 分钟且只能使用一次 |

三个匿名 GET 入口为 `/api/auth/oidc/config`、`/api/auth/oidc/start`、`/api/auth/oidc/callback`。同名前缀下的其他路径和其他请求方法仍须登录。配置接口只返回启用状态；客户端密钥、subject、授权码和令牌不返回给前端配置、不写日志。

登录会校验 state、浏览器事务、nonce、PKCE、issuer、audience、有效期和 RS256 签名。回调使用配置中的固定地址，不从请求 Host 拼接。成功后只签发 Mark 本地会话，令牌不落库。

实现采用 `openid-client`，显式开启 ID Token 签名检查；协议依据见 [openid-client 官方接口说明](https://github.com/panva/openid-client/blob/main/docs/functions/authorizationCodeGrant.md)、[签名校验说明](https://github.com/panva/openid-client/blob/main/docs/functions/enableNonRepudiationChecks.md)和 [authentik OAuth2/OIDC provider 文档](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/)。

## 配置

五项必填；以下域名和路径均为示例，按实际部署填写：

```dotenv
MARK_SECURE_COOKIE=1
MARK_OIDC_ISSUER=https://auth.example.com/application/o/mark/
MARK_OIDC_CLIENT_ID=workos-mark
MARK_OIDC_CLIENT_SECRET_FILE=/srv/mark/secrets/oidc-client-secret
MARK_OIDC_CALLBACK_URL=https://mark.example.com/api/auth/oidc/callback
MARK_OIDC_OWNER_SUBJECT=<Owner 的 UUID subject>
```

全部留空则沿用密码登录；部分填写或不合法配置会拒绝启动。密钥文件与 `.env` 仅服务器持有，权限 `600`。`npm start` 不自动加载 `.env`；服务器由 systemd `EnvironmentFile` 加载。

NAS 无法从自身访问外部入口时，复用 Work-OS 已有的内部 HTTPS 通道：

```dotenv
MARK_OIDC_CA_FILE=/srv/work-os/runtime/tls/ca.crt
MARK_OIDC_RESOLVE_ADDRESS=127.0.0.1
```

只改变 OIDC 请求的拨号地址，保留正式 issuer、Host、SNI 和证书校验。不会改系统 hosts、系统 CA 或其他应用请求；不关闭 TLS 校验。Discovery、token、JWKS 均限于 issuer 的 HTTPS origin，禁止跟随重定向。Discovery 缓存 10 分钟，单次网络请求超时 8 秒；启动不依赖 IdP 可用。

## 创建客户端

在现有 Work-OS 主机上运行；以下运行目录、API 地址和浏览器域名均为示例，实际值由环境变量提供：

```bash
cd /srv/mark
WORK_OS_RUNTIME_DIR=/srv/work-os/runtime \
AUTHENTIK_API_URL=http://127.0.0.1:9000 \
MARK_PUBLIC_ORIGIN=https://mark.example.com \
node scripts/configure-authentik.mjs
```

脚本复用 `WORK_OS_RUNTIME_DIR` 内的管理凭据，先备份 `clients.json`，仅新增 Mark provider、application 和已有 Owner 的用户绑定；其他客户端及 Owner 密码不轮换。issuer 域名从已有门户客户端配置获取，不在代码中固化。`AUTHENTIK_API_URL` 只接受 HTTPS 或回环 HTTP 地址，并拒绝重定向。密钥仅保存于私有注册表。重复运行会核对已有 Mark 配置；配置不符时退出，需人工核对，不能删除重建来绕过检查。不要重跑 Work-OS 的初始化脚本。

将注册表 `clients.mark.clientSecret` 写入 Mark 密钥文件，将 `ownerSubject` 写入 `.env`，均在服务器内操作。不要把注册表、密码或完整环境配置复制到 Git。最后构建并只重启 `mark.service`。

## 流程与异常

1. 登录页读取 `/api/session`，显示加载占位；启用 OIDC 时以“统一身份登录”为主入口。
2. 点击后显示“正在前往身份中心…”，禁止重复操作，跳转 authentik。浏览器返回页面时解除等待状态。
3. Work-OS 已登录时复用 authentik 会话；首次登录输入 Owner 凭据。验证成功进入 `/library`。
4. 身份不匹配、过期、重放或缺少浏览器事务返回 `403`，不签发会话；安全提示页可返回 Mark 重新发起登录。
5. IdP 网络或服务失败返回 `503`，提供返回 Mark 的入口，密码登录、已有会话与阅读不依赖 IdP。
6. “使用 Mark 密码登录”展开原密码表单，保留原限速、错误提示和提交状态。
7. Settings 退出只删除当前 Mark 会话；其他应用和 authentik 会话继续有效，再次统一登录可复用 IdP 会话。需要结束统一身份会话时，应在身份中心退出。

登录事务保存在进程内，重启后尚未完成的登录必须重新发起。停止或解绑 IdP 用户不会即时撤销已签发的 Mark 会话；它们沿用原 30 天有效期或本地退出机制。本次未引入全局退出、会话撤销同步、多用户或数据迁移。

## 验证

`npm test` 的 OIDC 用例使用独立 RSA 密钥和模拟协议响应，覆盖合法 Owner 登录、签名/issuer/audience/nonce/有效期/subject 拒绝、state、浏览器绑定、事务重放与过期、IdP 故障、密码回退、CSRF、本地退出及数据保留。真实 Authentik 与外部 HTTPS 的浏览器验证结果见部署记录。

### 2026-10-06 部署验证

代码、独立客户端与运行配置已发布，`mark.service` 为 active，使用原生 Node 24.12.0。Work-OS 导航新增 Mark；已有 OIDC 客户端配置经逐项比较一致。实际域名、账户、服务器路径和原始证据保留在私有运行环境，不纳入公开文档。

| 验收项 | 结果与证据 |
| --- | --- |
| 类型、构建、自动化测试 | `npm run check`、`npm run build`、`npm test` 通过；26 项通过、0 跳过 |
| 门户 → Mark | 在 Work-OS 首次输入一次 Owner 密码；点击门户 Mark 链接打开新标签页，统一登录进入 `/library`，私有来源 API `200` |
| 本地退出 | Mark 退出后来源 API `401`，Work-OS 页面和 Everglow 私有 API 仍可访问，再次统一登录无需输入密码 |
| 原密码回退 | 展开密码表单，原 Mark 密码可登录，来源 API `200` |
| Cookie 与 CSRF | Mark Cookie 为 Secure、HttpOnly、host-only；事务 Cookie 回调后清除；缺 CSRF 的退出请求 `403` |
| 真实回调异常 | 已完成回调重放、去除浏览器事务后返回 `403`，不产生 Mark 会话 |
| 外部 HTTPS | Mark、Work-OS、authentik、Everglow 使用正常校验的 ZeroSSL TLS 1.3；后端保留正式 issuer/SNI，使用 Work-OS 内部 CA 通道 |
| 页面验证 | Chromium / Playwright，1440×960 和 1280×900；标题与内容正确，无空白页、框架错误页、运行时错误或水平溢出 |
| 原数据 | 发布前后来源、文档、标注、书签、阅读记录的行内容哈希一致；原密码哈希一致 |
| 密钥与配置 | `.env`、客户端密钥文件、私有客户端注册表均 `600`；未进入 Git |

浏览器测试使用现有服务器 Chromium，通过客户端 DNS 的临时回环字节转发访问真实外部 HTTPS，未绕过证书校验。测试方式为 Playwright，原因：本会话未安装 Browser 插件。Work-OS 既有 `/favicon.ico` 出现一次 `404`，单独记录；Mark 页面没有相关控制台错误。本次仅验证电脑浏览器范围。

私有运行环境保留 `browser-result.json`、`runtime-result.json` 与登录/书架/密码回退截图，以及发布前的原文件备份；不纳入 Git。这些验证仅证明本次统一认证接入，不代替项目原完整验收清单。配置脚本的环境参数整理属于提交前的脱敏修改，不代表该脚本在本轮重新操作了远程 IdP。

## 回退

保留 `MARK_INITIAL_PASSWORD_FILE` 和原数据库。停用全部 `MARK_OIDC_*` 配置后重启 Mark 即回到密码登录；HTTPS 下继续保留 `MARK_SECURE_COOKIE=1`。如需代码回退，恢复发布前的 `dist/`、`dist-server/`、依赖锁文件和运行配置。无需恢复业务数据库，不删除其他应用的 provider 或会话。

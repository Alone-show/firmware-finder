# firmware-finder

DeepSeek Harness 插件：按**机型 + 操作系统**，从 Teambition「【研发部】CI/CD 发版流程」看板的归档字段里定位量产固件，返回固件版本、构建日期、客户、以及 OSS 线刷/OTA 直链。

装上之后直接对话即可：「找 spring2pro 的安卓固件」。

## 安装

```bash
git clone git@github.com:Alone-show/firmware-finder.git
```

然后在 Harness 里用绝对路径安装（`plugin_manager` 的 `install_bundle`）：

```
install_bundle target=/absolute/path/to/firmware-finder
```

或者命令行：

```bash
dsh plugin install /absolute/path/to/firmware-finder
```

装完 `include:firmware-finder` 处于 enabled/active 即可用。

## 首次使用需要两份数据

插件只读本地索引，不做登录。两份文件都在数据目录（默认 `$DSH_TBFW_DIR`，否则 `~/.tbfw`：

| 文件 | 来源 |
|---|---|
| `token.json` | `tools/login.sh`（弹浏览器登录后抓 cookie） |
| `board-<projectId>.json` | `firmware_sync` 工具，或 `tools/sync` 触发 |

```bash
# 1) 登录取 token（会打开浏览器，登录完自动关窗）
./tools/login.sh

# 2) 在 Harness 里调用 firmware_sync 生成索引（约 40 秒，8600 条）
```

## 三个工具

| 工具 | 作用 |
|---|---|
| `firmware_find` | 机型 + 系统 → 固件；机型歧义时返回候选并要求确认 |
| `firmware_models` | 列出所有机型族及其同族写法 |
| `firmware_sync` | 从 Teambition 重拉看板索引；凭据缺失或过期时自动登录 |
| `firmware_login` | 获取/刷新登录凭据：静默刷新 → 弹窗登录 → 手动粘贴 |

未指定客户时**默认按 CP** 过滤，并在 `note` / `otherCustomers` 里列出其他客户；传 `customer: "*"` 表示不限。

## 自动登录

`firmware_sync` 在凭据缺失、即将过期（<5 分钟）或被服务端拒绝（401）时自动处理：

- **凭据有效** → 直接使用，不开浏览器（`auth: cached`，0ms）。
- **凭据无效** → 弹出浏览器窗口停在登录页，登录完成后自动写回并继续原操作（`auth: window`）。
- **无法自动** → 返回 `manual` / `no_display`，并给出具体做法。

> 关于「静默刷新」：曾尝试用持久化 profile 以 headless 模式打开页面，靠仍有效的 `TEAMBITION_SESSIONID` 换发新 token。实测**不可行**——Teambition 不会仅凭 session cookie 换发 `TB_ACCESS_TOKEN`，登录页也不会自动跳转。因此 `auto` 直接弹窗；`mode: "headless"` 仅保留作诊断入口。
>
> `TB_ACCESS_TOKEN` 的 cookie 是会话级的（关窗即失效），真正决定有效期的是 JWT 里的 `exp`（约 3 天）。目前每次过期需要重新扫码一次。

### 浏览器支持

自动抓取依赖 CDP 读取 HttpOnly 的 `TB_ACCESS_TOKEN`，因此**只有 Chromium 系可用**：Chrome、Edge、Chromium、Brave、Vivaldi、Opera。

Firefox / Safari 的远程调试协议不是 CDP，无法自动读取。这种情况下插件不会去驱动它，而是打开登录页并提示你手动复制：

> F12 → Network → 任意请求右键「Copy as cURL」→ 把整段粘给 `firmware_login(cookie="...")`

也接受完整 cookie 串或单个 `TB_ACCESS_TOKEN`（后者通常会因缺少 `TEAMBITION_SESSIONID` 被服务端拒绝）。

### 浏览器发现顺序

1. 工具参数 `browser` / 环境变量 `TBFW_BROWSER`
2. 系统默认浏览器（`xdg-settings` → `.desktop` → 解析 `Exec=`，支持 flatpak/snap 前缀）
3. PATH、`/snap/bin`、`/var/lib/flatpak/exports/bin`、`~/.local/bin` 扫描（含 `-stable`/`-beta` 变体）
4. 对候选执行 `--version` 判定是否为 Chromium 系

### 相关环境变量

| 变量 | 作用 |
|---|---|
| `TBFW_AUTO_LOGIN=0` | 关闭自动登录，只返回 `needs_auth` |
| `TBFW_HEADLESS=1` | 只尝试静默刷新，不弹窗 |
| `TBFW_BROWSER` | 指定浏览器路径或命令名 |
| `TBFW_LOGIN_TIMEOUT` | 等待登录秒数（默认 180） |
| `TBFW_NO_DISPLAY=1` | 测试钩子：强制走无图形环境分支 |

## 关键实现说明

- **零依赖**：本地安装是软链到仓库目录，Node 会按 realpath 解析，所以模块内不能 `import '@deepseek-ai/*'`。工具定义直接手写 JSON Schema 交给 `ctx.tools.register`。
- **显示环境**：宿主进程常常没有 `DISPLAY`/`WAYLAND_DISPLAY`（例如由服务启动），插件会显式补上同用户的 Wayland 套接字后再启动浏览器。
- **数据目录**按顺序解析：`DSH_TBFW_DIR` / `DSH_FIRMWARE_DIR` → 会话工作目录（`workingDirectory.ensure(agent)`）→ 部署默认目录 → 进程 cwd，取第一个含 `board-*.json` 的。
- **机型对齐**在插件里做：字母骨架 + 数字数量比较（`spring2pro` → `SPRING2-10PRO`），只有唯一强匹配才自动确定，否则返回 `needs_confirmation`。
- **排序**：`生产库归档` > 发布 > 其他（`自归档` 不算归档，`下架` 排最末），同档按版本号里的构建日期倒序。
- **构建日期**优先取 `固件版本` 字段，缺了就从标题或下载地址里捞（在制版本常常只有链接）。
- **在制版本提示**：比已归档最新还新的测试/压测版本会单独列在 `pending`。

## 改动后必须重载

运行中的进程不会自动加载新代码。改完 `index.js` 后：

```
plugin_manager set_plugin include:firmware-finder enabled=false
plugin_manager set_plugin include:firmware-finder enabled=true
```

否则要重启 Harness。

## 已知限制

- `next.cpinnov.run` / `alist.cpinnov.run` 是内网分享页（`10.16.18.x`），外网不可达；实体文件在 `minio.cpuniverse.cn` / `mdmobs.cpuniverse.cn`。`--verify` 只校验后者。
- 登录 cookie 约 24 小时过期，过期后重跑 `tools/login.sh`。

## 许可

内部工具，未附许可协议；图标为本仓库自绘 SVG。

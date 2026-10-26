# firmware-finder

DeepSeek Harness 插件：敲 `/cpfirmware`，按**机型 + 操作系统**从 Teambition「【研发部】CI/CD 发版流程」看板的归档字段里定位量产固件，直接给出固件版本、构建日期、客户，以及 OSS 线刷 / OTA 直链。

```text
/cpfirmware 帮我找 spring2pro 最新的固件
/cpfirmware spring2pro android
/cpfirmware spring2 最近3个 -c SZ --verify
```

这是一条**宿主侧斜杠命令**：查询在本地索引上完成，不产生模型消息、不花 token，也不需要模型「想起来该用哪个工具」。

## 安装

Web UI → Plugins → Add plugin → Install a third-party plugin，填：

```
https://github.com/Alone-show/firmware-finder
```

或命令行（插件市场索引：`https://raw.githubusercontent.com/Alone-show/firmware-finder/main/index.json`，Discover 需要先开实验性的 Custom plugin markets）。

装完 `include:firmware-finder` 处于 enabled/active；在输入框敲 `/` 就能看到 `cpfirmware`。

## 用法

```text
/cpfirmware <机型> [系统] [参数]          查固件
/cpfirmware sync                          重拉看板索引（约 40 秒）
/cpfirmware status                        索引 / 凭据状态
/cpfirmware models                        所有机型族与同族写法
/cpfirmware login [window|auto|headless]  刷新登录凭据
/cpfirmware login <cookie 或 Copy as cURL> 手动粘凭据
/cpfirmware help                          用法
```

机型支持自由写法：`spring2pro`、`SP2-10PRO`、`apollo 12 pro`、`瑞芯微 / APOLLO 12 PRO`、`T3 / SPRING2`。自然语言填充词（「帮我找」「最新的」「固件」「安卓」）会自动剥掉。

| 参数 | 说明 |
|---|---|
| `-c, --customer <CP\|SZ\|QX\|VR\|*>` | 客户；**缺省按 CP**，`所有客户` / `*` 不限 |
| `-s, --system <android\|debian\|buildroot\|linux>` | 操作系统；`linux` 指 Debian + BuildRoot |
| `--version <V1.08>` | 版本号片段 |
| `--mainline <Android-11>` | 关联代码主线片段 |
| `--stage <生产库归档>` | 阶段过滤 |
| `-n, --limit <1-20>` | 显示条数，默认 3；说「最新」时为 1 |
| `--verify` | HEAD 校验下载链接并显示体积（跳过内网 next/alist） |

输出是命令卡片里的纯文本（`pre`），**链接不可点击、需要选中复制**——这是命令平面的渲染限制，换来的是确定性、0 token、不经过模型。

结果里会带上：

- 「其他客户还有：QX(16)、YK(10)…」——默认 CP 之外的客户不会被悄悄吞掉；
- 「存在比已归档版本更新的在制/测试版本」——避免把测试版本当成最新量产版本；
- 索引新鲜度（超过 3 天会提示 `sync`）。

## 首次使用需要两份数据

| 文件 | 来源 |
|---|---|
| `token.json` | `/cpfirmware login`，或 `tools/login.sh`（弹浏览器登录后抓 cookie） |
| `board-<projectId>.json` | `/cpfirmware sync`；凭据缺失或过期时会自动拉起登录 |

数据目录按顺序解析：`DSH_TBFW_DIR` / `DSH_FIRMWARE_DIR` → 会话工作目录下的 `.tbfw` → 部署默认目录 → 进程 cwd。

```bash
# 最小路径：一条命令搞定登录 + 索引（会弹浏览器窗口，登录完自动继续）
/cpfirmware sync
```

## 自动登录

`/cpfirmware sync` 在凭据缺失、即将过期（<5 分钟）或被服务端拒绝（401）时自动处理：

- **凭据有效** → 直接使用，不开浏览器（`auth: cached`，0ms）。
- **凭据无效** → 弹出浏览器窗口停在登录页，登录完成后自动写回并继续原操作（`auth: window`）。
- **无法自动** → 返回 `manual` / `no_display` / `no_browser`，并给出具体做法。

> 关于「静默刷新」：曾尝试用持久化 profile 以 headless 模式打开页面，靠仍有效的 `TEAMBITION_SESSIONID` 换发新 token。实测**不可行**——Teambition 不会仅凭 session cookie 换发 `TB_ACCESS_TOKEN`，登录页也不会自动跳转。因此 `auto` 直接弹窗；`mode: headless` 仅保留作诊断入口。
>
> `TB_ACCESS_TOKEN` 的 cookie 是会话级的（关窗即失效），真正决定有效期的是 JWT 里的 `exp`（约 3 天）。目前每次过期需要重新扫码一次。

### 浏览器支持

自动抓取依赖 CDP 读取 HttpOnly 的 `TB_ACCESS_TOKEN`，因此**只有 Chromium 系可用**：Chrome、Edge、Chromium、Brave、Vivaldi、Opera。

Firefox / Safari 的远程调试协议不是 CDP，无法自动读取。这种情况下插件不会去驱动它，而是打开登录页并提示你手动复制：

> F12 → Network → 任意请求右键「Copy as cURL」→ 把整段粘给 `/cpfirmware login <curl ...>`

**注意**：`/cpfirmware` 命令设置了 `recordInput: false`，原始输入不会写进会话日志的 `command/run`，所以粘 cookie 不会把凭据留痕；结果文本里也不会回显 cookie。

### 浏览器发现顺序

1. 工具参数 `browser` / 环境变量 `TBFW_BROWSER`
2. 系统默认浏览器（`xdg-settings` → `.desktop` → 解析 `Exec=`，支持 flatpak/snap 前缀）
3. PATH、`/snap/bin`、`/var/lib/flatpak/exports/bin`、`~/.local/bin` 扫描（含 `-stable`/`-beta` 变体）
4. 对候选执行 `--version` 判定是否为 Chromium 系

### 相关环境变量

| 变量 | 作用 |
|---|---|
| `DSH_TBFW_DIR` | 指定数据目录（含 `token.json` / `board-*.json`） |
| `TBFW_AUTO_LOGIN=0` | 关闭自动登录，只返回需要登录 |
| `TBFW_HEADLESS=1` | 只尝试静默刷新，不弹窗 |
| `TBFW_BROWSER` | 指定浏览器路径或命令名 |
| `TBFW_LOGIN_TIMEOUT` | 等待登录秒数（默认 180） |
| `TBFW_NO_DISPLAY=1` | 测试钩子：强制走无图形环境分支 |

## 可选：把工具还给模型

0.2.2 起默认**只注册 `/cpfirmware` 命令**，不再向模型暴露 `firmware_*` 工具（模型不会自动触发固件查询）。如果某台设备上还希望模型能在自然语言对话里自己查，在 profile 的 `cordis.patch.yml` 里加一行：

```yaml
- id: firmware-finder
  name: "@local/firmware-finder"
  config:
    modelTools: true
```

然后重载或重启。四个工具（`firmware_find` / `firmware_models` / `firmware_sync` / `firmware_login`）与命令共用同一套实现。

## 关键实现说明

- **零依赖**：本地安装是软链到仓库目录，Node 会按 realpath 解析，所以模块内不能 `import '@deepseek-ai/*'`。命令用 `ctx.inject(['commands'], …)` 软注入注册，工具用 `ctx.tools.register`，都是手写普通对象。
- **命令平面**：`/cpfirmware` 由 `@deepseek-ai/dsh-commands` 调度，handler 直接拿到 `{agent, rawInput, signal}`；结果写进 `command/run` / `command/done` 日志事件，不进模型请求。
- **中文自然语言**：匹配器先把查询按 `[a-z0-9]` 归一化（中文填充词自然消失），所以「帮我找spring2pro最新的固件」和「spring2pro」走同一条路径；系统词/`OTA`/`latest` 这类 latin 噪声会先被剥掉，否则会粘到机型上（`spring2 android` → `spring2android`）导致匹配失败。
- **机型对齐**：字母骨架 + 数字数量比较（`spring2pro` → `SPRING2-10PRO`），只有唯一强匹配才自动确定；`spring2` 不会串到 `SPRING2-10PRO`。无法确定时命令返回候选列表并保留输入框草稿。
- **显示环境**：宿主进程常常没有 `DISPLAY`/`WAYLAND_DISPLAY`（例如由服务启动），插件会显式补上同用户的 Wayland 套接字后再启动浏览器。
- **排序**：`生产库归档` > 发布 > 其他（`自归档` 不算归档，`下架` 排最末），同档按版本号里的构建日期倒序。
- **构建日期**优先取 `固件版本` 字段，缺了就从标题或下载地址里捞（在制版本常常只有链接）。
- **在制版本提示**：比已归档最新还新的测试/压测版本会单独列出。

## 排障：`/cpfirmware` 敲完回车没反应

先分清是哪一种，三种都遇到过：

### 1. 在新会话首屏（`Into the Unknown`）提交 → 页面不动、没有卡片

**命令其实执行了**，只是 Web 客户端在"新建会话首屏"提交 host 命令后不会跳转到那个新建会话（普通提问会跳转，命令不会；`/plan`、`/goal` 也一样，与本插件无关）。

验证方法：左侧会话列表里点**最新那个会话**，命令卡片就在里面；或用下面查日志：

```bash
# 换成你的 profile 目录下的会话目录
zstdcat ~/.dsh/sessions/*/<最新会话>/session.v4.jsonl.zstd | grep '"name":"cpfirmware"'
```

**做法**：在**已打开的会话**里执行；已经在首屏敲了就回左侧列表点最新会话。

### 2. 只出帮助页（`/cpfirmware —— 在 Teambition…`）

说明只收到了命令名，参数没带上。按这个顺序敲最稳：

1. 输入 `/cpfirmware`
2. **按一次空格**（输入框出现参数占位 `帮我找 spring2pro 最新的固件`，命令变成命令块）
3. 写参数（或整行粘贴）
4. 回车

实在不行就整行粘贴 `/cpfirmware 帮我找 spring2pro 最新的固件` 后回车——实测一次即可。

### 3. `/` 菜单里搜不到 `cpfirmware`

命令目录是缓存的长驻页面可能落后（插件装了/换了之后没有收到失效事件）。**刷新页面**（F5）即可；新开的会话一定是最新的。

## 改动后必须重载

运行中的进程不会自动加载新代码。改完 `index.js` / `command.js` 后：

```
plugin_manager set_plugin include:firmware-finder enabled=false
plugin_manager set_plugin include:firmware-finder enabled=true
```

否则要重启 Harness。客户端 `/` 菜单在插件变更事件后会自动刷新，但页面可能需要重连。

## 已知限制

- `next.cpinnov.run` / `alist.cpinnov.run` 是内网分享页（`10.16.18.x`），外网不可达；实体文件在 `minio.cpuniverse.cn` / `mdmobs.cpuniverse.cn`。`--verify` 只校验后者。
- 登录 cookie 约 24 小时过期，JWT 约 3 天；过期后跑一次 `/cpfirmware sync`（或 `/cpfirmware login`）。
- `sync` 约 40 秒、`login` 最长 180 秒，期间命令行保持 running 且没有取消按钮。
- 命令只在有命令平面的形态（Web / TUI）出现；headless、ACP 下本插件没有任何暴露面——这正是「不注册工具」的代价，需要时可开 `modelTools`。

## 许可

内部工具，未附许可协议；图标为本仓库自绘 SVG。

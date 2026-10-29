# firmware-finder

DeepSeek Harness 插件：敲 `/firmware`，按**机型 + 操作系统**，从 Teambition「【研发部】CI/CD 发版流程」看板的归档字段里定位量产固件，给出固件版本、构建日期、客户，以及 OSS 线刷 / OTA 直链（对话里的链接可直接点击）。

```text
/firmware 帮我找 spring2pro 最新的固件
/firmware spring2pro 安卓
/firmware spring2 最近3个 -c SZ --verify
/firmware models
/firmware sync
```

**只能由 `/firmware` 触发**：`firmware_*` 工具由宿主侧闸门保护，只有最新一条用户消息里出现独立的 `/firmware` 词才允许执行；其他轮次（自然语言请求、追问、子代理会话）调用会被拒绝，并提示用户带 `/firmware` 重发。

> 为什么不是宿主命令：0.2.2 曾用 `ctx.commands` 注册 `/cpfirmware`（不进模型、0 token），但 Web 客户端在「新建会话首屏」提交宿主命令不会跳转到新会话，命令执行了结果却不可见，因此整条回退。本版改为**技能式 `/firmware`**：斜杠消息原样进入正常对话轮次，宿主注入 skill 内容，结果走普通消息和工具卡片，不存在首屏失效问题；代价是每次查询消耗一轮模型调用。

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

装完 `include:firmware-finder` 处于 enabled/active 即可用；在输入框敲 `/` 能看到 `firmware`（只对用户可见，不会出现在模型的 skill 目录里）。

## 用法

```text
/firmware <机型> [系统] [参数]           查固件
/firmware models                         所有机型族与同族写法
/firmware models <机型>                  只看相关族（含变体，如 APOLLO2-MIX）
/firmware sync                           重拉看板索引（约 40 秒）
/firmware login [window|auto|headless]   刷新登录凭据
/firmware login <cookie 或 Copy as cURL> 手动粘凭据
```

机型支持自由写法：`spring2pro`、`SP2-10PRO`、`apollo 12 pro`、`瑞芯微 / APOLLO 12 PRO`、`T3 / SPRING2`，以及**归档链接里的机型目录名**（如 `APOLLO2MIX`、`SP2-10MIX`）。自然语言填充词（「帮我找」「最新的」「固件」「安卓」）会被识别。

| 参数 | 说明 |
|---|---|
| `-c, --customer <CP\|SZ\|QX\|VR\|*>` | 客户；**缺省按 CP**，`所有客户` / `*` 不限 |
| `-s, --system <android\|debian\|buildroot\|linux>` | 操作系统；`linux` 指 Debian + BuildRoot |
| `--version <V1.08>` | 版本号片段 |
| `--mainline <Android-11>` | 关联代码主线片段 |
| `--stage <生产库归档>` | 阶段过滤 |
| `-n, --limit <1-20>` | 显示条数，默认 5；说「最新」时为 1 |
| `--verify` | HEAD 校验下载链接并显示体积（跳过内网 next/alist） |
| `--all` | 包含没有固件链接的任务 |

结果里会带上：

- 「其他客户还有：QX(16)、YK(10)…」——默认 CP 之外的客户不会被悄悄吞掉；
- 「存在比已归档版本更新的在制/测试版本」——避免把测试版本当成最新量产版本；
- 命中变体时标注「变体 APOLLO2-MIX」——同一族里还有别的子型号，行内的「机型」字段未必写全；
- 索引新鲜度（超过 3 天会提示 `/firmware sync`）。

### 机型别名与变体从哪来

看板的「机型」字段是族级别的（`RK / APOLLO2`、`RK / SPRING2-10PRO`…），子型号只出现在归档链接的目录、以及版本号前缀里。所以插件在「机型」字段之外，还会读**归档链接**：

```text
https://next.cpinnov.run/PROD/RK/ANDROID/APOLLO2-MIX/CP/LCD7-12/…
                              └chip┘└─OS─┘└──机型──┘
```

规则（只保留可解释的三种归属，不新增独立族）：

| 情况 | 处理 | 例子 |
|---|---|---|
| 与已有族同名（含 `SP2↔SPRING2`、`APOLLO2↔APOLLO` 展开、省略尺寸数字） | 并入该族「同族写法」 | `SP2-10MIX` → `RK / SPRING2-10MIX`、`SP2-PRO` → `RK / SPRING2-10PRO` |
| 比族名更长、能挂到父族 | 记为「变体」 | `APOLLO2-MIX` → `RK / APOLLO2` |
| 其它 | 丢弃 | `PRO` |

只看 `/PROD/…`（正式归档）：实测当前索引 8651 条里有 455 条能取到目录名，共 20 个名字 → 18 个并入同族写法、1 个变体（`APOLLO2-MIX`）、1 个丢弃，**0 噪声**。不看 `TEST/PRE/DEV`（实测只会多出 `62` 这种垃圾目录名），也不解析 `mdmobs` / 华为 OBS 的 `/11/…` 旧形状（只是拼写变体）。

匹配仍然用归一后的子串（`apollo2mix` 在标题/版本号/链接里），所以目录名只影响「认得出机型」，不影响结果过滤；`/firmware APOLLO2` 这类族查询也不会被变体收窄。

### 斜杠规则（严格）

- 只有**最新一条用户消息**里的独立 `/firmware` 词能开闸；`/firmwarex`、`/firmware-finder`、`用/firmware总结`、反引号里的 `` `/firmware` `` 都不算（与宿主识别手势的边界规则一致）。
- 追问 / 机型确认轮也要重新带上 `/firmware`：机型有歧义时模型会列出候选，请你发 `/firmware SPRING2-10PRO 安卓` 这样的消息；登录需要手动粘 cookie 时发 `/firmware login <cookie>`。
- 没有斜杠的轮次里模型不会自行检索；如果它误调工具，会被宿主拒绝并提示用户改用 `/firmware`。

## 首次使用需要两份数据

插件不做常驻登录，只读本地索引；凭据缺失或过期时由 `firmware_sync` / `firmware_login` 自动处理。两份文件都在数据目录（默认 `$DSH_TBFW_DIR`，否则 `~/.tbfw`）：

| 文件 | 来源 |
|---|---|
| `token.json` | `firmware_login` 工具自动写入，或 `tools/login.sh`（弹浏览器登录后抓 cookie） |
| `board-<projectId>.json` | `firmware_sync` 工具（首次调用自动生成） |

```bash
# 1)（可选）手动登录取 token（会打开浏览器，登录完自动关窗）
#    一般可以跳过：第 2 步的 firmware_sync 发现没有凭据时会自动弹窗登录
./tools/login.sh

# 2) 在 Harness 里发 /firmware sync 生成索引（约 40 秒，8600 条）
```

## 四个工具（只能经 `/firmware` 使用）

| 工具 | 作用 |
|---|---|
| `firmware_find` | 机型 + 系统 → 固件；机型歧义时返回候选并要求确认（含该族变体） |
| `firmware_models` | 列出机型族、同族写法与变体；传 `model` 只看相关族 |
| `firmware_sync` | 从 Teambition 重拉看板索引；凭据缺失或过期时自动登录 |
| `firmware_login` | 获取/刷新登录凭据：静默刷新 → 弹窗登录 → 手动粘贴 |

工具本身仍然注册给模型（描述带「仅当用户输入 /firmware 时可用」前缀），但执行前有闸门；这是 DSH 目前能做到的「只认斜杠」强制点，也让模型在自然语言请求时能提示你改用 `/firmware`，而不是假装没有能力。

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

> F12 → Network → 任意请求右键「Copy as cURL」→ 把整段作为 `/firmware login <整段>` 发给 Harness（或调 `firmware_login(cookie="...")`）。

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
- **`/firmware` 入口**：`skill/SKILL.md`（frontmatter 里 `disable-model-invocation: true`）在 `apply()` 里用 `ctx.skills.register` 注册；注册表不读 frontmatter，插件自己解析后把 `invocation.modelInvocable=false / userInvocable=true` 传进去，所以模型目录看不到它，`/` 菜单看得到。
- **闸门**：`ctx.on('tools/pre-execute')` 只放行最新一条 direct user 消息里含独立 `/firmware` 的轮次，其余返回 `{ kind: 'deny', reason: … }`。判定逻辑与离线测试在 `gate-smoke.mjs`；机型/别名/变体解析的离线测试在 `model-resolve.test.mjs`（含迷你看板 fixture）。`npm test` 两个都跑，均不需要网络与凭据。
- **归档目录名**：`linkModelDir()` 只认 `/PROD/<chip>/<OS>/<机型>/…`，`foldModelDirs()` 再用现有打分把它归一到族（同族写法 / 变体 / 丢弃）。
- **显示环境**：宿主进程常常没有 `DISPLAY`/`WAYLAND_DISPLAY`（例如由服务启动），插件会显式补上同用户的 Wayland 套接字后再启动浏览器。
- **数据目录**按顺序解析：`DSH_TBFW_DIR` / `DSH_FIRMWARE_DIR` → 会话工作目录（`workingDirectory.ensure(agent)`）→ 部署默认目录 → 进程 cwd，取第一个含 `board-*.json` 的。
- **机型对齐**在插件里做：先按族名精确命中（`APOLLO2` 不会被同名别名/变体收窄），再按归档链接里的机型目录名命中变体（`APOLLO2MIX` → 变体 `APOLLO2-MIX`），最后才是近似打分：字母骨架 + 数字数量比较（`spring2pro` → `SPRING2-10PRO`）。只有唯一强匹配才自动确定，否则返回 `needs_confirmation`（候选里会带该族的变体）。
- **排序**：`生产库归档` > 发布 > 其他（`自归档` 不算归档，`下架` 排最末），同档按版本号里的构建日期倒序。
- **构建日期**优先取 `固件版本` 字段，缺了就从标题或下载地址里捞（在制版本常常只有链接）。
- **在制版本提示**：比已归档最新还新的测试/压测版本会单独列在 `pending`。

## 改动后必须重载

运行中的进程不会自动加载新代码（profile 的 HMR 不监听 node_modules 里的插件模块）。改完 `index.js` / `skill/SKILL.md` 后**重启 `dsh web`**；仅用 `plugin_manager` 关开插件行不会让 ESM 缓存失效。

## 已知限制

- `next.cpinnov.run` / `alist.cpinnov.run` 是内网分享页（`10.16.18.x`），外网不可达；实体文件在 `minio.cpuniverse.cn` / `mdmobs.cpuniverse.cn`。`--verify` 只校验后者。
- 登录 cookie 约 24 小时过期，JWT 约 3 天；过期后发一次 `/firmware sync`（或 `/firmware login`）。
- `sync` 约 40 秒、`login` 最长 180 秒，期间工具卡片保持 running。
- 严格斜杠：追问、确认、粘 cookie 都必须带 `/firmware`，这是「只能 / 触发」的直接代价。
- 机型别名/变体只从 `/PROD/…` 归档链接提取（只影响「认得出机型」）：只在 `TEST/PRE/DEV` 出现的新机型不会被提前识别，会正常走 `needs_confirmation`。
- 目录名与「机型」字段可能不一致（例如 `CP_SP2-10MIX_…` 这条任务的机型写的是 `RK / SPRING2-10PRO`），此时以返回的 `variant` / 版本号为准，不要只看「机型」字段。

## 许可

内部工具，未附许可协议；图标为本仓库自绘 SVG。

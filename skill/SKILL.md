---
name: firmware
description: 用 /firmware 按机型和系统检索 Teambition 量产固件（线刷 / OTA 直链）。固件, firmware, 线刷, OTA, 量产版本, 发版, Teambition。
disable-model-invocation: true
---

# 固件检索

本流程只能由用户显式输入 `/firmware` 启动。`firmware_*` 工具由宿主侧闸门保护：只有最新一条用户消息里出现独立的 `/firmware` 词才允许调用；没有它时调用一律被拒绝。不要绕过闸门，也不要在没有 `/firmware` 的轮次自行检索或猜测固件信息。

## 参数

`/firmware` 之后的文字就是参数，自然语言写法也认：

- 机型：`spring2pro`、`SP2-10PRO`、`apollo 12 pro`、`瑞芯微 / APOLLO 12 PRO`、`T3 / SPRING2`。
- 系统：安卓 / Android、Debian、BuildRoot、Linux（工具里写作 `Android` / `Debian` / `BuildRoot`）。
- 客户：`-c` / `--customer CP|SZ|QX|VR|*`；缺省按 CP 过滤，`*` / 「所有客户」表示不限客户。
- 其它：`--version <V1.08>`、`--mainline <Android-11>`、`--stage <阶段>`、`-n` / `--limit <1-20>`、`--verify`、`--all`。
- 用户说「最新的」时用 `limit: 1`；没说条数时用工具默认值。

## 子命令

| 输入 | 工具 |
|---|---|
| `/firmware models`、`/firmware 机型` | `firmware_models` |
| `/firmware sync`、`/firmware 同步` | `firmware_sync` |
| `/firmware login [window\|auto\|headless\|<cookie 或 Copy as cURL>]`、`/firmware 登录` | `firmware_login` |
| 其它（含只有 `/firmware` 没有参数） | `firmware_find`；没有机型时先问用户机型，并请用户下一条消息仍以 `/firmware` 开头 |

## 流程

1. 索引缺失或过期（超过 3 天）时先 `firmware_sync`（约 40 秒，凭据缺失会弹浏览器，最长约 180 秒）；用户的 `/firmware` 请求只是查询时可先直接 `firmware_find`，只有返回提示索引过期/缺失才补 `sync`。
2. 调用 `firmware_find`，按 `status` 处理：
   - `ok`：用 markdown 表格或列表给出版本、构建日期、客户，以及线刷 / OTA 直链，链接写成 `[名称](url)` 便于点击；同时转述 `note`、`otherCustomers`（其它客户）、`pending`（比已归档更新的在制/测试版本）里的信息，不要丢。
   - `needs_confirmation`：把候选机型列出来，请用户确认并用 `/firmware <规范机型> [系统] [参数]` 重发；不要替用户猜，也不要在同一轮重复调用。
   - `needs_auth`：按提示调用 `firmware_login`；自动登录失败时，请用户把 cookie 或 DevTools 的「Copy as cURL」以 `/firmware login <cookie>` 的形式发来。
   - 其它状态/错误：原样说明原因，并给出下一步（`/firmware sync`、`/firmware models`、`/firmware login`）。
3. 如果工具返回「只能由 /firmware 触发」的拒绝：不要重试、不要换工具绕开，直接请用户带 `/firmware` 重发，例如 `/firmware spring2pro 安卓`。
4. 客户字段必须保留：同一机型不同客户的固件不能混刷；默认 CP，但不要把 `otherCustomers` 省略掉。
5. 不要用 bash 直接读数据目录里的 `board-*.json` / `token.json`，也不要直接调 `tools/login.sh`；一律走 `firmware_*` 工具。

## 输出

- 直接给结论：机型、系统、版本、构建日期、客户、线刷/OTA 链接。
- 索引时间超过 3 天就提示用户 `/firmware sync`。
- 不确定机型时给候选，不要编造版本号或链接。

---
name: firmware
description: 用 /firmware 查固件、TB 版本任务/子任务（待解决/已解决）、以及 bug 是否修进正式版。固件, firmware, 线刷, OTA, 量产版本, 发版, Teambition, 子任务, 问题, 已解决, 待解决, 修复。
disable-model-invocation: true
---

# 固件与问题检索

本流程只能由用户显式输入 `/firmware` 启动。所有 `firmware_*` / `firmware_fix_*` 工具由宿主侧闸门保护：只有最新一条用户消息里出现独立的 `/firmware` 词才允许调用；没有它时调用一律被拒绝。不要绕过闸门，也不要在没有 `/firmware` 的轮次自行检索或猜测。

## 三条能力线

1. **固件**：`firmware_find` / `firmware_models` —— 按机型/系统/客户找量产固件和线刷、OTA 链接。
2. **TB 版本任务/子任务**：`firmware_issues` —— 当前和历史版本任务下的子任务，标已解决 / 待解决 / 已拒绝 / 暂挂起，并挂回父版本任务。
3. **修复判定**：`firmware_fix_check` / `firmware_fix_models` / `firmware_fix_log` / `firmware_fix_matrix` —— 在 alist `/PROD` 的 commit-logs 里判断 bug 是否修进客户正式版，并比对其它机型/系统/芯片。

**TB 状态不等于代码已修复**：`firmware_issues` 给业务侧记录，`firmware_fix_check` 给代码证据（结论是「疑似」），两者分开写。

## 参数与默认值

- 机型：`spring2pro`、`SP2-10PRO`、`apollo 12 pro`、`瑞芯微 / APOLLO 12 PRO`、`T3 / SPRING2`。
- 系统：安卓 / Android、Debian、BuildRoot、Linux（`linux` = Debian + BuildRoot）。
- 客户：`-c` / `--customer CP|SZ|QX|VR|*`；**缺省 CP**，`*` / 「所有客户」不限。
- 其它：`--version`、`--mainline`、`--stage`、`-n/--limit`、`--verify`、`--all`、`--source auto|live|index`。
- 用户说「最新的」→ `limit: 1`；没说条数用默认值。

## 子命令路由

| 输入 | 工具 |
|---|---|
| `/firmware <机型> [系统/参数]` | `firmware_find` |
| `/firmware models ...` | `firmware_models` |
| `/firmware 问题 <机型> [系统] [--status open/done/all] [关键词]` | `firmware_issues` |
| `/firmware 修复 <bug 描述> [机型/客户/系统]` | `firmware_fix_check`（默认带 TB 证据） |
| `/firmware 日志 ...` | `firmware_fix_log` |
| `/firmware 矩阵 <hash/DO-xxxx/标题>` | `firmware_fix_matrix` |
| `/firmware sync [tb|fix]` | `firmware_sync`（看板+子任务）/ `firmware_fix_sync`（commit 索引） |
| `/firmware 登录` | `firmware_login` |

**默认是快速路径，不需要先 sync**：

- 本地有 TB 全量索引（`board` format 2 + `subtasks`）时，`firmware_issues` 直接查本地（毫秒级）。
- 本地没有索引，或用户要「最新/刚提的」→ 走实时 TB 搜索（约 2–6 秒），只抓命中任务的子任务。
- 用户明确要「全量/历史所有/完整状态」→ 传 `source: "index"` 或 `full: true`；没有全量索引时先 `/firmware sync`（约 60–90 秒）。
- `firmware_find` 在没有 TB 看板索引时会自动只扫 alist `/PROD` 匹配目录（按型号/系统/客户，约 1 秒），不会要求先 sync。

## 少走弯路

1. 机型写法拿不准时，把主工具与对应 models 工具同轮并发：TB 看板用 `firmware_models`，alist 产品线用 `firmware_fix_models`，不要混用。
2. 「这个问题解决没有 / TB 上有没有记录」→ 先 `firmware_issues`；需要代码层结论时同轮并发 `firmware_fix_check`，回答里分开写「TB 业务状态」和「代码证据」。
3. 「修没修 / 进了哪个正式版 / 其它机型有没有」→ `firmware_fix_check`；不要只凭 TB 的 `isDone` 说已修复。
4. 一次把参数带满：「最新的」→ `limit: 1`；看全客户 → `customer: "*"`；要体积第一次就带 `verify: true`。
5. `firmware_issues` 默认 CP；`otherCustomers` 里的客户必须列出来，不要悄悄吞掉。
6. 不要用 bash 直接读 `.tbfw` / `.fixfinder` / `token.json`，也不要手工拼 alist 路径；一律走工具。

## 流程

1. 查询类请求直接调工具，不必先 sync；只有工具返回 `needs_sync` / 索引过期（board >3 天、fix >24h）时才补 sync。
2. `firmware_find`：
   - `ok`：用表格/列表给版本、构建日期、客户、线刷/OTA 链接；转述 `note`、`otherCustomers`、`pending`。
   - `source: alist`：说明来自 alist `/PROD`，Teambition 没有归档链接。
   - `needs_confirmation`：列候选（含 variants），请用户用 `/firmware <规范机型>` 重发；不要猜。
3. `firmware_issues`：
   - `ok`：按版本分组，给已解决/待解决计数和每条子任务的状态、日期、执行人；`query` 命中时给分数/命中词。
   - `empty` 且有 `lowConfidence`：把低置信候选列出来，请用户换更具体的现象词。
   - `needs_confirmation`：列候选机型，请用户确认。
   - `needs_auth`：提示 `/firmware login`。
   - `needs_sync`：说明「要全量索引」再 `/firmware sync`；日常查询可改用 `source: "live"`。
4. `firmware_fix_check`：
   - 结论是「疑似」，依据候选提交与客户正式版；把 `tb` 里的 TB 子任务证据一并转述。
   - 代码/TB 不一致时按 `tb.notes` 提示（代码已发版但 TB 未关闭，或 TB 已解决但日志未命中）。
5. 工具返回「只能由 /firmware 触发」时，不要重试、不要绕开，请用户带 `/firmware` 重发。

## 输出

- 固件：机型、系统、版本、构建日期、客户、线刷/OTA 链接；标注数据源（Teambition / alist）。
- 问题：版本任务、阶段、构建日期、子任务状态（已解决/待解决/已拒绝/暂挂起）、完成日期、执行人；明确这是 TB 业务记录。
- 修复：verdict、依据提交、客户正式版版本；注明「疑似，需研发复核」，并附 TB 证据。
- 索引时间超过 3 天（TB）或 24 小时（fix）时提示 `/firmware sync`。
- 不确定机型时给候选，不要编造版本号、链接或状态。

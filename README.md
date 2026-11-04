# firmware-finder

DeepSeek Harness 插件：一个 `/firmware` 入口，覆盖三件事：

1. **固件**：按机型 + 系统 + 客户，在 Teambition 发版看板和 alist `/PROD` 里定位量产固件，给线刷 / OTA 直链。
2. **TB 版本任务/子任务**：当前版本和历史版本任务下的子任务，标 **已解决 / 待解决 / 已拒绝 / 暂挂起**，并挂回父版本任务。
3. **修复判定**：在 alist `/PROD` 的 `commit-logs.txt` 里判断 bug 是否修进客户正式版，比对其它机型/系统/芯片，并附带 TB 子任务证据。

```text
/firmware spring2pro 安卓
/firmware 问题 spring2pro 摄像头断层 --status open
/firmware 修复 摄像头热插拔断层 spring2pro
/firmware models
/firmware sync
```

**只能由 `/firmware` 触发**：`firmware_*` 与 `firmware_fix_*` 工具由宿主侧闸门保护，只有最新一条用户消息里出现独立的 `/firmware` 词才允许执行。

## 快速路径：按型号懒加载，不用先 sync

- 默认客户 **CP**；`-c '*'` / 「所有客户」不限。
- `firmware_find` 在没有 TB 看板索引时，直接按型号/系统/客户扫 alist `/PROD` 匹配目录，约 **1 秒**返回版本和链接。
- `firmware_issues` 默认：
  - 本地已有 TB 全量索引（`board` format 2 + `subtasks`）→ 本地查询，毫秒级；
  - 没有索引，或用户要「最新/刚提的」→ 实时 TB 搜索（约 **2–6 秒**），只抓命中任务的子任务；
  - 用户明确要「全量/历史所有/完整状态」→ `source: "index"` / `full: true`，没有索引时先 `/firmware sync`（约 60–90 秒）。
- `firmware_fix_*` 仍使用 `.fixfinder` 的 commit 索引；只看某个型号时可用 `only` 收窄 sync。

## 工具

| 工具 | 用途 |
|---|---|
| `firmware_find` | 机型 + 系统 + 客户 → 固件版本、构建日期、线刷/OTA 链接；机型歧义返回候选 |
| `firmware_models` | TB 看板里的机型族、同族写法、变体 |
| `firmware_issues` | TB 当前/历史版本任务的子任务状态（已解决/待解决/已拒绝/暂挂起） |
| `firmware_sync` | 拉 TB 看板 + 子任务，建全量索引（可选 `issues:false` / `force:true`） |
| `firmware_login` | 刷新 Teambition 登录凭据 |
| `firmware_fix_check` | bug → 疑似修复提交、是否进入客户正式版、跨机型/系统/芯片覆盖；默认附带 TB 证据 |
| `firmware_fix_models` | alist 产品线的机型探测（`SPRING2PRO → SP2-10PRO`） |
| `firmware_fix_log` | 原样列出某个范围的 PROD 提交标题 |
| `firmware_fix_matrix` | 给定 hash / 工单号 / 标题，输出产品线覆盖矩阵 |
| `firmware_fix_sync` | 同步 alist `/PROD` 的 commit 索引（只读） |

## firmware_find

```text
/firmware <机型> [系统] [参数]
```

| 参数 | 说明 |
|---|---|
| `-c, --customer <CP\|SZ\|QX\|VR\|*>` | 客户；缺省 CP |
| `-s, --system <android\|debian\|buildroot\|linux>` | 操作系统；`linux` = Debian + BuildRoot |
| `--version <V1.08>` / `--mainline <Android-11>` / `--stage <阶段>` | 收窄条件 |
| `-n, --limit <1-20>` | 条数，默认 5 |
| `--verify` | HEAD 校验 minio 链接体积；alist 时解析 sha256sum.txt |
| `--all` | 包含没有固件链接的任务 |
| `--source <auto\|tb\|alist>` | 数据源；默认 auto |

结果里会带：

- `source: alist` —— 该版本来自 alist `/PROD`（Teambition 归档字段没有链接）；
- `otherCustomers` —— 默认 CP 之外的客户及任务数；
- `pending` —— 比已归档版本更新的在制/测试版本；
- `variant` / `matchedFamilies` —— 命中变体（如 `APOLLO2-MIX`）或等价写法（`7≡7A`、`12≡12A`）。

## firmware_issues

```text
/firmware 问题 <机型> [系统] [--status open|done|rejected|all] [关键词]
```

| 参数 | 说明 |
|---|---|
| `model` | 机型；只给 `query` 时可以省略 |
| `system` / `customer` | 系统；客户默认 CP，`*` 不限 |
| `status` | `all`（默认）/ `open` / `done` / `rejected` |
| `query` | 现象关键词；对子任务标题 + 备注做自然语言匹配 |
| `stage` | 父版本任务阶段过滤 |
| `limit` / `subtaskLimit` | 版本数（默认 5）/ 每版本子任务数（默认 30） |
| `source` | `auto`（默认）/ `live` 实时 / `index` 全量索引 |
| `pages` | 实时搜索翻页数，默认 2（每页 10 条） |

状态口径：

| outcome | 判定 |
|---|---|
| 已解决 | `isDone=true` 且状态不含拒绝类 |
| 待解决 | `isDone=false`（含 `完成待验证`） |
| 暂挂起 | 状态含「挂起」 |
| 已拒绝 | 状态含「拒绝 / 不解决 / 不执行」 |

只检索**版本任务及其子任务**：父任务需有 `固件版本` 字段、标题含 `【版本迭代】`，或带固件链接；CPDoc、release plan 等非版本任务不进入。

实时搜索（`source: live`）只覆盖 TB 搜索接口命中的任务，单页 10 条；要完整历史/全量状态用 `source: index`，先 `/firmware sync`。

## firmware_fix_check（原 fix-finder）

判定流程：机型探测 → 选客户线 → commit 标题自然语言检索 → 客户线是否包含该提交 → 是否被 revert → 是否已进正式版。

| verdict | 含义 |
|---|---|
| `fixed_released` | 修复已进入客户产品线正式版 |
| `fixed_other_line_only` | 只在其它机型/系统/芯片出现，客户线未合入 |
| `found_unscoped` | 找到疑似修复但未指定机型 |
| `needs_model` | 机型没唯一确定 |
| `needs_baseline` | 该芯片+客户+系统没有产品线 |
| `not_found` | 没有匹配提交 |

结论是「疑似」，需要研发复核代码；日志只有标题没有 diff。

`include_tb`（默认 true）会附带同型号/客户的 TB 子任务证据，并在两边不一致时提示：

- 代码已发版但 TB 仍有待解决 → 确认是否同一问题 / TB 未关闭；
- TB 已解决但代码日志未命中 → 日志可能缺失或来自未公开分支。

## 数据来源

### Teambition

看板：**【研发部】CI/CD 发版流程**（`65a8da81950780b816d12bd9`）。

- `board-<projectId>.json`（format 2）：全部任务 + 归档字段 + `isDone` / `subtaskCount`；
- `subtasks-<projectId>.json`：有子任务的父任务及其 3260+ 个子任务（状态、完成时间、执行人）。

### alist `/PROD`

按型号懒加载，不预扫全部版本：

```
/PROD/<芯片>/<系统>/<机型>/<客户>/<LCD>/<版本>/
    *.img / *_OTA.img / sha256sum.txt / release_notes.md / commit-logs.txt
```

`firmware_find` 会只列匹配机型/客户/系统的目录，按需取 `fs/get` 的 signed raw_url；不会下载固件，也不会扫 726 个版本目录。

`firmware_fix_*` 的 commit 索引仍来自 `/PROD/<芯片>/<系统>` 下每条产品线最新正式版的 `commit-logs.txt`；默认芯片 RK，可用 `DSH_FIXFINDER_PLATFORMS=RK,T3,SC60,QUALCOMM` 扩展。

> MCU / APP / CIT（`/PROD/MCU`、`/PROD/APP`、`/PROD/CIT`）目前**没有**进检索；这是下一步，不在 0.5.0 范围内。

## 安装与升级

```bash
# 本地开发：link 安装，改完重启 dsh web 即可
dsh plugin --profile web add /home/my/Documents/deepseek-harness/default-workspace/plugins/firmware-finder

# 或从 GitHub
dsh plugin --profile web add github:Alone-show/firmware-finder
```

并确认 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里有 `@local/firmware-finder`。

**从 fix-finder 迁移（0.5.0）**：旧 `@local/fix-finder` 已合并进本插件，工具改名为 `firmware_fix_*`。卸载：

```bash
dsh plugin --profile web remove @local/fix-finder
```

并从 `dsh.profile.bundles` 删除 `@local/fix-finder`，然后重启 `dsh web`。

改完代码必须重启 `dsh web`（HMR 不监听 node_modules）。

## 数据目录

| 路径 | 内容 |
|---|---|
| `$DSH_TBFW_DIR` / 工作区 `.tbfw/` | `token.json`、`board-*.json`、`subtasks-*.json`、`alist-cache.json` |
| `$DSH_FIXFINDER_DIR` / 工作区 `.fixfinder/` | fix 的 v2 提交索引（兼容旧数据，不迁移） |

## 测试

```bash
npm test
```

离线跑：闸门、机型解析、alist 客户端、fix 原有 62 个用例、子任务索引/检索用例。不需要 TB/alist 网络。

## 已知限制

- TB 实时搜索单页 10 条，翻页有上限；完整历史必须建全量索引。
- TB 任务列表接口不支持按机型服务端过滤，所以全量索引仍是一次性拉全量任务（约 40 秒）。
- TB 状态是业务记录，不等于代码已修复；代码结论基于 commit 标题，只有标题没有 diff。
- fix 索引默认只覆盖 RK；扩展芯片需要重新 `firmware_fix_sync`。
- alist `next` / `alist` 分享页是内网；实体文件在 minio / mdmobs。
- 登录 JWT 约 3 天；cookie 失效后 `/firmware sync` 会触发重新登录。

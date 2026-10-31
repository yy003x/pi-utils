# 重建前的 pi-utils 功能清单

本文记录用户要求清空前的本地实际功能，作为 Powerline 个人版后续整合的依据，不表示新版本已经实现这些功能，也不要求恢复旧架构或兼容层。

## 来源和边界

- 记录时间：2026-10-31。
- 原路径：`~/mycode/pi-utils`。
- 原 HEAD：`123c89e17bf7d1d1c5175f59d0cf8d9bdfc9315e`，与重建时 GitHub `main` 相同。
- 依据：本地 `README.md`、`package.json`、`extensions/settings.ts`、`extensions/statusline/{index,core}.ts`、`extensions/run-stats/{index,activity,usage,summary}.ts`。
- 本地有未提交改动：`session-meta`、`tool-activity`、`turn-metrics` 被合并为尚未提交的 `run-stats`。本清单以磁盘实际源码为准，不仅以远端提交为准。
- 用户已明确允许丢弃旧目录的未提交及未跟踪内容，要求记录功能后从 GitHub `main` 重建。
- 原 origin 从 GitLab 拉取、同时向 GitHub/GitLab 推送；新仓库以 `git@github.com:yy003x/pi-utils.git` 为唯一 origin，不沿用双推送配置。

## 状态栏

原 `statusline` 是唯一底栏渲染者，通过 `setFooter()` 显示：

- 主机名、当前目录、Git 分支、会话名。
- 当前上下文 Token 和占用比例、自动压缩标识，70%/90% 颜色阈值。
- 会话累计输入/输出、缓存读写、最近一次 assistant 请求的缓存命中率、费用、OAuth 订阅标识。
- 当前 provider/model、思考等级。
- 最近一次 `run-stats` 发布的运行时长。
- 外部 `pi-sinan-usage` 额度状态、`pi-sinan-fast` Fast 状态，其他扩展状态单独保留。
- 自动 full/compact/narrow 宽度适配；文本单行化、部分终端控制字符过滤、按可见列裁剪。

它只消费外部额度文本，不读取认证、不查询订阅接口。新版本若由 Powerline 负责布局，不应再并行加载这一底栏实现。

## 实时活动与完整运行统计

`run-stats` 统一实时活动和结算统计：

- 工作时在编辑器上方显示 Agent、Provider、Tool、User wait 阶段。
- 显示并发工具名称、运行时间、已完成数和正在执行数；最多展示 5 个名称，其余显示数量。
- 等待用户只展示扩展提示种类，不记录提示正文或工具参数。
- 工具错误或非零退出不被推断成持续未解决的严重问题，原始工具结果仍由 Pi 展示。
- 统计边界为首次 `agent_start` 至 `agent_settled`，覆盖自动重试和工具执行，而非每个 `agent_end`。
- 记录总时长、首次可见 text/thinking/toolcall delta 延迟、完成状态、工具调用数、工具耗时、峰值并发、重试数、成功压缩数、Token/缓存/费用差值。
- 工具耗时记录最多 1000 项，名称最多 80 字符。
- 完成状态包含 `completed/error/aborted/length/unknown`；中止不能伪装为成功。
- 结算后移除实时活动，使用展示型 custom entry 渲染 `Run · …` 摘要，不注入模型对话。
- 旧持久类型为 `pi-utils:turn-metrics:summary`；旧实现能读取仅含 durationMs/toolCalls/usage/completedAt 的四字段记录。本项仅记录旧行为，不自动要求新版本提供迁移。
- `/run-stats` 只读当前分支的有效记录，汇总次数、总时间、工具数、重试、压缩、首 Token 平均延迟、非完成数量、累计耗时最高的 3 种工具，不调用模型、不写数据。
- 通过 `pi-utils/run-stats/updated/v1` 向旧底栏发布最新时长。

## 可选提醒和设置

旧配置位于全局 `settings.json` 的 `piUtils` 下，受信任项目的 `.pi/settings.json` 可逐字段覆盖：

```json
{
  "piUtils": {
    "statusline": {
      "showCost": true,
      "showDuration": true,
      "showCache": true,
      "showQuota": true,
      "compactAtWidth": 100
    },
    "notifications": {
      "settleMs": 60000,
      "userWaitMs": 30000
    }
  }
}
```

- 四个显示开关默认 true；`compactAtWidth` 可选，整数范围 40–300。
- `showQuota` 不控制独立的 Fast 指示。
- 提醒默认关闭；只有配置 1000–86400000 毫秒的正整数阈值才开启。
- 运行超过 settleMs 后结算，或扩展 UI 连续等待超过 userWaitMs，才发送 Pi 会话内通知。
- 不发送桌面通知，不申请系统通知权限。
- 原配置读取有 stat 指纹缓存；非法字段被忽略、文件错误返回默认值，这是旧实现事实而非新设计要求。

## 原职责边界

- 原包仅做显示和统计，不改 prompt、对话内容或 provider 请求，不注册模型 provider，不读认证。
- 原包不管理其它包、Skills、模型目录、认证或快捷键。
- 不拦截模型选择。旧 `pin-model` 已删除：普通模型/思考等级选择由 Pi 的会话本地行为管理，选择器 Ctrl+S 保存默认值，不能为重建重新引入拦截。
- 原验证入口：`npm run typecheck`、`npm test`；源码声明 Pi 0.86 系列、Node >=22.19。本次记录不是旧工作区测试已通过的证明。

## 与新基础的关系

Powerline 自身已有模型、思考等级、路径、Git、上下文、Token、缓存、费用和扩展状态；这些能力优先复用，不另建第二套底栏。旧 run-stats 的完整运行边界、只读统计、等待用户进度和可选会话提醒是可独立评估的增量。外部状态 key 只是历史集成信息，不把特定旧扩展作为新包依赖。

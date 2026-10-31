# 来源与维护边界

## 来源与许可

- `cd-command.ts` 的路径解析、补全和会话切换基础源自 [nicobailon/pi-powerline-footer](https://github.com/nicobailon/pi-powerline-footer) `0.22.0`，提交 `eeacaa2ca5097328c548d85f8173f033f6752d81`。
- 当前只保留上述目录切换模块，不包含 Powerline 的界面、编辑器、队列、Shell、文案或配置系统。路径补全、新会话创建和当前分支保留功能按现行 Pi API 维护。
- `utils/quota/` 集成自个人 `model-quota` 模块，包含 Codex / GLM 额度读取、官方路由校验、窗口解析、快照过期、凭据隔离、请求取消及状态栏额度显示。解析测试保留在 `tests/quota.test.ts`，并覆盖无效认证。
- 根目录 `LICENSE` 保留 Nico Bailon、上游贡献者和本项目作者的 MIT 署名。

## 职责

`utils/index.ts` 是唯一入口。`utils/footer.ts` 独占底栏；额度模块只通过 `setStatus()` 发布状态，不另带独立入口或旧 `footer.ts`，也不恢复其费用、缓存命中率等额外显示。统计只读取原生条目和生命周期事件，不写入会话；`cd-command.ts` 只响应显式 `/cd`。

不得注册 prompt、输入或 Provider 请求改写 hook，不自动发送消息，不增加模型调用、模型工具或输入框替换。`message_end` 只观察，不返回替换消息。目录切换沿用原生会话替换与项目信任检查，源会话和历史消息保持不变。

## 验证

修改使用的 Pi SDK 版本后，运行类型检查、相关纯函数测试和真实 SDK 测试。界面或目录切换变化还需真实 TUI 检查。隔离 HOME、agent 目录和认证，禁止用个人凭据或付费模型做默认测试。

重点覆盖窄终端、未知上下文、额度过期、官方路由、跨 agent_start 的统计、settled 后无会话写入，以及 `/cd` 的当前分支和原文件保护。发布包只包含声明的四项能力。

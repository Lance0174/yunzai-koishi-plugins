# 群管理原仓库实现审查（2026-09-13）

结论：当前群管 0.3.1 有日常操作基础，但审核通知入口、私聊群管、周期定时、投票、验证和违禁词仍存在明确的迁移缺口，应继续标为开发中。本轮只审查和记录，不修改群管实现、不发布新的群管版本。

这次判断以原模块的事件、权限、状态和 API 调用为依据。未导入执行原仓库代码，也未连接用户 SnowLuma 或向真实 QQ 发送消息。

## 审查范围与来源

- **yenai-plugin**：yeyang52 / yeyang 及贡献者，固定提交 `144dd784f81698a696b1c192f7d82219286b2ca5`，GPL-3.0。阅读 `apps/groupAdmin` 的日常操作、私聊、黑白名单、投票、验证、违禁词；`model/GroupAdmin.js`；事件消息及群通知；通知设置、配置合并和发送目标。
- **GroupEntry_Plugin**：A1Panda / @A1_Panda 及贡献者，固定提交 `a88d448a14ddc21477f6320c6e29c9eee4da6e27`。阅读邀请通知、引用确认、成员申请、名单、入群退群门槛与定时黑名单检查。该快照未见 LICENSE，仅参考行为，不复制其源码。`groupRequest.js` 还注明千奈千祁、飞舞、浅巷墨黎、一只哒等作者与修改者。
- 对照对象：本仓库群管 **0.3.1**，提交 `8e4a11a0521ef1085941a448b6d66e0af882dd47` 的 `packages/group-manager/src`。
- SnowLuma：使用此前保存的 OneBot action 源码快照核验接口注册，不能据此断言用户运行版本已经支持或执行成功。

上述是固定快照审查，不宣称覆盖上游此后所有更新。小飞和 R-plugin 是点歌、视频迁移的主要来源，本报告聚焦承担群管功能设计的两个仓库。

## 实际行为对照

| 功能 | 原实现 | 当前 0.3.1 | 判断 |
| --- | --- | --- | --- |
| 禁言、解禁、踢人、全员禁言 | 命令直接进行操作者和机器人权限检查，随后调用群操作；普通操作没有二次确认。[Y1][Y2] | 已直接执行，仍检查真实目标群角色。 | 日常操作已有；不应重新给普通禁言、踢人加确认流程。 |
| 批量操作与清理 | 支持多个 @ 的禁言/踢人；清理从未发言和长期潜水先展示名单，再通过上下文确认。[Y1][Y3] | 普通操作只收一个目标；潜水清理有预览及 `--执行`，最多 30 人并重新核验；没有同等的多目标入口和从未发言清理。 | 部分迁移。原库本身对批量清理有确认，不能把它与单人操作混为一谈。 |
| 主人权限与私聊群管 | 主人可从私聊指定群号禁言、解禁、踢人、切换全员禁言；仍检查机器人目标群权限。[Y2][Y4] | 基础命令依赖 `session.guildId`，操作者必须是目标群管理员或群主；配置的审核人不能因此从私聊进行基础群管。 | 私聊群管缺失，主人角色也未形成统一模型。建议优先补齐明确群号的私聊入口和角色规则。 |
| 用户黑白名单 | 黑名单发言/入群会踢人、申请会拒绝；白名单过滤处罚，主人可越过部分白名单保护；可独立打开被禁言后的自动解禁。[Y5] | 黑名单忽略消息，白名单豁免本插件处罚及验证，无自动解禁；可按全局用户、本群用户、群维护。 | “忽略/豁免”是用户明确要求的迁移语义，保留。原库自动踢人和主人绕过豁免不应自动移入同一名单。 |
| 邀请审核 | 先拒绝黑群，再自动接受白群，再按模式 0/1/2/3 自动同意、不处理、人工、自动拒绝；默认人工、5 分钟、最多 20 条。[G1][G2] | `autoInvite + inviteAllow` 只实现白名单自动同意；`inviteDeny` 阻止同意，未实现原模式的完整自动拒绝流程；本地 TTL 默认 24 小时。 | 部分迁移。需独立明确邀请策略和有效期，24 小时本地记录不能表示平台 flag 仍可用。 |
| 审核人与引用关联 | 从引用消息内容提取群号，匹配待处理项；允许邀请人、当前发送会话中的管理员、notifyUsers 审核。[G3] | 审核只允许配置的 reviewers；保存 Bot、请求和原通知 ID 关联，并有并发领取和未知结果状态。 | 不照搬“正文群号匹配”和会话管理员判断；应保留准确请求关联及目标范围。邀请人自审是否开放要成为明确策略，不能暗中扩大权限。 |
| 审核通知与独立监听 | GroupEntry 的管理群/私聊通知带请求详情与操作指引；椰奶的监听是独立事件消费者。[G1][Y6] | 审核通知仅发到 `reviewGroups` 并保存引用关系；独立监听的管理员私聊/自定义目标只收到事件摘要，没有请求编号及审批引用关联。 | 关键缺口：用户选择默认私聊管理员后，仍需另发“请求列表”找编号。应让需要审核的通知带编号，并为每个投递位置记录原消息关联，保持监听独立。 |
| 事件开关与内容 | 椰奶按默认→群→Bot→Bot+群合并设置，多数原默认关闭；能转发媒体正文，区分退群/被踢、管理员设置/撤销、机器人禁言等。[Y6][Y7] | 监听独立；事件默认开启，聊天正文默认关闭；指令支持当前 Bot 默认及本群覆盖。媒体变成类型占位，部分事件仅为“状态变更”摘要。 | 默认开启是用户指定，保留；多层继承、恢复继承、细化事件和媒体还原属于未完整迁移。应先补事件详情和可用指令，不要求填写管理群才能监听。 |
| 定时禁言 | `node-schedule` 接收 cron，Redis 保存任务，重启重建，可周期执行。[Y8] | 只支持相对时间或带时区 ISO 时间的一次性任务，数据库保存和领取。 | 周期调度缺失；“有定时命令”不等于完成原定时功能。建议增加每周/每日规则和时区，沿用已有防重复领取。 |
| 群投票 | 分别控制禁言/踢人，支持/反对票，限时结束时比较；管理员支持或反对可以立即结束，提前一分钟提醒。[Y9] | 默认 3 票、5 分钟，赞成达标即进入执行；没有反对票、分功能开关及管理员一票处理。 | 核心规则部分迁移，不能仅调整提示文字。保持用户要求的默认可用，同时补齐投票状态和结束规则。 |
| 入群验证 | 算术题、精确/包含匹配，默认 7 次、300 秒、提前提醒；支持重新验证、绕过和从未发言成员重验；失败或超时踢出。[Y10] | 发送验证码并要求 `验证 代码`；10 次错误上限；管理员通过，默认超时只通知，显式 `--踢出` 才处罚。 | 明显简化。算术题、提醒、重新验证和重验批次缺失；“默认只提醒”是当前迁移选择，非原库行为，也非用户明确指定。下一轮应明确对齐验证模式和处罚规则。 |
| 违禁词与头衔过滤 | 模糊/精确/两类正则，踢/禁/撤及组合，分群禁言时长；有头衔屏蔽词。[Y11] | 精确/包含文本，撤回加可选禁言；没有正则、多种处理策略和头衔屏蔽词管理。 | 部分迁移。优先补策略和预览；若引入正则，需要可控执行和清楚的匹配测试。忽略名单与处罚名单仍分开。 |
| 自动退群 | Bot 被邀请加入时检查人数门槛（默认配置 100）及白名单/主人/可选管理员豁免；定时任务巡检的是黑名单群。[G2][G4] | 只有明确指定群的手动退群，没有自动策略。 | 未迁移；自动退群会改变机器人覆盖群，应作为独立可见策略。原库定时任务不是“人数周期巡检”，旧报告对此表述不准确。 |
| 公告、精华、群资料 | 椰奶调用协议/QQ 网页接口，包含公告、精华、头衔及群资料功能。 | 基础公告增删查、精华、管理员、群名、群头像、头衔、成员资料、禁言列表、近期入群和潜水排行已有。 | 已有基础命令；公告图片/高级选项、幸运字符、星级和网页统计未达到原库覆盖面。不能将时间排序的潜水排行当作发言次数统计。 |

## SnowLuma 能力边界

已读 action 快照包含 `set_group_ban`、`set_group_kick`、`set_group_kick_members`、`set_group_whole_ban`、`set_group_add_request`、`set_essence_msg`、`_send_group_notice`、`_get_group_notice` 和 `get_group_honor_info` 注册。其中公告已有图片、置顶、新成员提示及确认等字段，当前迁移只使用正文。

这说明批量群管、请求处理、公告扩展等并非没有协议入口；应核对桥接层返回值和实际版本再决定适配。`get_group_signed_list` 在已保存文件中未找到，不能把当前“打卡列表”命令注册成功当成 SnowLuma 已支持。群幸运字符、网页统计与完整撤回媒体同样不能只靠标准 OneBot 假定可用。

验证阶段应记录 `get_version_info` 的实际版本，在本地协议样本验证后，再由用户环境核对一次真实效果。此次未做真实账户操作。

## 下一轮实施判断

建议先完成一批可连贯使用的群管流程：统一主人/群管理员权限；补私聊指定群号和多目标命令；让管理员私聊及自定义目标的审核通知能直接按编号/引用处理；补事件具体详情、周期调度和完整投票。验收必须覆盖“收到通知→审批→状态回读”和“重启→定时恢复→只执行一次”。

随后对齐算术验证、违禁词策略、头衔过滤和独立的邀请/退群策略。高级 QQ 网页能力按 SnowLuma 实际实现适配，不提前宣称完成。两批都保留来源声明，群管默认可用、黑名单忽略消息、白名单豁免、独立监听及通知默认开启这些用户已确定的要求。

本报告只形成审查结论和实施顺序，不把未迁移功能计为完成，也不据此修改群管配置或执行处罚。

## 代码证据

本仓库对应入口：[权限与审核](../packages/group-manager/src/index.ts)、[名单](../packages/group-manager/src/lists.ts)、[通知](../packages/group-manager/src/notifications.ts)、[自动规则](../packages/group-manager/src/automation.ts)、[扩展命令](../packages/group-manager/src/features.ts)、[OneBot 调用](../packages/group-manager/src/onebot.ts)。

[Y1]: https://github.com/yeyang52/yenai-plugin/blob/144dd784f81698a696b1c192f7d82219286b2ca5/apps/groupAdmin/groupAdmin.js#L119-L178
[Y2]: https://github.com/yeyang52/yenai-plugin/blob/144dd784f81698a696b1c192f7d82219286b2ca5/lib/common/common.js#L28-L55
[Y3]: https://github.com/yeyang52/yenai-plugin/blob/144dd784f81698a696b1c192f7d82219286b2ca5/model/GroupAdmin.js#L402-L490
[Y4]: https://github.com/yeyang52/yenai-plugin/blob/144dd784f81698a696b1c192f7d82219286b2ca5/apps/groupAdmin/privateGroupAdmin.js#L35-L69
[Y5]: https://github.com/yeyang52/yenai-plugin/blob/144dd784f81698a696b1c192f7d82219286b2ca5/apps/groupAdmin/groupWhiteListCtrl.js#L27-L130
[Y6]: https://github.com/yeyang52/yenai-plugin/blob/144dd784f81698a696b1c192f7d82219286b2ca5/apps/events/message.js#L4-L115
[Y7]: https://github.com/yeyang52/yenai-plugin/blob/144dd784f81698a696b1c192f7d82219286b2ca5/components/Config.js#L105-L110
[Y8]: https://github.com/yeyang52/yenai-plugin/blob/144dd784f81698a696b1c192f7d82219286b2ca5/model/GroupAdmin.js#L271-L323
[Y9]: https://github.com/yeyang52/yenai-plugin/blob/144dd784f81698a696b1c192f7d82219286b2ca5/apps/groupAdmin/groupVote.js#L97-L234
[Y10]: https://github.com/yeyang52/yenai-plugin/blob/144dd784f81698a696b1c192f7d82219286b2ca5/apps/groupAdmin/groupVerify.js#L137-L268
[Y11]: https://github.com/yeyang52/yenai-plugin/blob/144dd784f81698a696b1c192f7d82219286b2ca5/apps/groupAdmin/groupBannedWords.js#L10-L140
[G1]: https://github.com/A1Panda/GroupEntry_Plugin/blob/a88d448a14ddc21477f6320c6e29c9eee4da6e27/apps/notice.js#L33-L190
[G2]: https://github.com/A1Panda/GroupEntry_Plugin/blob/a88d448a14ddc21477f6320c6e29c9eee4da6e27/config/defaultConfig.json
[G3]: https://github.com/A1Panda/GroupEntry_Plugin/blob/a88d448a14ddc21477f6320c6e29c9eee4da6e27/apps/confirm.js#L98-L188
[G4]: https://github.com/A1Panda/GroupEntry_Plugin/blob/a88d448a14ddc21477f6320c6e29c9eee4da6e27/apps/autoQuitCheck.js#L28-L107

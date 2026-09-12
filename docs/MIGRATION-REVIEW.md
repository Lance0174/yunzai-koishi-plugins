# 0.3.0 原逻辑对照与迁移边界

本次逐项检查本地固定快照中的实现文件，没有只根据 README 推断行为。快照提交、作者和许可证见 ../THIRD_PARTY_NOTICES.md。原代码未被当成用户授权去执行远端操作。

| 功能 | 实际读取的原模块 | 原逻辑 | Koishi 0.3.0 |
| --- | --- | --- | --- |
| 直接点播 / 多选 | xiaofei-plugin/apps/点歌.js，music_handle、is_list、page | 普通点播 page=0，多选才设 page=1 并显示列表 | 普通“点歌 关键词”发第一首；搜索 / --列表 才显示列表，数字选曲只在显示列表后生效 |
| 卡片 / 语音 | xiaofei-plugin/apps/点歌.js；rconsole-plugin/apps/songRequest.js、utils/music-platform | 搜索、选曲与发送形式分开 | 卡片 / 语音两种结果，不增加下载命令 |
| 账号入口 | 原点歌模块的 Cookie 保存、刷新与音源调用；NeteaseCloudMusicApi 4.32.0 的 login_qr_key / login_qr_check、util/crypto.js、util/request.js | 四个参考插件的现有配置仍以 Cookie 为主；二维码协议另做核对 | 按本次需求删除音乐 Cookie 设置；新增网易云直接扫码及兼容 API 扫码，账号按 Bot 保存、退出可取消；没有声称原四库已经提供该实现 |
| 用户黑白名单 | yenai-plugin/apps/groupAdmin/groupWhiteListCtrl.js；model/GroupAdmin.js | 原黑名单发言 / 入群会自动踢人、申请会拒绝；白名单参与处罚过滤，并有可选自动解禁 | 按用户指定语义改为黑名单忽略消息，白名单豁免成员处罚和验证；不复制原库“黑名单自动踢人”行为 |
| 群黑白名单 | GroupEntry_Plugin/apps/blacklistManager.js、apps/notice.js、config/defaultConfig.json | 主人维护群名单；邀请黑名单拒绝，白名单可绕过审核及退群门槛 | 新增持久群 / 全局用户 / 本群用户名单；群黑名单忽略消息，群白名单豁免处罚和验证；保留旧邀请策略独立字段 |
| 监听目的地 | yenai-plugin/apps/events/message.js、notice_group.js；lib/common/sendMsgMod.js；GroupEntry_Plugin/apps/notice.js | 椰奶发送给主人；GroupEntry 可发送管理群及 notifyUsers 私聊 | 独立 Notifications，不依赖 moderation、managedGroups 或 reviews；默认私聊管理员，也可配置多群和多私聊 |
| 通知开关 | yenai-plugin/apps/admin/notice.js、config/default_config/notice.yaml | 区分群消息、撤回、邀请、成员、好友等，按默认 / Bot / 群保存；原配置多数默认 false | 按本次需求默认开启事件通知，指令按 Bot 默认 / 本群修改并持久保存；聊天正文单独开关 |
| 群管默认状态 | yenai-plugin/config/default_config/groupAdmin.yaml；apps/groupAdmin；现有迁移 features / automation | 指令注册与各项规则配置分离，处罚依赖角色核验 | 去除必须填写管理群名单的默认门槛；命令全部注册，投票 / 头衔 / 验证默认可用；违禁词、定时、审核答案须有实际规则才能执行 |
| 视频依赖 | rconsole-plugin/utils/ffmpeg-util.js、utils/bilibili.js | 下载与合流调用外部媒体工具 | README 首先给出容器安装命令；启动自检，缺失时在源站请求前失败，可通过诊断重新检测 |
| 合并结果 | rconsole-plugin/apps/tools.js、相关三站工具；Koishi OneBot 6.9.4 MessageEncoder | 有媒体处理和合并消息逻辑，发送协议与 Yunzai 运行时耦合 | 使用 Koishi message-forward 节点，由官方适配器编码为群聊 / 私聊 forward API，包含说明与视频；默认开启 |
| 作者与分发 | 四库 README、package.json 和 LICENSE | 各原项目分别保留作者与许可证；GroupEntry 快照无 LICENSE | 三个包统一改为 yunzai-*；每包 README、usage、THIRD_PARTY_NOTICES 和对应许可原文均可独立查看 |

## 语义说明

黑名单优先于白名单。白名单只提供处罚 / 验证豁免，不授予群管理员、Koishi 管理员或账号管理权限。群管的默认可用不等于跳过真实 OneBot 角色核验。QQ群全员禁言无法单独豁免普通成员；白名单群会阻止本插件对整个群开启禁言。

事件通知使用持久队列。每个事件保存来源群和类型，发送前重新核验收件人及开关；已取消的通知不会在换收件人时转投。关闭群管不关闭监听；没有设置收件人时不影响群管本身。

自动验证默认发验证码，超时只通知，只有显式 --踢出 才移出；投票默认 3 票且 5 分钟有效。审核没有匹配条件时保留人工处理。现有 0.2.0 的规则、名单、任务和审计沿用原数据库标识读取。

## 未迁移与未实机验收

网易云扫码已实现；其它音乐平台当前匿名点歌。音乐推荐、电台、收藏和云盘尚未实现。视频仅三站视频，不含评论卡片、图集、直播或任意站点解析。群管仍未实现人数周期退群、被踢自动拉黑 / 反禁言、幸运字符 / 星级 / 网页统计，以及图片文件的消息恢复。这些不作为“全部功能已迁移”宣传。

ffmpeg/ffprobe、官方适配器和 SQLite 用本地实例验收；网易云扫码标识做了真实服务读取。没有扫描用户真实账号，也没有连接其 SnowLuma / QQ。真实 QQ 合并视频可播放性、平台账号完整歌曲权限仍需在用户运行环境观察。

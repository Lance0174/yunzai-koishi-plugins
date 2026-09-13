# 四参考仓库功能审查与分批迁移计划（2026-09-13）

本轮对 xiaofei-plugin、rconsole-plugin、GroupEntry_Plugin、yenai-plugin 做了固定快照的只读审查，归并四库相似功能，并给出后续分批迁移顺序。与 [GROUP-UPSTREAM-AUDIT-2026-09-13.md](GROUP-UPSTREAM-AUDIT-2026-09-13.md) 互补：该文档逐项对照了承担群管设计的 yenai 与 GroupEntry，本文件补齐 xiaofei 与 rconsole 全貌、跨仓库功能归并和批次规划。未执行原仓库代码，未连接 SnowLuma 或真实 QQ。

## 1. 审查快照与许可

| 仓库 | 快照提交 | 许可证 | 定位 |
| --- | --- | --- | --- |
| [xiaofei-plugin](https://gitee.com/xfdown/xiaofei-plugin) | `c428308`（2026-06-10） | 木兰宽松许可证第 2 版 | 娱乐+查询类，核心是点歌与 QQ 音乐生态 |
| [rconsole-plugin](https://gitee.com/kyrzy0416/rconsole-plugin) | `2f74647`（2026-08-01） | 木兰宽松许可证第 2 版 | 全平台链接解析 + 点歌 + AI 总结 |
| [GroupEntry_Plugin](https://github.com/A1Panda/GroupEntry_Plugin) | `a88d448`（2025-05-22） | 无 LICENSE（仅参考行为，不复制源码） | 机器人被邀请进群的风控与审批 |
| [yenai-plugin](https://github.com/yeyang52/yenai-plugin) | `144dd78`（2026-08-17） | GPL-3.0 | Bot 自管助手 + 群管全套 + 二次元图片资源 |

参考克隆保留在 `za/work/koishi-reference-review/`（此前的 `E:\GitHub\ember-koishi-suite\reference` 中间目录已随项目迁移清理）。

## 2. 四仓库功能画像

**xiaofei-plugin**（apps 10 文件约 4227 行）：四源点歌（QQ/网易/酷我/酷狗）+ B 站音频第 5 源、多选分页图片列表、歌词、高清语音 silk 直传、QQ音乐 ck 自动刷新（QQ/微信双通道）、个性电台/日推/收藏（需 ck）、戳一戳触发点歌；另有天气截图、代发言、机器人违规记录查询、米哈游注册时间/纪念册、通行证 ck 转 stoken。无群管、无链接解析。

**rconsole-plugin**（apps 6 文件约 8186 行 + utils 36 文件约 9000 行）：链接解析覆盖 20+ 平台——B站（WBI 签名/番剧/专栏/动态/直播/AI 总结/BBDown 下载）、抖音（图集/直播切片/BGM/评论）、小红书（xsec_token/图集）、TikTok、Twitter/X、Instagram、Acfun、快手、西瓜、皮皮虾、微博、微视、贴吧、米游社、小黑盒、视频号、Telegram（tdl）、YouTube（yt-dlp）等；点歌三源（网易/酷狗/QQ）+ 网易云云盘上传管理 + B站/网易/酷狗扫码登录；翻译（transmart + DeepLX 多节点）；AI 网页总结（自配 LLM 或腾讯元宝）。无群管。

**GroupEntry_Plugin**（apps 7 文件约 1576 行）：邀请机器人进群四档审核（自动同意/不处理/人工/自动拒绝）+ 引用消息确认、成员申请问答自动审（依赖已失效的第三方等级 API）、退群自动拉黑、人数阈值自动退群（豁免链：黑名单→master→群主/管理→白名单）、群组级黑白名单、定时黑名单清退。无禁言/踢人等日常群管。

**yenai-plugin**（apps 35 文件约 5896 行）：群管全套（批量禁言/踢人、私聊群管、定时禁言 cron、投票禁言/踢人、入群验证、违禁词四类匹配+组合处罚、头衔屏蔽词、幸运字符、群荣誉/群数据、公告、潜水分析）；事件通知体系（消息/撤回/请求/好友群变动，多层开关）；Bot 自管助手（改资料/退群删好友/远程发消息/OCR）；pixiv（HibiAPI + 官方 App API）、setu（lolicon v2）、哔咔、以图搜图（saucenao + ascii2d）、点赞、状态、桌游搜索等。

## 3. 相似功能归并

| 功能域 | xiaofei | rconsole | GroupEntry | yenai | 现有 Koishi 包 | 归并结论 |
| --- | --- | --- | --- | --- | --- | --- |
| 点歌搜索/歌词/音频 | 4+1 源、推荐流 | 3 源、云盘、音质档 | — | — | music-request 0.3.0 | 单一实现点已建立，后续只做增量，不建第二个点歌包 |
| B站/抖音/小红书解析 | — | 三站深度直连 | — | — | video-parser 0.3.4 | 三站视频已覆盖；图集/评论/直播/番剧为增量 |
| 邀请与申请审核 | — | — | 四档模式+引用确认 | 请求通知+审批 | group-manager 0.3.1 | 缺口已在群管审计文档逐项列出 |
| 日常群管（禁言/踢人/名片/撤回/名单） | — | — | — | 全套 | group-manager 0.3.1 | 部分迁移，缺口见审计文档 |
| 事件通知 | — | — | 管理群+私聊指引 | events 全套+多层开关 | Notifications | 已建独立监听；事件详情与编号化是关键缺口 |
| 扫码/登录态 | QQ 音乐 ck 刷新 | B站/网易/酷狗扫码 | — | pixiv refresh_token | 网易云扫码已实现 | 建议沉淀统一"平台账号"模块，避免各批各写一套 |
| 自动撤回自己消息 | 点歌列表超时撤回 | — | — | — | — | 可并入 music-request 配置项 |
| 翻译 | — | transmart+DeepLX | — | fun.js 翻译 | — | 新功能候选（批次 6） |
| 图片类（pixiv/setu/哔咔/识图） | — | — | — | 全套 | — | 高风险单独评估，暂不排批 |

结论：三库重叠的点歌与三站解析已有实现点；GroupEntry 与 yenai 在审核上互补（前者给策略模式与豁免链，后者给请求生命周期与通知）；真正的新增域是解析多平台、翻译/AI 总结、登录态体系和小娱乐指令。

## 4. 独有功能的迁移价值排序

- **高价值、低风险**：事件详情细化与编号化审批（yenai/GroupEntry）、翻译（rconsole）、戳一戳互动、点赞、B 站音频源（xiaofei）、列表超时撤回。
- **高价值、中风险**：多平台链接解析（rconsole，需逐平台直连实现）、AI 网页总结（自配 LLM key）、网易云云盘、自动退群策略（改变机器人覆盖群，须独立可见开关）。
- **暂不迁移**：代发言（伪造他人身份触发全部插件）、`#获取stoken`（明文回显完整 ck）、哔咔（登录态+内容合规）、机器人违规记录（依赖 icqq 专有 GetCode/扫码流程）、幸运字符/群星级/网页统计（QQ 网页接口，SnowLuma 未证实）、问答审核（上游依赖的 kit9.cn 等级 API 已无 SLA）。

## 5. 分批迁移计划

| 批次 | 目标包 | 内容 | 主要来源 | 状态/前置 |
| --- | --- | --- | --- | --- |
| 批次 1 | group-manager 0.3.2 | 统一主人/群管权限模型；私聊指定群号+多目标命令；审核通知编号化、私聊与自定义目标可直接按编号/引用审批；事件具体详情；周期定时（每周/每日+时区）；完整投票（反对票、分功能开关、管理员一票） | yenai + GroupEntry | 对应进行中的群管重构，缺口判定见 [GROUP-UPSTREAM-AUDIT-2026-09-13.md](GROUP-UPSTREAM-AUDIT-2026-09-13.md) |
| 批次 2 | group-manager 0.3.3 | 算术验证+提前提醒+重新验证/绕过/重验批次；违禁词正则与踢/禁/撤组合策略+头衔屏蔽词；邀请四档模式与自动退群独立开关；公告图片（按 SnowLuma 实测能力，先记录 `get_version_info`） | yenai + GroupEntry | 批次 1 验收后 |
| 批次 3 | video-parser 0.4.0 | B站直播/专栏/动态/番剧 + 评论卡片；抖音图集与直播切片；小红书图集；沿用现有 media/queue/net 与官方 CDN 域名检查 | rconsole utils 直连方案 | 现有三站管线已验证，可直接扩展 providers |
| 批次 4 | 新包 yunzai-link-parser（可选） | 快手/西瓜/微视/微博/TikTok/Acfun/YouTube 等增量平台；外部 CLI（yt-dlp/BBDown/tdl）按 ffmpeg 模式做可选探测+安装提示；**不接入**明文 IP 聚合接口（`47.99.158.118`、`jkyai.top` 等） | rconsole | 批次 3 后按需立项；平台逐个验收，不承诺全家桶 |
| 批次 5 | music-request 0.4.0 | B 站音频第 5 源；音质档位；网易云云盘上传/列表；推荐/电台/收藏（依赖 QQ 音乐登录态，先决策是否引入 ck）；统一平台账号模块（扫码体系复用） | xiaofei + rconsole | 批次 1-2 可并行推进 |
| 批次 6 | 独立小功能包（逐个立项） | 翻译（transmart+DeepLX 自配）；戳一戳/点赞；状态/原图/OCR；以图搜图（用户自配 saucenao key，ascii2d 兜底） | rconsole + yenai + xiaofei | 每个功能独立包+独立验收，默认全关 |

每批验收沿用现有口径：本地 `npm test` 全绿、`test:packages` 冒烟、协议能力先对照 SnowLuma action 快照再实机记录 `get_version_info`，来源声明进 THIRD_PARTY_NOTICES。

## 6. 迁移统一红线

1. 只迁移行为设计，不复制上游源码文本；GPL-3.0（yenai）尤其注意，THIRD_PARTY_NOTICES 保留作者/仓库/许可链条。
2. 拒绝清单：明文 HTTP IP 硬编码、`rejectUnauthorized: false`、`git reset --hard` 类更新、代发言、明文回显 Cookie。
3. Cookie/登录态矩阵：抖音/小红书/微博（解析质量）、B站 SESSDATA（高清与登录接口）、网易 MUSIC_U、QQ 音乐 ck（推荐流）、pixiv refresh_token。默认全部匿名可用，登录态只做增量，不经会话明文输出。
4. icqq 专有协议（`sendOidb` 音乐卡片、PttStore 语音直传、silk-wasm）在 OneBot v11/SnowLuma 无对应入口；语音走 record 段或降级文件，卡片用官方 music share 段探测可用性。
5. Yunzai puppeteer 渲染的列表/面板用合并消息或文本替代；确需图片时声明对 `@koishijs/plugin-puppeteer` 的可选依赖。
6. 外部二进制（ffmpeg/ffprobe 已有自动安装模式）新增 yt-dlp/BBDown/tdl 时沿用同一探测、诊断与重试模式。

## 7. 本轮边界

本轮只产出审查与计划：未修改任何包实现、未发布、未执行上游代码、未连接用户服务器。E:\GitHub 项目目录现以本仓库（`E:\GitHub\koishi-plugin-suite`，`yunzai-koishi-plugins` 0.3.x）为准。

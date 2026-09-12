# 迁移来源、作者与许可

本项目将以下 Yunzai 插件的功能设计迁移到 Koishi。请同时关注和支持原项目及其贡献者。此处的 Koishi 包由迁移实现维护，不代表原作者的官方发行。

| 原项目与作者 | 本次使用的功能参考 | 审查快照 | 上游许可 |
| --- | --- | --- | --- |
| [xiaofei-plugin](https://gitee.com/xfdown/xiaofei-plugin)，xfdown / 小飞及贡献者 | 四平台点歌、直接点播与多选列表、卡片和语音 | c428308de95d3b51ef874a1b62efb4b4d8439b1c | MulanPSL-2.0 |
| [rconsole-plugin](https://gitee.com/kyrzy0416/rconsole-plugin)，kyrzy0416 及 R-plugin 贡献者 | 点歌平台接口；B站、抖音、小红书解析、媒体处理与合并消息 | 2f74647778d166b746ac3a72294888f2b7e38917 | MulanPSL-2.0 |
| [yenai-plugin](https://github.com/yeyang52/yenai-plugin)，yeyang52 / yeyang 及贡献者 | 日常群管、黑白名单、验证、投票、独立事件监听与分群通知开关 | 144dd784f81698a696b1c192f7d82219286b2ca5 | GPL-3.0 |
| [GroupEntry_Plugin](https://github.com/A1Panda/GroupEntry_Plugin)，A1Panda / @A1_Panda 及贡献者 | 群邀请审核、管理群与私聊收件人、群黑白名单 | a88d448a14ddc21477f6320c6e29c9eee4da6e27 | 审查快照未见 LICENSE，仅参考行为 |

各包 README 和 Koishi 控制台 usage 均标明直接相关来源。原项目源码、图片、字体及可执行文件未随本包复制分发。Koishi 版本重写了命令、数据库和 OneBot 调用；行为逐项对应说明见源码中的 docs/MIGRATION-REVIEW.md。本包相关的上游许可证文本保留在 licenses/，其权利不会被本项目 LICENSE 覆盖。

本项目自行编写的 Koishi 实现采用 MIT。原参考项目分别保留其自己的许可证，列出作者表示功能来源和致谢，不表示原作者参与或担保了本次迁移。Koishi、OneBot 适配器、https-proxy-agent、ipaddr.js、json5、qrcode 等依赖各自保留原许可。ffmpeg/ffprobe 由运行环境安装，不随插件分发。

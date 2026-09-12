# 来源与许可

本仓库根据用户确认的功能范围独立实现 Koishi 插件。四个参考仓库只用于功能审查，没有复制或分发其插件代码、字体、图片或可执行文件：

| 参考库 | 审查提交 |
| --- | --- |
| https://gitee.com/xfdown/xiaofei-plugin | `c428308de95d3b51ef874a1b62efb4b4d8439b1c` |
| https://gitee.com/kyrzy0416/rconsole-plugin | `2f74647778d166b746ac3a72294888f2b7e38917` |
| https://github.com/A1Panda/GroupEntry_Plugin | `a88d448a14ddc21477f6320c6e29c9eee4da6e27` |
| https://github.com/yeyang52/yenai-plugin | `144dd784f81698a696b1c192f7d82219286b2ca5` |

协议对照：官方 Koishi OneBot 适配器 6.9.4；SnowLuma 提交 `fb5f9b21558134db8803d216dfc19c6bce11f2c0`。不分发 SnowLuma 或修改其源码。外部源站接口来自实际公开响应，并非稳定服务承诺。

本仓库自写源码使用 MIT。npm 运行时依赖 `https-proxy-agent`、`ipaddr.js`、`json5`（仅音乐包）分别保留其自身许可，由包管理器单独安装。Koishi 是 peer dependency；ffmpeg/ffprobe 是用户系统提供的工具，不包含在插件安装包中。

如果后续需要直接迁移上游代码或资源，应单独核实对应文件的许可与再分发条件，不能因本仓库使用 MIT 而重新授权上游内容。

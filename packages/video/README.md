# Yunzai 视频迁移解析 0.3.3

功能来源：[rconsole-plugin](https://gitee.com/kyrzy0416/rconsole-plugin)（kyrzy0416 及 R-plugin 贡献者）。感谢原作者；这是 Koishi 迁移实现，具体来源及许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

包名 `koishi-plugin-yunzai-video-parser`，插件键 `yunzai-video-parser`。仅支持 **B站、抖音、小红书**，可单独安装。缺少 `ffmpeg` / `ffprobe` 时插件默认自动下载并安装；已有工具直接复用，也可配置自定义路径。

直接发链接、BV 号或 QQ JSON 分享卡片即可自动解析，无需“视频解析”或 Koishi 全局前缀。默认适用插件过滤范围内的群和私聊。只识别三站视频，没有匹配链接的消息交还其他插件。

从 0.1.0 升级时，如果旧配置显式保留了 `autoParse: false`，请改为 `true` 或删掉该项以使用新默认值。原 `groups` 留空现在表示全部会话，可填写群号限定范围。

## 自动安装媒体工具

启用插件后先检查配置路径 / PATH 和已缓存的工具，缺少时自动下载到 `data/yunzai-video-parser/tools/`，无需 root 权限、系统包管理器或 npm postinstall。Yarn 禁用了依赖安装脚本也可使用。工具下载和解压使用 Node.js 自带能力，不要求预装 tar、unzip 或 xz。

首次准备在后台进行，不阻塞 Koishi 其它插件。视频进入队列等待安装完成，然后继续解析；安装时间不占视频处理时限。仅预览无需等待媒体工具。`视频解析 诊断` 查看安装进度或在失败后重新尝试，控制台日志也显示进度。

每个下载最多自动重试 3 次，整个准备过程默认最多 10 分钟；下载失败不会开始源站视频请求。下载流与解压输出均限制大小，先检查文件格式和可执行版本，再启用新文件；缓存保存 SHA256，重启时发现损坏会重新下载。取消单个视频不取消其它任务共用的安装，卸载插件会终止下载并清理未完成文件。

固定下载源为 [eugeneware/ffmpeg-static 的 b6.1.1 发布](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1)。支持 Linux x64/ARM64（静态构建，可用于 Alpine）、Windows x64、macOS x64/ARM64。其它平台可填写自行安装的工具路径。网络请求使用插件 `proxy`，也支持 HTTPS_PROXY / HTTP_PROXY。需要数据目录可写、足够磁盘空间及能访问发布源的网络。

Docker 将 Koishi 的 data 目录持久化后，重建容器仍可复用已下载工具。工具的原许可、来源信息和哈希记录一同保存在工具目录内，版权不被本插件 MIT 许可替代。

## 默认合并消息

`forward: true` 默认将标题/作者/来源链接/封面组成第一条节点，视频组成第二条节点，通过 OneBot 的群聊或私聊合并转发接口发送一条消息。预览也使用合并消息。需要普通消息时设置 `forward: false`；非 OneBot 平台按普通消息发送。合并发送失败不自动重复投递或悄悄拆分发送。

## 手动指令

```text
视频解析 BV1GJ411x7h7
视频解析 https://www.bilibili.com/video/BV... -p 2
视频解析 预览 分享链接
视频解析 诊断
视频解析 任务
视频解析 取消 任务编号
```

预览返回标题、作者、原链接和可获得的封面；完整解析还会下载、处理并发送视频。任务列表和取消仅适用于发起任务的用户/Bot/群/会话。

| 平台 | 输入 | 处理方式 |
| --- | --- | --- |
| B站 | BV、av 视频页、b23/bili2233 短链、分 P | 官方 view/playurl；验证官方 CDN，DASH 合流，输出 H.264/AAC MP4 |
| 抖音 | 视频页、v.douyin 分享短链 | 分享页面 JSON 状态，按视频 ID 精确选择 |
| 小红书 | 视频笔记页、xhslink 短链 | 保留分享参数，按笔记 ID 读取页面视频数据 |

图集、图文、直播、动态和文章不在首版范围。验证码、登录限制、失效链接或页面变化会给出错误及原链接，没有万能第三方解析回退，也不会执行网页中的脚本。

## 配置

- `autoParse`：默认开启；`groups` 为空时覆盖插件作用范围内的群与私聊，非空时只处理这些群。
- `autoInstall`：默认开启，自动准备缺少的 ffmpeg/ffprobe。
- `toolDownloadTimeout`：整个工具准备流程超时，默认 600000 毫秒。
- `showProgress`：默认关闭，不发送排队和任务编号提示；开启后显示进度，任务仍可通过“视频解析 任务”查看。
- `biliCookie`、`douyinCookie`、`xhsCookie`：可选登录态；不同账号和访问地区会影响可用性。
- `maxHeight`：默认 720，表示短边像素上限；竖屏按宽度限制。源站可选流不足时可能转码或返回失败。
- `maxVideoMB`：默认 40MB，对下载总量和最终输出都检查。不能在下载限额内取得源文件时停止，不继续下载大文件尝试压缩。
- `concurrency` / `queueSize`：默认 1 个处理中、3 个等待中；相同输入及解析后的相同视频任务去重。
- `timeout`：单次网络/发送默认 25 秒；`jobTimeout`：任务启动后默认 180 秒。
- `cacheMB` / `cacheMinutes`：默认 200MB / 30 分钟，零缓存时每次重新下载。
- `cooldown`：同用户默认 5 秒；`proxy` 为可选 HTTP 代理。

只允许三个站点及对应 CDN，逐跳验证地址，拒绝本地/内网和未知媒体来源。B站优先使用可验证的官方 CDN 备份，不访问未知 PCDN 域名或非常规端口。

每个任务使用独立目录，ffmpeg 不通过 shell 启动且输入只允许 file/pipe；取消/超时会终止子进程并清理。ffprobe 检查视频/音频编码、短边、时长和容器；不发送检测为截断的输出。缓存路径是 Koishi 数据目录下的 `data/yunzai-video-parser/`，按视频、分 P、清晰度和账号配置隔离。程序被操作系统强制杀死时的旧 `job-*` 目录需要停机后清理。

发送失败、超时或取消发生在投递中时，标记“发送结果待核实”，请先检查聊天窗口，不会自动重复发送。

## 验收状态

B站真实无 Cookie 视频已完成下载、合流与 ffprobe 校验。抖音/小红书的短链/页面解析通过受控响应样本，真实分享链接仍待验收。真实 ffmpeg 测试覆盖 DASH 合流、竖屏转码、分段拼接、时长与大小失败、取消和缓存清理。

官方 OneBot 适配器 6.9.4 本地协议确认通过 `send_group_forward_msg` / `send_private_forward_msg` 发送含 `video` 的合并节点。用户的 SnowLuma 版本、真实 QQ 视频播放及三站账号条件尚未验收；B站通过不能代表其他两站通过。

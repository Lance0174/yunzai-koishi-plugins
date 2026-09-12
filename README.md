# Ember Koishi 插件套件

三个独立的 Koishi 4 插件，当前版本 **0.2.0**，目标环境为 Koishi 4.18.11、官方 OneBot v11 适配器和 SnowLuma。每个插件可以单独安装。

| 插件 | npm 包名 | 当前内容 |
| --- | --- | --- |
| [群管理](packages/group-manager/README.md) | `koishi-plugin-ember-group-manager` | 群审核、日常群管、公告精华、定时任务、规则、投票与入群验证 |
| [点歌](packages/music/README.md) | `koishi-plugin-ember-music-request` | 网易云、QQ音乐、酷狗、酷我搜索、选曲、歌词、音乐卡片/语音 |
| [视频解析](packages/video/README.md) | `koishi-plugin-ember-video-parser` | 仅 B站、抖音、小红书；默认直接识别链接/分享卡片、视频发送、预览和取消 |

0.2.0 针对实际使用流程整改：日常禁言/踢人/全员禁言直接执行，新增常用短指令；视频默认无前缀自动解析；点歌支持数字选曲，只提供卡片/语音，不再提供下载命令。本版本提供源码和三个可独立安装的包，尚未推送或发布。

## 安装

Node.js 最低 18.20。

先把需要的 `.tgz` 文件上传到 Koishi 当前运行环境的项目目录。当前终端显示 `/koishi`，以下以视频包已经放在该目录为例。Docker 容器内的路径与宿主机不同；仅上传到宿主机还不够，文件要在容器内可见。

先确认文件存在：

```sh
cd /koishi
ls -lh ./koishi-plugin-ember-video-parser-0.2.0.tgz
```

只有上一步成功列出文件，再执行：

```sh
npm install ./koishi-plugin-ember-video-parser-0.2.0.tgz
```

原本使用 Yarn 的项目改用 `yarn add file:./koishi-plugin-ember-video-parser-0.2.0.tgz`。另外两个包同样先放入项目目录，再按需安装 `./koishi-plugin-ember-group-manager-0.2.0.tgz` 或 `./koishi-plugin-ember-music-request-0.2.0.tgz`。

安装后重启 Koishi 并启用插件。旧示例的 `/path/` 是占位目录；`ENOENT` 表示指定路径下没有文件，伴随的 tarball corrupted 提示不能证明安装包损坏。当前版本尚未发布到 npm/市场。

从 0.1.0 升级时，把旧视频配置的 `autoParse: false` 改成 `true`。重启 Koishi，在插件配置中启用对应插件。群管理需要已有 `database` 服务；视频处理需要服务器上的 `ffmpeg` 和 `ffprobe`。只启用点歌时无需数据库和 ffmpeg。

最少配置：

```yaml
plugins:
  ember-group-manager:
    reviewers: ['你的审核 QQ']
    reviewGroups: ['接收审核通知的群号']
    managedGroups: ['允许群管的群号']
  ember-music-request: {}
  ember-video-parser:
    autoParse: true
    ffmpeg: ffmpeg
    ffprobe: ffprobe
```

上面仅展示新增项，请合并到已有配置，不要覆盖现有 `plugins`。图床插件和历史 Telegram 凭据与这三个插件无依赖关系。

## 验证范围

本地自动验证使用 Koishi 4.18.11、OneBot 适配器 6.9.4、SQLite 驱动 4.7.0 和 Node 24.16.0。覆盖真实 SQLite 的并发/重启、官方适配器 WebSocket 协议、真实 ffmpeg/ffprobe、下载限制、取消与三个 tarball 独立安装。

公开服务实测：四个平台搜索和歌词有成功样本；网易云、酷我下载音频成功；QQ音乐、酷狗当前测试歌曲没有返回可用音源。B站真实视频完成下载、合流和 ffprobe 检查。抖音、小红书当前通过受控响应样本，仍需真实分享链接与用户环境验收。

**没有连接用户的 SnowLuma 服务器或发送真实 QQ 消息。** 模拟协议成功不能代替实际音频、视频播放和群管效果。完整证据、错误与修复见 [开发报告](DEVELOPMENT.md)。

## 开发

```sh
npm ci
npm test
npm run pack:all
```

测试机器需要 ffmpeg/ffprobe，可用 `FFMPEG`、`FFPROBE` 环境变量指定路径。安装包和 SHA256SUMS 输出到 `artifacts/packages/`。

```sh
# 三个包分别装入独立的 Koishi 4.18.11 项目并检查命令注册
npm run test:packages

# 可选的只读公开接口检查；不向 QQ 发消息
node scripts/live-probe.cjs
node scripts/live-video.cjs
```

上述实时检查可临时设置 `PROBE_PROXY`；代理、Cookie 不写入源码或证据文件。网络变化、登录权限和地区限制会影响结果。

尚未实现的范围包括周期自动退群、反禁言/退群拉黑、幸运字符/星级/网页统计、音乐推荐/云盘和视频评论卡片。参考仓库及独立实现边界见 [来源说明](THIRD_PARTY_NOTICES.md)。

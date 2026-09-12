# Ember Koishi 插件套件

三个独立的 Koishi 4 插件，当前版本 **0.1.0**，目标环境为 Koishi 4.18.11、官方 OneBot v11 适配器和 SnowLuma。每个插件可以单独安装。

| 插件 | npm 包名 | 基础版内容 |
| --- | --- | --- |
| [群管理](packages/group-manager/README.md) | `koishi-plugin-ember-group-manager` | 群邀请/成员申请审核、事件通知、基础群管 |
| [点歌](packages/music/README.md) | `koishi-plugin-ember-music-request` | 网易云、QQ音乐、酷狗、酷我搜索、选曲、歌词、音频/卡片/下载 |
| [视频解析](packages/video/README.md) | `koishi-plugin-ember-video-parser` | 仅 B站、抖音、小红书；预览、视频下载、合流/转码、发送和取消 |

这是首个本地验收版。三个 npm 名称在 2026-09-12 查询均为未注册；**本次没有发布到 npm、Koishi 市场或 GitHub**。用下文的 tarball 安装方式测试，不要按市场已上架处理。

## 安装

Node.js 最低 18.20，推荐使用仍受支持的 Node LTS。保留现有 Koishi 和 OneBot 连接配置。在自己的 Koishi 项目目录中安装需要的包，路径换成收到的文件：

```sh
# Yarn 管理的 Koishi 项目：
yarn add file:/path/koishi-plugin-ember-group-manager-0.1.0.tgz
yarn add file:/path/koishi-plugin-ember-music-request-0.1.0.tgz
yarn add file:/path/koishi-plugin-ember-video-parser-0.1.0.tgz

# npm 管理的项目使用 npm install /path/相应文件.tgz
```

重启 Koishi，在插件配置中启用对应插件。群管理需要已有 `database` 服务；视频处理需要服务器上的 `ffmpeg` 和 `ffprobe`。只启用点歌时无需数据库和 ffmpeg。

最少配置：

```yaml
plugins:
  ember-group-manager:
    reviewers: ['你的审核 QQ']
    reviewGroups: ['接收审核通知的群号']
    managedGroups: ['允许群管的群号']
  ember-music-request: {}
  ember-video-parser:
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

高级群管、音乐推荐/云盘及评论卡片留在原包后续迭代，未作为已完成功能交付。参考仓库及独立实现边界见 [来源说明](THIRD_PARTY_NOTICES.md)。

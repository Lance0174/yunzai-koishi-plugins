# Yunzai 点歌迁移 · Koishi 0.3.0

功能来源：[xiaofei-plugin](https://gitee.com/xfdown/xiaofei-plugin)（xfdown / 小飞及贡献者）、[rconsole-plugin](https://gitee.com/kyrzy0416/rconsole-plugin)（kyrzy0416 及 R-plugin 贡献者）。网易云扫码协议参考 NeteaseCloudMusicApi / Binaryify 及贡献者（MIT）。感谢原作者；这是 Koishi 迁移实现，完整作者与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

包名 `koishi-plugin-yunzai-music-request`，插件键 `yunzai-music-request`。适用于 Koishi 4.18.11 和 OneBot v11，无需群管插件、数据库或 ffmpeg。

## 默认直接发送第一首

```text
点歌 晴天
点歌 晴天 -p QQ
点歌 晴天 --语音
点歌 晴天 --卡片
点歌 搜索 晴天
点歌 晴天 --列表
点歌 列表
点歌 下一页
点歌 上一页
点歌 卡片 2
点歌 语音 2
点歌 歌词 2
点歌 取消
```

普通点歌搜索后直接发送第一首，默认音乐卡片；配置 `output: voice` 可改为语音。`点歌 搜索` 或 `--列表` 才显示选曲列表，查看列表后可以回复序号选歌。直接点播后不会把无关数字聊天当成选歌。

默认网易云，另有 QQ音乐、酷狗、酷我；每页 5 首，最多 4 页，会话默认 10 分钟，按用户、机器人、群和私聊隔离。没有下载命令或上传群文件操作。网易云、具有数值歌曲 ID 的 QQ音乐使用原生音乐卡片；酷狗、酷我使用自定义音乐卡片，需要可播放音源。语音通过 OneBot record 发送。

## 扫码登录

设置页不提供 QQ、网易云或酷狗 Cookie 输入，也不接受聊天粘贴 Cookie。网易云可直接扫码，不需要另行搭建 API：

```text
点歌 登录 网易云
点歌 账号
点歌 退出登录 网易云
```

以上账号指令仅在私聊可用，调用者须在 `loginAdmins` 中，或拥有 Koishi 权限等级 4 及以上。机器人发送二维码，使用网易云 App 扫描并确认；轮询每 2.5 秒一次，3 分钟过期。取消/退出登录会中止轮询，迟到的响应不会重新绑定账号。

账号用于当前机器人，按平台和机器人 ID 隔离。登录结果写入 Koishi 数据目录 `data/yunzai-music-request/accounts.json`，新建文件权限为 0600；不回显登录凭据，不写入插件配置或日志。状态指令显示是否保存了登录态，不能保证源站会话永不过期。退出登录会移除本地账号。

当前扫码支持网易云。QQ音乐、酷狗、酷我使用匿名点歌。可播放歌曲和音质仍由平台及账号权限决定。

## 可选配置

- `output`：card / voice，默认 card。
- `defaultPlatform`：netease / qq / kugou / kuwo。
- `loginAdmins`：允许管理音乐账号的 QQ 列表。
- `neteaseApi`：可选兼容 API，需支持 `/search`、`/song/url/v1`、`/lyric`；扫码还需 `/login/qr/key` 和 `/login/qr/check`。留空直接访问网易云。变更 API 地址后需要重新扫码，旧登录态不会转交给新服务。
- `kugouApi`：可选搜索和音源 API，当前不接收账号 Cookie。
- `maxAudioMB` / `maxConcurrent` / `cooldown`：默认 25MB / 2 / 1500ms。
- `timeout` / `proxy`：默认 20 秒；可选 HTTP 代理。

`-q standard/标准`、`high/高`、`lossless/无损` 选择请求音质，适用于语音；音源权限不足会明确失败。账号登录不改变版权或会员权限。取消、超时和卸载会中止网络任务。

0.3.0 验证包含真实网易云扫码标识获取，以及本地完整扫码状态、确认、账号保存、退出、过期和迟到响应测试；没有替用户登录真实账号或发送真实 QQ 消息。

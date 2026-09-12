# Ember 点歌

Koishi 4 插件，支持网易云、QQ音乐、酷狗、酷我。无需群管理或视频解析插件。

## 指令

```text
点歌 晴天 -p 网易云
点歌 搜索 晴天 -p QQ
点歌 列表
点歌 下一页
点歌 上一页
点歌 播放 1
点歌 播放 1 --卡片
点歌 播放 1 -q high
点歌 下载 1
点歌 歌词 1
点歌 取消
```

默认网易云，每页 5 首，一次最多 4 页。列表序号是本次搜索中的全局序号，翻页后仍保持编号。选曲会话按平台、Bot、群、频道和用户隔离，默认 10 分钟过期。

音频默认发送 OneBot `record` 段；`--卡片` 发送自定义音乐卡片。`下载` 在 OneBot 下使用 `download_file` 和 `upload_group_file` / `upload_private_file` 扩展，需要协议端支持。其他适配器使用 Koishi 音频/文件元素，具体客户端支持程度不同。

## 音源配置

| 平台 | 默认方式 | 可选账号/服务 |
| --- | --- | --- |
| 网易云 | 公开搜索、歌词、外链音源 | `neteaseApi`、`neteaseCookie` |
| QQ音乐 | QQ搜索、vkey、歌词 | `qqCookie` |
| 酷狗 | msearch 搜索、公开 playInfo、歌词 | `kugouApi`、`kugouCookie` |
| 酷我 | search.kuwo.cn 搜索、标准音源、歌词 | 当前不支持账号音源配置 |

可选网易云 API 须实现 POST 表单 `/search`（keywords/limit/type）、`/song/url/v1`（id/level）、`/lyric`（id）；响应遵循常用网易云 API 的 `result.songs`、`data[].url`、`lrc.lyric` 格式。酷狗 API 须实现 POST `/search`（keywords/pagesize）和 `/song/url`（hash/quality），分别返回 `data.info` 或 `data.lists`、`url` 或 `data.url`。Cookie 通过 POST 表单传给管理员明确配置的 API 服务，不放进 URL。

`standard` / `标准`、`high` / `高`、`lossless` / `无损` 用于请求音源允许的音质。网易云和酷狗高音质需要配置兼容 API 和具有相应权限的账号；QQ音乐依赖上游返回权限；酷我首版仅标准音质。请求音质不等于取得会员权限，缺少音源时明确报错。

2026-09-12 无登录态实测：四个平台均有搜索/歌词成功样本；网易云、酷我下载成功；QQ音乐、酷狗测试歌曲未提供可用音源。自建 API、高/无损及真实 QQ 播放尚未验收。此状态不代表其他歌曲、账号或地区的可用性。

## 资源限制

默认单音频 25MB、并发 2、同用户间隔 1500ms，支持取消和卸载中止网络读取。`timeout` 默认 20 秒，`proxy` 可配置 HTTP 代理。API、Cookie、代理在 Koishi 控制台配置；Cookie/代理字段按 secret 显示。

下载逐跳检查平台域名、DNS/IP 和大小；Cookie/Authorization 不跨来源跳转。管理员配置的 API 地址可指向自己的内网服务，该例外不会用于媒体地址。发送失败或超时不自动重复投递。

首版不含每日推荐、私人电台、收藏和云盘。

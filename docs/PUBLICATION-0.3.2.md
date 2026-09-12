# Koishi 插件市场发布记录 · 2026-09-13

发布账号已通过 npm `whoami` 实时确认：`emberknight`。正式上传随后被拒绝，账户校验返回 E401，已启动 npm 官方网页登录等待刷新授权。群管理、点歌发布 0.3.0，视频发布 0.3.2，标注“开发中”。发布使用公共 npm registry 的 `latest` 标签；视频的开发状态由 `koishi.preview: true` 和可见说明表达。

## 发布状态

| 插件 | 版本 | npm | Koishi 索引 |
| --- | --- | --- | --- |
| koishi-plugin-yunzai-group-manager | 0.3.0 | 待发布 | 待验证 |
| koishi-plugin-yunzai-music-request | 0.3.0 | 待发布 | 待验证 |
| koishi-plugin-yunzai-video-parser | 0.3.2 | 待发布 | 待验证；开发预览 |

## 视频开发标识

从官方 `@koishijs/registry@7.0.3` npm 源码核实：`src/types.ts` 的 `Manifest.preview` 与 `src/utils.ts` 的 `conclude()` 会读取 `package.json` 中的 `koishi.preview`。已设置为 `true`，并在包 description、中文 Koishi description、README 顶部和导出的 usage 中明确写入“开发中”。迁移来源及原作者、许可证继续随包提供。

## 验证和安装包

三个包的 TypeScript 构建与实际 tgz 发布 dry-run 均通过。升级脚本对应的两项现有测试通过。每个最终包均检查了入口、版本、README、来源及许可证；视频包的开发标识检查通过。

群管与点歌 tgz 与上一轮已经独立安装验证的文件字节一致。视频只变更版本与说明，没有变更解析和媒体工具自动安装逻辑；新视频包已在独立 Koishi 4.18.11 项目中安装通过，入口加载、默认配置、命令注册与关闭检查均通过，见 artifacts/package-smoke-video-0.3.2.log。

| 包 | SHA256 |
| --- | --- |
| koishi-plugin-yunzai-group-manager-0.3.0.tgz | `4cb6fe65ed80d6e4df5b02fe02ebe8f0cd45508ad52882b810612cf9b3e7eb74` |
| koishi-plugin-yunzai-music-request-0.3.0.tgz | `1c684901d0737c140c822ff241b6a467f20555235df84c449f824d1a7be78652` |
| koishi-plugin-yunzai-video-parser-0.3.2.tgz | `66c24982dcba715e0191228a17c78a003d7988722caa247f828bd21651d1c48c` |

发布完成后，在 Koishi 项目目录运行：

```sh
cd /koishi
yarn add koishi-plugin-yunzai-group-manager@0.3.0 koishi-plugin-yunzai-music-request@0.3.0 koishi-plugin-yunzai-video-parser@0.3.2
```

从 `ember-*` 迁移还需替换配置键，按根 README 使用带备份的升级脚本。已启用新包名的用户可以直接更新。视频默认自动安装缺少的 ffmpeg/ffprobe。

## 本轮实际问题

| 问题 | 处理与当前状态 |
| --- | --- |
| Koishi 官方发布文档返回 HTTP 403 | 从官方 registry 的 npm 发布包读取类型与源码，确认 preview 字段 |
| 最初按猜测路径读取官方 market 的两个中文语言文件返回 404 | 不依赖这些路径；以成功取得的官方 registry 源码为字段依据 |
| 一次本地搜索指定了不存在的根 CHANGELOG.md 与 PowerShell 不展开的路径通配符 | 改为读取实际存在的文件；构建与打包已通过 |
| 发布前通过代理读取 registry.koishi.chat/index.json 重定向后返回 HTTP 403，另一次代理请求出现 SSL EOF | 改为直接读取官方索引，HTTP 200，取得 4640 条记录；发布前没有这三个包 |
| 首次 npm 正式上传遇到 ECONNRESET / TLS 建立前断开 | 回读公共 npm 确认包仍为 404 后重试，避免误报发布成功 |
| 第二次 npm 上传返回 PUT E404，进一步 npm profile get 返回 E401 并要求重新登录 | 不改名规避；启动官方 npm login 网页流程，等待账号持有人完成 CLI 验证 |
| 新视频包独立安装显示上游 @koa/router@10.1.1 的 deprecated 提示 | 属于现有 Koishi 依赖树；安装和加载成功，未改动宿主版本 |

## 验收边界

上一轮完整 97/97 测试、三个包的独立安装及媒体工具 Windows 实际下载运行证据见 [0.3.1 开发报告](history/DEVELOPMENT-0.3.1.md)。本轮只针对发布和开发标识执行检查。没有连接用户的 SnowLuma 服务器或向真实 QQ 发送消息；抖音、小红书的真实分享链接和 QQ 视频播放仍待验收。

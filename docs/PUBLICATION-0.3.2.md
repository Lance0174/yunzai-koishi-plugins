# Koishi 插件市场发布记录 · 2026-09-13

本文件保留初次发布过程。三个初版已成功发布到 npm 并回读校验，最终开发标记和 GitHub Release 版本见 [0.3.3 发布记录](PUBLICATION-0.3.3.md)，仅群管理开发中。

发布账号已通过 npm `whoami` 实时确认：`emberknight`。旧会话正式上传被拒绝后，现已通过 npm 官方网页刷新登录，三个初版均已完成发布验证。群管理、点歌发布 0.3.0，视频发布 0.3.2，标注“开发中”。发布使用公共 npm registry 的 `latest` 标签；视频的开发状态由 `koishi.preview: true` 和可见说明表达。

## 发布状态

| 插件 | 版本 | npm | Koishi 索引 |
| --- | --- | --- | --- |
| koishi-plugin-yunzai-group-manager | 0.3.0 | 已发布并回读 | 待验证 |
| koishi-plugin-yunzai-music-request | 0.3.0 | 已发布并回读 | 待验证 |
| koishi-plugin-yunzai-video-parser | 0.3.2 | 已发布并回读 | 待验证；开发预览 |

## 视频开发标识

从官方 `@koishijs/registry@7.0.3` npm 源码核实：`src/types.ts` 的 `Manifest.preview` 与 `src/utils.ts` 的 `conclude()` 会读取 `package.json` 中的 `koishi.preview`。已设置为 `true`，并在包 description、中文 Koishi description、README 顶部和导出的 usage 中明确写入“开发中”。迁移来源及原作者、许可证继续随包提供。

## 验证和安装包

三个包的 TypeScript 构建与实际 tgz 发布 dry-run 均通过。升级脚本对应的两项现有测试通过。每个最终包均检查了入口、版本、README、来源及许可证；视频包的开发标识检查通过。

群管与点歌的功能文件与上一轮独立安装验证的包逐文件一致。新视频包的入口加载、默认配置、命令注册与关闭检查已在独立 Koishi 4.18.11 项目中通过，见 artifacts/package-smoke-video-0.3.2.log。用户追加 GitHub 发布要求后，三个包仅在 package.json 中补充 repository / homepage / bugs 链接，再次构建和发布 dry-run 通过；包内其余文件与这些已验证包完全一致，逐文件证据见 artifacts/github-metadata-validation.json。

| 包 | SHA256 |
| --- | --- |
| koishi-plugin-yunzai-group-manager-0.3.0.tgz | `20bfb79ce5d0c1c4332ccf3fbaea8256f5b5d8bf98be8c55bf9d7339b991252c` |
| koishi-plugin-yunzai-music-request-0.3.0.tgz | `acb82971d6e333924287f3289d9248aaa0a62e7fc37ff8425a0d5f1113082c8c` |
| koishi-plugin-yunzai-video-parser-0.3.2.tgz | `966e4301f425bb1e3cb9a69e0fa4315200b79c97b353df5b4cd812276276e53b` |

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

| 旧 npm 登录链接过期；重新生成时首次请求发生 ECONNRESET | 重试取得新官方链接，用户完成授权，CLI 已确认登录成功 |
| GitHub CLI 多次出现 TLS 握手超时 / EOF；未登录的公共 API 查询触发限流 403 | 使用已登录 gh 做只读确认；在单次进程内调整连接方式后恢复，没有修改全局代理或账号安全设置 |
| 创建 GitHub 仓库的首次 POST 返回 EOF | 先回读确认仓库仍为 404，再重试创建，最终成功创建 Lance0174/yunzai-koishi-plugins |

## GitHub 发布

源码仓库：[Lance0174/yunzai-koishi-plugins](https://github.com/Lance0174/yunzai-koishi-plugins)。已为三个 npm 包添加对应源码目录、README 和问题反馈链接。GitHub Actions 将在 Ubuntu / Node.js 22 上执行完整现有测试、打包与三个独立 Koishi 4.18.11 安装检查。源码先推送用于运行 CI；本批次随后更正开发标记并升级为 v0.3.3 Release，最终结果见对应发布记录。

GitHub Release 将分别提供群管理与点歌 0.3.0、视频 0.3.2（开发中）、完整源码 ZIP、迁移脚本及 SHA256 校验文件。

## 验收边界

上一轮完整 97/97 测试、三个包的独立安装及媒体工具 Windows 实际下载运行证据见 [0.3.1 开发报告](history/DEVELOPMENT-0.3.1.md)。本轮只针对发布和开发标识执行检查。没有连接用户的 SnowLuma 服务器或向真实 QQ 发送消息；抖音、小红书的真实分享链接和 QQ 视频播放仍待验收。

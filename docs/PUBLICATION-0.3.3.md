# Koishi 与 GitHub 发布记录 · 2026-09-13

最终发布状态为：**仅群管理开发中**，点歌和视频正常发布。每个 npm 包均保留原作者和迁移来源，提供 GitHub 源码、对应 README 与问题反馈入口。

| 包 | 版本 | 开发状态 | npm |
| --- | --- | --- | --- |
| koishi-plugin-yunzai-group-manager | 0.3.1 | 开发中，preview=true | 已发布并回读 |
| koishi-plugin-yunzai-music-request | 0.3.0 | 普通发布 | 已发布并回读 |
| koishi-plugin-yunzai-video-parser | 0.3.3 | 普通发布 | 已发布并回读 |

已从 npm 回读三个版本、latest、中文说明与开发标记，并下载远端 tgz，三个 SHA256 均与本地最终安装包一致。

Koishi 官方索引已收录三个最终版本，群管 preview=true、视频 preview=false，点歌无开发标记。核查时间：2026-09-12T18:06:17.084875+00:00；索引生成时间：Sat, 12 Sep 2026 18:05:26 GMT。源码仓库为 [Lance0174/yunzai-koishi-plugins](https://github.com/Lance0174/yunzai-koishi-plugins)，GitHub Release 批次为 v0.3.3。

## 发布内容

群管理 0.3.1 的 package description、Koishi 中文说明、README 顶部、usage 均明确标注“开发中”，并设置 `koishi.preview: true`。视频 0.3.3 移除这些开发标识，显式设置 `koishi.preview: false`。点歌 0.3.0 保持普通版本。

视频默认自动安装缺少的 ffmpeg / ffprobe、默认合并转发等功能保留。群管功能默认开启、黑白名单、独立事件监听，以及点歌默认首曲 / 卡片 / 语音 / 网易云扫码行为均保留。本次修订仅调整开发状态和对应版本，已经逐文件检查运行代码与前一 npm 版本一致，只有 usage、声明、说明和包元数据改变。

## 验证

- 三个 TypeScript 包构建通过，修正版两个实际 tgz 的 npm 发布 dry-run 通过。
- 升级脚本现有 2 项回归测试通过；版本映射为群管 0.3.1、点歌 0.3.0、视频 0.3.3。
- 逐文件核对保留作者、来源、许可证；仅群管使用开发预览标记。证据见 artifacts/development-marker-validation-0.3.3.json。
- 最终代码提交 `72c8013f346ecaf01c4a8db0bad4d8f7ba7a2f96` 的 [GitHub Actions](https://github.com/Lance0174/yunzai-koishi-plugins/actions/runs/34710044129) 已通过 **97/97 测试，0 失败、0 跳过**，三个包构建、打包及独立 Koishi 4.18.11 安装全部通过。发布提交只补充本文和 DEVELOPMENT.md 的验证记录，运行源码、依赖、脚本与此 CI 提交相同。
- 本地此前新视频包独立安装及完整 97/97 测试证据，见 [0.3.1 开发报告](history/DEVELOPMENT-0.3.1.md)；不将这些历史测试表述为本次新运行。

| 最终安装包 | SHA256 |
| --- | --- |
| koishi-plugin-yunzai-group-manager-0.3.1.tgz | `2ce3f893cdb7f1516f7a315df0a57fa4190246c2de6179f4ef0f44938e75405b` |
| koishi-plugin-yunzai-music-request-0.3.0.tgz | `acb82971d6e333924287f3289d9248aaa0a62e7fc37ff8425a0d5f1113082c8c` |
| koishi-plugin-yunzai-video-parser-0.3.3.tgz | `7bbe2aaea1e42aa4003f2691f360fbe6b65339aaf82d1133bd26fdd4b24d888e` |

## 安装

```sh
cd /koishi
yarn add koishi-plugin-yunzai-group-manager@0.3.1 koishi-plugin-yunzai-music-request@0.3.0 koishi-plugin-yunzai-video-parser@0.3.3
```

安装后重启 Koishi。从旧 ember-* 包迁移时按根 README 执行带备份的迁移脚本，并同时更改包名与 Koishi 配置键。群管在市场中属于开发预览，若使用隐藏开发预览的筛选条件，需调整筛选。

## 实际问题与处理

前次登录过期、npm 连接重置、GitHub API 超时与限流的记录保留在 [0.3.2 发布过程记录](PUBLICATION-0.3.2.md)。通过 npm 官方网页刷新登录，按 npm 对每个包 / 版本的实际要求完成安全验证，没有更改账号安全设置。

GitHub 源码首次直连推送未能连接 github.com:443，改为单次 git 命令使用已配置的本机代理后成功；没有修改全局网络设置。

旧 npm 版本已经发布，开发状态修正使用新 patch 版本，随后核对 latest 指向，不覆盖或删除已发布版本。GitHub [v0.3.3 Release](https://github.com/Lance0174/yunzai-koishi-plugins/releases/tag/v0.3.3) 只提供本表版本，附完整源码、迁移脚本、安装说明、发布清单和 SHA256SUMS。发布清单记录源码提交、CI 提交、npm 远端校验与市场索引证据。

## 验收范围

GitHub CI 使用 Ubuntu / Node.js 22，宿主为 Koishi 4.18.11，包含实际 ffmpeg 媒体处理和独立包安装。真实 SnowLuma 服务器、QQ 消息投递与视频播放没有在本轮执行；各平台实际接口和账号条件的边界保留在对应 README。

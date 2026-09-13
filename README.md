# Yunzai → Koishi 功能迁移插件

当前版本：群管理 0.3.1（开发中）、点歌 0.3.0、视频解析 0.3.4。仅群管理使用 Koishi 市场开发预览标记。

[源码仓库](https://github.com/Lance0174/yunzai-koishi-plugins) · [GitHub Releases](https://github.com/Lance0174/yunzai-koishi-plugins/releases) · [问题反馈](https://github.com/Lance0174/yunzai-koishi-plugins/issues)

感谢 [小飞 / xfdown](https://gitee.com/xfdown/xiaofei-plugin)、[R-plugin / kyrzy0416](https://gitee.com/kyrzy0416/rconsole-plugin)、[椰奶 / yeyang52](https://github.com/yeyang52/yenai-plugin)、[GroupEntry / A1Panda](https://github.com/A1Panda/GroupEntry_Plugin) 及各项目贡献者提供的原功能设计。这里是面向 Koishi 4.18.11、OneBot v11 / SnowLuma 的迁移实现。每个安装包均附作者、原仓库和许可证说明，Koishi 控制台也显示来源。

| 独立插件 | 包名 | 默认行为 |
| --- | --- | --- |
| [群管理（开发中）](packages/group-manager/README.md) | koishi-plugin-yunzai-group-manager | 所有群可用，黑名单忽略、白名单豁免；独立事件监听默认私聊管理员，通知用指令开关 |
| [点歌](packages/music/README.md) | koishi-plugin-yunzai-music-request | 搜索后直接发送第一首，可选择卡片/语音；不开放 Cookie 输入；网易云私聊扫码 |
| [视频解析](packages/video/README.md) | koishi-plugin-yunzai-video-parser | 三站裸链接/卡片自动识别，自动安装缺少的 ffmpeg/ffprobe，默认合并消息 |

0.3.0 去除了旧 Ember 用户名称前缀。升级必须同时替换 npm 依赖和 Koishi 插件键；不要同时启用新旧包。数据库表仍保留旧内部标识以读取 0.2.0 的审核、名单、任务与审计记录。

## 安装与升级

在 Koishi 插件市场搜索 `yunzai-group-manager`、`yunzai-music-request`、`yunzai-video-parser`。群管理是开发预览版本，如果市场设置隐藏了开发预览插件，请调整筛选条件。npm 发布后市场索引可能需要时间同步，发布和收录的实际状态见 [发布记录](docs/PUBLICATION-0.3.4.md)。

也可以在 Koishi 项目目录用 Yarn 从 npm 安装或更新，无需上传 tgz：

```sh
cd /koishi
yarn add koishi-plugin-yunzai-group-manager@0.3.1 koishi-plugin-yunzai-music-request@0.3.0 koishi-plugin-yunzai-video-parser@0.3.4
```

从旧 `ember-*` 插件迁移时，先使用下面的迁移脚本处理包名和配置键。离线安装或迁移时，将群管 0.3.1、点歌 0.3.0 和视频 0.3.4 的三个 tgz 及 `升级迁移.cjs` 放入 **Koishi 容器的 /koishi 目录**。媒体工具由视频插件自动安装。已安装旧版本的 Yarn 项目执行：

```sh
cd /koishi
node ./升级迁移.cjs --write
yarn install
```

脚本只在本地修改 package.json 与 koishi.yml / koishi.yaml / koishi.json，先验证新安装包存在，再创建权限受限的备份。它替换包名及插件键、移除旧音乐 Cookie 和 managedGroups 字段；如果仍有缺失的图床插件 file 依赖，会替换为已发布的 0.1.2。保留 Koishi 4.18.11、auto-mas 和其它插件版本。`auto-mas@0.0.2` 的精确 peer 版本警告仍可能存在；安装过程统一使用 Yarn。

使用本地安装包新安装时：

```sh
cd /koishi
yarn add ./koishi-plugin-yunzai-group-manager-0.3.1.tgz ./koishi-plugin-yunzai-music-request-0.3.0.tgz ./koishi-plugin-yunzai-video-parser-0.3.4.tgz
```

成功后重启 Koishi。群管理需要 database 服务；`reviewers` 填写管理员 QQ 以接收默认事件监听。点歌无需数据库，扫码权限通过 `loginAdmins` 或 Koishi 权限等级 4 及以上授予。源码中的升级脚本是 `scripts/upgrade.cjs`，交付包内提供中文文件名副本。

已启用 yunzai 包的用户可更新群管和视频：`yarn add koishi-plugin-yunzai-group-manager@0.3.1 koishi-plugin-yunzai-video-parser@0.3.4`，然后重启 Koishi；首次缺工具时自动下载，无需先执行 apk 或 apt。

完整参数和指令见各插件 README。[来源和许可](THIRD_PARTY_NOTICES.md)、[原逻辑对照](docs/MIGRATION-REVIEW.md)、[开发报告](DEVELOPMENT.md)。

## 开发与验证

Node.js 最低 18.20；开发验证宿主为 Koishi 4.18.11。

```sh
npm ci
npm test
npm run pack:all
npm run test:packages
```

媒体测试需要 PATH 中的 ffmpeg/ffprobe，也可设置 FFMPEG、FFPROBE。三个真实安装包分别安装到独立 Koishi 项目验收；报告区分本地协议、公开接口与真实 QQ 的验证范围。公开发布状态见 [发布记录](docs/PUBLICATION-0.3.4.md)。

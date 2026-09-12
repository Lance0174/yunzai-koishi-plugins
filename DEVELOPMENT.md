# npm / Koishi 插件市场发布与视频开发标识

群管理与点歌采用已验收的 0.3.0，视频更新为 0.3.2，在 npm 包说明、Koishi 市场元数据、README 和控制台中明确标为“开发中”。视频启用官方 `koishi.preview` 标记，媒体工具自动安装和默认合并转发行为保持原版本实现。

发布过程、当前 npm 与市场索引状态、最终安装包哈希和本轮实际问题见 [发布记录](docs/PUBLICATION-0.3.2.md)。npm 发布和市场收录分别回读验证。

本轮三个 TypeScript 包构建与实际 tgz 发布 dry-run 通过；升级脚本两项现有测试通过。每个安装包已检查来源、作者与许可。群管、点歌功能文件与上一轮一致；新视频包的 Koishi 4.18.11 独立安装、加载、命令和默认配置检查均通过。三个包随后补充了用户要求的 GitHub 源码链接，逐文件确认仅 package.json 的 repository / homepage / bugs 变化，最终发布包另行记录 SHA256。

上一轮完整功能实现、97/97 测试、Windows 真实媒体工具下载运行、Linux ELF 静态检查和真实 Yarn 升级报告保存在 [0.3.1 开发报告](docs/history/DEVELOPMENT-0.3.1.md)。没有把这些历史测试写成本轮重新运行，也没有把协议和本地测试写成 SnowLuma / QQ 实机验收。

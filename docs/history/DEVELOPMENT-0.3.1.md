# 视频 0.3.1：自动安装媒体工具

本轮补齐缺少 ffmpeg/ffprobe 时的自动安装；群管与点歌保持 0.3.0，两个安装包的哈希与此前交付一致。此前完整报告保存在 docs/history/DEVELOPMENT-0.3.0.md。

## 实现结果

- autoInstall 默认开启。先使用配置路径 / PATH 和有效缓存，缺少的工具自动下载到 data/yunzai-video-parser/tools，无需 root、apk、apt、tar、unzip 或 npm postinstall。
- 固定使用 eugeneware/ffmpeg-static 的 b6.1.1 发布，支持 Linux x64 / ARM64、Windows x64、macOS x64 / ARM64；Linux 使用无动态加载器的静态构建。下载器自行实现，不执行上游 npm 安装脚本。
- 启动后后台准备，不阻塞 Koishi 启动；排队视频等待工具就绪后继续，准备耗时不占视频处理时限。诊断可查看进度和重试，既有默认合并转发保留。
- 下载最多 3 次尝试、递增重试间隔、整体默认 10 分钟限时。流式下载和 gzip 解压均限制大小，检查可执行文件头和版本后才启用。缓存记录 SHA256，损坏后重新下载；取消单个视频不会取消其它视频共用的安装，卸载会终止下载并清理未完成文件。
- 包内和安装后的工具目录均保留 FFmpeg 原许可与来源信息。所有原插件作者和迁移来源继续保留在 README、usage 和 NOTICE。
- 升级脚本识别群管 / 点歌 0.3.0 与视频 0.3.1 的组合，保留既有配置备份、失效图床 file 依赖修复和包名迁移。

## 最终验证

- npm test：97 项通过，0 失败，0 跳过，三个 TypeScript 包构建通过。新增覆盖自动下载、并发复用、重启缓存、损坏修复、自动重试、无效文件 / 重定向拒绝、取消与卸载、安装不占视频超时，以及关闭 Koishi 时后台依赖检查的竞态。
- 最终三个 tgz 分别独立安装到 Koishi 4.18.11，包加载、命令、默认值、署名和许可证检查通过。视频 autoInstall 默认为 true。最终包哈希与 package-smoke.json 记录匹配。
- Windows x64：在配置的两个工具路径均不存在的情况下，实际调用插件下载器从 GitHub 下载并安装 ffmpeg 与 ffprobe 6.1.1；使用下载后的 ffmpeg 生成 H.264 / AAC MP4，再用下载后的 ffprobe 检查时长、编码和尺寸，全部通过。中途网络失败后重试复用已完成的 ffmpeg，最终两工具均就绪。记录见 tools-live-windows.json。
- Linux x64 / ARM64：实际读取四个发布资源的 gzip / ELF 程序头，确认架构正确且均无 PT_INTERP 动态加载器。记录见 tools-linux-static.json。本机没有可用 Docker / WSL 运行环境，未把 ELF 静态检查写成 Alpine 实机运行通过；macOS 也未实机执行。
- 真实 Yarn 4.12.0 升级通过，使用最终 tgz，保留 Koishi 4.18.11 / auto-mas 0.0.2，图床依赖恢复为 0.1.2。第三方安装脚本关闭；保留 auto-mas 原有精确 peer 警告，未验证其运行兼容性。记录见 upgrade-install-0.3.1.json。

视频安装包：koishi-plugin-yunzai-video-parser-0.3.1.tgz，45235 字节，SHA256 为 8dba98431b8986abda2130e7fcd30523ef12e13e1b3d2cbd984b5e0238436f03。

## 实际问题与处理

| 问题 | 处理 |
| --- | --- |
| Node fetch / npm 查询直连返回 ETIMEDOUT，部分元数据经代理仍断开 | 使用本机已配置的代理做本轮读取，必要时用 Python 标准库获取公开元数据；未修改全局代理或 npm 登录信息 |
| GitHub 公共 API 403 限流、gh API EOF，部分旧 b6.0 链接与资源页 404 | 从 npm 正式包核对发布信息，再以真实资源读取验证；没有采用读不到的旧链接 |
| 备选 ffbinaries API 返回 403，另一备选站点 TLS 证书校验失败 | 未关闭证书验证，最终未使用这些备选来源 |
| 一组 descriptinc 标称静态构建实际含 PT_INTERP 动态加载器 | 放弃该组二进制，改用 eugeneware b6.1.1；重新检查 Linux x64 / ARM64 的两个工具，均无动态加载器 |
| 本机 wsl --list 返回帮助及非零退出码，输出为 UTF-16；未找到 Docker | 未安装或改动本机虚拟化环境；Linux 只记录发布资源和 ELF 验证，Windows 做真实运行验收 |
| Windows 实际 ffprobe 下载多次 ECONNRESET，首次完整准备失败 | 下载重试和后续重试均保留已完成 ffmpeg，清理未完成 ffprobe；之后从同一最终发布源完成下载并通过转码 / 探测 |
| 初次新包独立安装验收在停止时出现 TypeError: ctx.logger is not a function | 后台检查回调访问了已释放的 Context 日志服务；初始化时保存 logger，关闭后跳过日志，补充生命周期回归测试，最终 97/97 及三包独立安装通过 |
| 首次 Yarn 升级验收出现 TLS 连接建立前断开 | 保留失败日志；最终隔离项目复用已有成功项目的依赖锁文件后安装通过，不更改生产版本约束 |

## 验收边界

尚未连接用户的 SnowLuma 服务器，也没有向真实 QQ 发送视频。本轮交付为本地源码和安装包，未发布 GitHub、npm 或 Koishi 市场。默认自动安装需要可写数据目录、足够空间和发布源网络可达；网络受限时可使用现有 proxy 配置。仅补充媒体工具自动安装，原先已明确的其他迁移边界不变，见 docs/MIGRATION-REVIEW.md。

# 视频 0.3.4 修复与发布记录

本批只更新 `koishi-plugin-yunzai-video-parser` 到 0.3.4，保持普通发布（`preview: false`）。群管仍为 0.3.1 开发预览，点歌仍为 0.3.0。群管原逻辑审查见 [审查报告](GROUP-UPSTREAM-AUDIT-2026-09-13.md)，本轮未改群管功能。

## 修复

原实现将 HTTP 下载、gzip 解压直接串联，中断时删除临时可执行文件，重试从零开始。新实现先保留压缩分片及校验标识，支持 Range / If-Range；网络断开、准备超时或重启后继续下载。服务端忽略 Range 返回完整文件时覆盖重下，范围或文件标识变化时拒绝拼接。

每个工具最多尝试 6 次，退避间隔为 1、2、4、8、8 秒，整个准备过程受既有默认 10 分钟超时限制。增加连接/响应头超时，在 GitHub 发布页与同一上游官方资产 API 之间切换；保留插件和环境变量代理配置。压缩包先核对固定大小与上游 SHA256，再解压、核验格式和运行版本检查。不同实例共享数据目录时串行安装。

无需手动安装依赖或启用 npm 安装脚本。首次下载成功后复用工具缓存；断点文件随 Koishi data 目录持久化。GitHub 及资产 CDN 全部不可达时仍需恢复网络或配置可用代理。

## 本次验证

- 本地全套测试 **107/107 通过，0 失败、0 跳过**，包含实际 ffmpeg 媒体处理与 OneBot 本地协议测试。
- 下载器 19 项测试通过，覆盖中断流与真实分片写入、自动续传、重启续传、HTTP 200 忽略 Range、206 文件标识或范围不匹配、416、无校验标识、坏 SHA256、非可执行内容、实例并发、取消和卸载。
- 三包构建与打包通过；群管、点歌 tgz 与上一发布的 SHA256 一致。三个最终 tgz 分别独立安装到 Koishi 4.18.11 均通过；视频最终包的 npm dry-run 通过。
- 上游官方 API 和发布入口均实际返回相同资产的 HTTP 206，固定资产信息已核对。
- 本机 Windows 真实安装尝试保留了 3,898,744 字节分片，但随后遇到持续 TLS 连接重置/超时；代理路径又遇到 GitHub API 403 限流。未将这次未完成下载写为真实安装成功。Ubuntu / Node 22 的真实下载恢复已通过：保留 2,351,488 字节后主动中断，重启收到 HTTP 206（bytes 2351488-29354985/29354986），完成两工具的固定 SHA256 校验及真实 H.264/AAC 编码、ffprobe 校验。

- [GitHub CI 34738577854](https://github.com/Lance0174/yunzai-koishi-plugins/actions/runs/34738577854) 已在提交 `a465723698fc53a50c89196daabac8148381ad98` 通过 107/107 测试、真实下载恢复、打包及三个独立 Koishi 安装。
- CI 与本地视频包逐文件比较，差异仅 package.json、README、CHANGELOG 的 LF/CRLF 换行；所有运行代码一致。发布使用已通过本地独立安装的最终 tgz，并以该文件校验 npm 与 Release。

## 发布状态

视频 **0.3.4 已发布到 npm，Koishi 官方索引已收录**；群管 0.3.1 继续开发预览，点歌 0.3.0 和视频为普通发布。

- npm 回读时间：2026-09-13T06:18:14.049563+00:00。已核对三个包的 latest、版本、来源说明与开发标记，并下载远端 tgz；SHA256 全部与本地最终安装包一致。
- Koishi 索引回读时间：2026-09-13T06:21:09.697631+00:00；索引时间：Sun, 13 Sep 2026 06:17:36 GMT。三个版本全部收录，群管 preview=true、视频 preview=false。
- [GitHub v0.3.4](https://github.com/Lance0174/yunzai-koishi-plugins/releases/tag/v0.3.4) 已公开发布，9 个附件全部实际下载并核对 SHA256，源码 ZIP、完整交付 ZIP 内的文件与嵌套校验通过。
- 标签保留源代码提交 `14293ce3c41097522f513305dcbc96bc23908c97`；源码 ZIP 对应该标签。当前文档补充 npm 发布完成后的记录，Release 的安装说明和发布清单同步更新，三个 tgz 不变。

| 安装包 | SHA256 |
| --- | --- |
| koishi-plugin-yunzai-group-manager@0.3.1 | `2ce3f893cdb7f1516f7a315df0a57fa4190246c2de6179f4ef0f44938e75405b` |
| koishi-plugin-yunzai-music-request@0.3.0 | `acb82971d6e333924287f3289d9248aaa0a62e7fc37ff8425a0d5f1113082c8c` |
| koishi-plugin-yunzai-video-parser@0.3.4 | `dea387efee75f763018a46d6964961caf8cebe660a4f85ecac3e8c3d9580ecce` |

在 Koishi 项目目录更新视频：

```sh
cd /koishi
yarn add koishi-plugin-yunzai-video-parser@0.3.4
```

更新后重启 Koishi。已有 yunzai 包只需更新视频；旧 ember 包名迁移按根 README 使用迁移脚本。

## 实际问题与处理

- 本次 gh 读取上游发布信息遇到 TLS handshake timeout 和 EOF，换 Python HTTPS 读取成功，未根据失败响应猜测资产 ID。
- Windows 真实下载遇到 ECONNRESET、无响应超时，重试结束仍保留压缩进度；代理路径 API 返回 403 限流。已通过单独请求确认失败发生于 TLS 建连阶段，未关闭证书校验或修改全局代理。
- 审查辅助命令出现 Python GBK 无法输出 emoji，改用 `python -X utf8`；相对目录读错及 PowerShell 通配符 rg 路径错误，随后改为正确目录和 `-g` 过滤读取。宽范围检索命中压缩源码导致输出截断，未将截断内容作为已读完整源码的证据。

- npm 网页发布验证两次等待失效并返回 E404；后续发布 PUT 再次返回 E404，whoami/access 回读 E401 确认登录会话失效。刷新官方登录时首次 TLS ECONNRESET，重试成功；用户完成官方登录及本次发布的独立 2FA 后，0.3.4 发布成功。未更改或绕过账号安全设置。
- gh 拉取 CI 状态与产物再次遇到 TLS 超时，首次未取得目录的后续读取失败；改用受认证的 Python HTTPS 请求下载，跨域重定向未携带 GitHub 凭据。

- 官方市场索引的未压缩响应传输缓慢，停止本次只读获取，改用服务端支持的 gzip 响应，大小限制继续保留，完成最终索引核验。

不把本地模拟或 GitHub CI 的结果称为用户真实 SnowLuma / QQ 验收；这次没有执行用户服务器操作或真实群管动作。

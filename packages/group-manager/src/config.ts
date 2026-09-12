import { Schema } from 'koishi'

export interface Config {
  command: string
  reviews: boolean
  notices: boolean
  moderation: boolean
  botIds: string[]
  reviewers: string[]
  reviewGroups: string[]
  managedGroups: string[]
  privateReview: boolean
  inviteAllow: string[]
  inviteDeny: string[]
  requestTtlHours: number
  apiTimeout: number
  pageSize: number
  noticeInterval: number
  auditDays: number
  shortcuts: boolean
  autoInvite: boolean
  avatarHosts: string[]
  blackUsers: string[]
  whiteUsers: string[]
  blackGroups: string[]
  whiteGroups: string[]
  listener: boolean
  listenerMode: 'admins' | 'custom'
  listenerTargets: { type: 'group' | 'private'; id: string }[]
}
export const Config: Schema<Config> = Schema.object({
  shortcuts: Schema.boolean().default(true).description('启用禁言、踢人、群公告等短指令。'),
  autoInvite: Schema.boolean().default(false).description('自动接受邀请白名单内的邀请，黑名单仍然优先。'),
  avatarHosts: Schema.array(String).default(['qpic.cn', 'qq.com']).description('允许读取群头像图片的域名。'),
  command: Schema.string().default('群管理').description('指令根名称。'),
  reviews: Schema.boolean().default(true).description('启用群请求审核。'),
  notices: Schema.boolean().default(true).description('启用群事件摘要通知。'),
  moderation: Schema.boolean().default(true).description('启用群管理。'),
  botIds: Schema.array(String)
    .default([])
    .description('限定机器人 QQ；留空适用所有 OneBot 账户，各账户数据独立。'),
  reviewers: Schema.array(String)
    .default([])
    .description('机器人管理员 QQ：允许审核，也是事件监听的默认私聊收件人。'),
  reviewGroups: Schema.array(String).default([]).description('接收通知及允许审批的群号。'),
  managedGroups: Schema.array(String)
    .default([])
    .description('兼容旧配置的群管范围；留空默认所有群可用。新配置推荐使用黑白名单。')
    .hidden(),
  blackUsers: Schema.array(String)
    .default([])
    .description('全局用户黑名单：忽略消息，不自动踢人。可用指令维护。'),
  whiteUsers: Schema.array(String)
    .default([])
    .description('全局用户白名单：豁免处罚和入群验证，不授予管理权限。'),
  blackGroups: Schema.array(String).default([]).description('群黑名单：忽略这些群的消息。'),
  whiteGroups: Schema.array(String)
    .default([])
    .description('群白名单：豁免本插件的处罚和入群验证。黑名单优先。'),
  listener: Schema.boolean().default(true).description('独立事件监听：默认开启，不依赖群管和请求审核开关。'),
  listenerMode: Schema.union(['admins', 'custom'])
    .default('admins')
    .description('监听收件方式：admins 私聊管理员；custom 使用下方自定义目标。'),
  listenerTargets: Schema.array(
    Schema.object({
      type: Schema.union(['group', 'private']).default('group'),
      id: Schema.string().required().description('群号或私聊 QQ。'),
    }),
  )
    .default([])
    .description('自定义事件监听目标，可同时设置群聊和私聊。'),
  privateReview: Schema.boolean().default(true).description('允许审核人私聊使用请求编号审批。'),
  inviteAllow: Schema.array(String)
    .default([])
    .description('机器人允许加入的群；留空不限。可选开启自动接受白名单内的邀请。'),
  inviteDeny: Schema.array(String).default([]).description('禁止机器人加入的群。'),
  requestTtlHours: Schema.number().min(1).max(168).default(24).description('本地请求有效期（小时）。'),
  apiTimeout: Schema.number().min(1000).max(60000).default(15000).description('动作等待时间（毫秒）。'),
  pageSize: Schema.number().min(1).max(20).step(1).default(5),
  noticeInterval: Schema.number().min(100).default(1500).description('同一通知群最小发送间隔（毫秒）。'),
  auditDays: Schema.number().min(1).max(365).default(30).description('审计和已结束请求的保留天数。'),
})

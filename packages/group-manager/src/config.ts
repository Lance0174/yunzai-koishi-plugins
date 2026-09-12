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
  reviewers: Schema.array(String).default([]).description('允许审核的用户 QQ。'),
  reviewGroups: Schema.array(String).default([]).description('接收通知及允许审批的群号。'),
  managedGroups: Schema.array(String)
    .default([])
    .description('允许群管操作及发送事件通知的群号；留空不开放群管。'),
  privateReview: Schema.boolean().default(false).description('允许审核人私聊使用请求编号审批。'),
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

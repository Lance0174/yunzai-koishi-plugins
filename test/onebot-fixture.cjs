const { WebSocketServer } = require('ws')
const { once } = require('node:events')
const { Universal } = require('koishi')
const onebot = require('koishi-plugin-adapter-onebot').default
const http = require('@koishijs/plugin-http').default
const { waitFor } = require('./fixture.cjs')

async function protocol(app) {
  let sequence = 100,
    socket,
    fork
  const sent = [],
    actions = [],
    messages = new Map(),
    failures = new Map(),
    roles = new Map([
      ['1001', 'admin'],
      ['900001', 'admin'],
      ['1003', 'owner'],
    ]),
    cards = new Map(),
    members = new Map(),
    responses = new Map(),
    notices = [],
    essence = [],
    groupNames = new Map()
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const event = (content, user = 1001, group = 500) => ({
    time: Math.floor(Date.now() / 1000),
    self_id: 900001,
    post_type: 'message',
    message_type: group ? 'group' : 'private',
    sub_type: group ? 'normal' : 'friend',
    message_id: ++sequence,
    user_id: user,
    ...(group ? { group_id: group } : {}),
    sender: { user_id: user, nickname: 'Test user', role: roles.get(String(user)) || 'member' },
    message: content,
    raw_message: typeof content === 'string' ? content : '',
    font: 0,
  })
  server.on('connection', (client) => {
    socket = client
    client.on('message', (raw) => {
      const { action, params, echo } = JSON.parse(raw.toString())
      actions.push({ action, params })
      if (failures.has(action)) {
        const code = failures.get(action)
        if (code !== 'timeout')
          client.send(JSON.stringify({ status: 'failed', retcode: code, data: null, echo }))
        return
      }
      let data = {}
      if (responses.has(action)) data = responses.get(action)
      else if (action === 'get_login_info') data = { user_id: 900001, nickname: 'Local fixture bot' }
      else if (action === 'get_guild_service_profile') data = { tiny_id: '0' }
      else if (action === 'get_version_info')
        data = { app_name: 'SnowLuma protocol fixture', app_version: 'test', protocol_version: 'v11' }
      else if (action === 'get_group_member_info')
        data = {
          user_id: params.user_id,
          group_id: params.group_id,
          role: roles.get(String(params.user_id)) || 'member',
          card: cards.get(String(params.user_id)) || '',
          nickname: 'Test user',
          ...members.get(String(params.user_id)),
        }
      else if (action === 'set_group_card') cards.set(String(params.user_id), params.card)
      else if (action === 'get_group_member_list')
        data = [...new Set([...roles.keys(), ...members.keys()])].map((id) => ({
          user_id: Number(id),
          role: roles.get(id) || 'member',
          nickname: '成员' + id,
          ...members.get(id),
        }))
      else if (action === 'set_group_admin')
        roles.set(String(params.user_id), params.enable ? 'admin' : 'member')
      else if (action === 'set_group_special_title')
        members.set(String(params.user_id), {
          ...members.get(String(params.user_id)),
          title: params.special_title,
        })
      else if (action === 'set_group_ban')
        members.set(String(params.user_id), {
          ...members.get(String(params.user_id)),
          shut_up_timestamp: params.duration ? Math.floor(Date.now() / 1000) + params.duration : 0,
        })
      else if (action === 'set_group_name') groupNames.set(String(params.group_id), params.group_name)
      else if (action === 'get_group_info')
        data = {
          group_id: params.group_id,
          group_name: groupNames.get(String(params.group_id)) || '测试群',
          member_count: 10,
        }
      else if (action === 'get_group_list')
        data = [500, 501, 600].map((id) => ({
          group_id: id,
          group_name: groupNames.get(String(id)) || '测试群',
          member_count: 10,
        }))
      else if (action === '_send_group_notice')
        notices.push({
          group_id: params.group_id,
          notice_id: String(++sequence),
          message: { text: params.content },
        })
      else if (action === '_get_group_notice') data = notices.filter((n) => n.group_id === params.group_id)
      else if (action === '_del_group_notice') {
        const i = notices.findIndex(
          (n) => n.group_id === params.group_id && String(n.notice_id) === String(params.notice_id),
        )
        if (i >= 0) notices.splice(i, 1)
      } else if (action === 'set_essence_msg')
        essence.push({ message_id: params.message_id, sender_id: 2001 })
      else if (action === 'delete_essence_msg') {
        const i = essence.findIndex((n) => n.message_id === params.message_id)
        if (i >= 0) essence.splice(i, 1)
      } else if (action === 'get_essence_msg_list') data = essence
      else if (action === 'get_group_honor_info')
        data = { current_talkative: { user_id: 2001, nickname: 'Dragon' } }
      else if (action === 'get_group_signed_list') data = { sign_in_count: 1 }
      else if (action === 'get_group_system_msg') data = { join_requests: [], invited_requests: [] }
      else if (action === 'get_msg') data = messages.get(String(params.message_id))
      else if (action === 'download_file') data = { file: '/protocol-cache/audio.mp3' }
      else if (action.startsWith('send_') && action.endsWith('_msg')) {
        data = { message_id: ++sequence }
        const parts = params.message ?? params.messages.flatMap((node) => node.data.content ?? [])
        const row = { ...event(parts, 900001, params.group_id), message_id: data.message_id }
        messages.set(String(data.message_id), row)
        sent.push({
          action,
          params: { ...params, message: parts },
          id: String(data.message_id),
          text: parts
            .filter((s) => s.type === 'text')
            .map((s) => s.data.text)
            .join(''),
        })
      }
      client.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo }))
    })
  })
  if (!app.http) app.plugin(http)
  fork = app.plugin(onebot, {
    selfId: '900001',
    protocol: 'ws',
    endpoint: `ws://127.0.0.1:${server.address().port}`,
    responseTimeout: 200,
  })
  await app.start()
  await waitFor(() => app.bots.some((b) => b.platform === 'onebot' && b.status === Universal.Status.ONLINE))
  const emit = (data) =>
    socket.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), self_id: 900001, ...data }))
  return {
    sent,
    actions,
    messages,
    roles,
    failures,
    members,
    responses,
    emit,
    event,
    app,
    async command(content, user = 1001, group = 500, predicate = () => true) {
      const from = sent.length
      emit(event(content, user, group))
      return waitFor(
        () =>
          sent
            .slice(from)
            .find(
              (n) =>
                (group ? n.params.group_id === group : n.params.user_id === user) &&
                !n.text.includes('引用本通知发送') &&
                !n.text.startsWith('成员加入\n') &&
                !n.text.startsWith('欢迎 ') &&
                predicate(n),
            ),
        5000,
      )
    },
    async close() {
      await fork.dispose()
      await app.stop()
      for (const client of server.clients) client.terminate()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
module.exports = { protocol }

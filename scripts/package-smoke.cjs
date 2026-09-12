const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { createRequire } = require('node:module')
const { createHash } = require('node:crypto')
const root = path.resolve(__dirname, '..')
const names = [
  'koishi-plugin-yunzai-group-manager',
  'koishi-plugin-yunzai-music-request',
  'koishi-plugin-yunzai-video-parser',
]

async function child(directory, name) {
  const requireAt = createRequire(path.join(directory, 'package.json'))
  const { App } = requireAt('koishi'),
    plugin = requireAt(name)
  assert.equal(requireAt('koishi/package.json').version, '4.18.11')
  for (const other of names.filter((value) => value !== name)) assert.throws(() => requireAt.resolve(other))
  const app = new App()
  app.baseDir = directory
  if (name === names[0])
    app.plugin(requireAt('@koishijs/plugin-database-sqlite').default, {
      path: path.join(directory, 'data.sqlite'),
    })
  app.plugin(plugin, {})
  try {
    await app.start()
    const expected =
      name === names[0]
        ? [
            '群管理.同意',
            '群管理.踢人',
            '群管理.定时禁言',
            '群管理.投票禁言',
            '群管理.入群验证',
            '群管理.公告',
            '群管理.撤回',
          ]
        : name === names[1]
          ? [
              '点歌.播放',
              '点歌.卡片',
              '点歌.语音',
              '点歌.歌词',
              '点歌.取消',
              '点歌.登录',
              '点歌.账号',
              '点歌.退出登录',
            ]
          : ['视频解析.预览', '视频解析.任务', '视频解析.取消', '视频解析.诊断']
    for (let i = 0; i < 100 && !app.$commander.resolve(expected[0]); i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    expected.forEach((command) => assert.ok(app.$commander.resolve(command), command))
    assert.equal(app.$commander.resolve('群管理.执行'), undefined)
    assert.equal(app.$commander.resolve('点歌.下载'), undefined)
    assert.ok(plugin.usage.includes('迁移来源：'))
    const installed = path.dirname(requireAt.resolve(name + '/package.json'))
    assert.ok((await fs.readFile(path.join(installed, 'THIRD_PARTY_NOTICES.md'), 'utf8')).includes('贡献者'))
    assert.ok((await fs.readdir(path.join(installed, 'licenses'))).length > 0)
    if (name === names[1])
      assert.equal(
        Object.keys(plugin.Config({})).some((key) => /cookie/i.test(key)),
        false,
      )
    if (name === names[2]) {
      assert.equal(plugin.Config({}).autoParse, true)
      assert.equal(plugin.Config({}).forward, true)
      assert.equal(plugin.Config({}).autoInstall, true)
    }
    if (name === names[0]) {
      for (const suffix of ['黑名单', '白名单', '事件监听', '事件通知'])
        assert.ok(app.$commander.resolve('群管理.' + suffix))
      assert.deepEqual(plugin.Config({}).managedGroups, [])
      const { Store } = requireAt(name + '/lib/store')
      const store = new Store(app.database)
      const row = await store.receive(
        {
          bot: 'onebot:1',
          selfId: '1',
          kind: 'invite',
          flag: 'packed',
          guildId: '2',
          userId: '3',
          comment: '',
        },
        60000,
      )
      assert.ok(row.id)
    }
    console.log('PASS ' + name + ': isolated install, Koishi 4.18.11 load, schema and command registration')
  } finally {
    await app.stop()
  }
}
async function main() {
  const npm = process.env.npm_execpath
  if (!npm) throw new Error('Run npm run test:packages.')
  const directories = [],
    results = []
  try {
    for (const name of names) {
      const folder = name === names[0] ? 'group-manager' : name === names[1] ? 'music' : 'video'
      const version = require(path.join(root, 'packages', folder, 'package.json')).version
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-package-'))
      directories.push(directory)
      await fs.writeFile(
        path.join(directory, 'package.json'),
        JSON.stringify({ name: 'independent-koishi-consumer', version: '1.0.0', private: true }),
      )
      const args = [
        npm,
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--registry=https://registry.npmjs.org',
        '--fetch-timeout=30000',
        '--fetch-retries=1',
        'koishi@4.18.11',
        path.join(root, 'artifacts/packages', `${name}-${version}.tgz`),
      ]
      if (name === names[0]) args.push('@koishijs/plugin-database-sqlite@4.7.0')
      if (process.env.PROBE_PROXY)
        args.push('--proxy=' + process.env.PROBE_PROXY, '--https-proxy=' + process.env.PROBE_PROXY)
      execFileSync(process.execPath, args, {
        cwd: directory,
        windowsHide: true,
        stdio: 'pipe',
        timeout: 180000,
      })
      const output = execFileSync(process.execPath, [__filename, '--child', directory, name], {
        cwd: directory,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000,
      })
      console.log(output.trim())
      const packedBytes = await fs.readFile(path.join(root, 'artifacts/packages', `${name}-${version}.tgz`))
      results.push({
        name,
        koishi: '4.18.11',
        node: process.version,
        result: 'passed',
        independent: true,
        sha256: createHash('sha256').update(packedBytes).digest('hex'),
      })
    }
    await fs.writeFile(
      path.join(root, 'artifacts/package-smoke.json'),
      JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2) + '\n',
    )
  } finally {
    for (const directory of directories)
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
}
const action = process.argv[2] === '--child' ? child(process.argv[3], process.argv[4]) : main()
action.catch((error) => {
  console.error(
    error.status !== undefined
      ? `Package install/load subprocess failed (exit ${error.status}); check network and package compatibility.`
      : error.message,
  )
  process.exitCode = 1
})

const assert = require('node:assert/strict')
const { test, before, after, mock } = require('node:test')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const media = require('../packages/video/lib/media')
const { MediaTools } = require('../packages/video/lib/tools')
const { Queue } = require('../packages/video/lib/queue')
const { App } = require('koishi')
const plugin = require('../packages/video/lib')
const { gzipSync } = require('node:zlib')
const { createHash } = require('node:crypto')
const assets = require('../packages/video/lib/tool-assets')
const timers = require('node:timers/promises')
const { networkFixture, waitFor } = require('./fixture.cjs')
let folder, network, checkMock, assetMock, pauseMock, handler
let archiveFor = (name) => gzipSync(binary(name))
const checked = []
const header =
  process.platform === 'win32'
    ? Buffer.from('MZ00')
    : process.platform === 'linux'
      ? Buffer.from('7f454c46', 'hex')
      : Buffer.from('cffaedfe', 'hex')
const binary = (name) => Buffer.concat([header, Buffer.from(name), Buffer.alloc(128)])
const config = {
  ffmpeg: 'absent-ffmpeg',
  ffprobe: 'absent-ffprobe',
  autoInstall: true,
  toolDownloadTimeout: 30000,
  proxy: '',
}
const stages = async (manager) => (await fs.readdir(manager.root)).filter((name) => name.startsWith('.'))
before(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'yunzai-tools-test-'))
  checkMock = mock.method(media, 'checkTool', async (name, file, signal) => {
    checked.push(file)
    if (signal?.aborted) throw new Error('cancelled')
    if (file === `system-${name}`) return `${name} version system-test`
    const bytes = await fs.readFile(file)
    assert.ok(bytes.subarray(4).toString().startsWith(name))
    return `${name} version fixture`
  })
  assetMock = mock.method(assets, 'binaryAsset', (name) => {
    const bytes = archiveFor(name)
    return {
      id: name === 'ffmpeg' ? 1 : 2,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  })
  const pause = timers.setTimeout
  pauseMock = mock.method(timers, 'setTimeout', (_ms, value, options) => pause(1, value, options))
  network = await networkFixture((call, response) => handler(call, response))
})
after(async () => {
  checkMock?.mock.restore()
  assetMock?.mock.restore()
  pauseMock?.mock.restore()
  await network?.close()
  await fs.rm(folder, { recursive: true, force: true })
})
const normal = (call) =>
  archiveFor(
    call.url.pathname.includes('/ffprobe-') || call.url.pathname.endsWith('/assets/2') ? 'ffprobe' : 'ffmpeg',
  )
function manager(name, overrides = {}) {
  return new MediaTools(path.join(folder, name), { ...config, ...overrides })
}

test('existing executables are reused without downloading or creating a tools directory', async () => {
  handler = () => {
    throw new Error('unexpected download')
  }
  const tools = manager('system', { ffmpeg: 'system-ffmpeg', ffprobe: 'system-ffprobe' })
  const from = network.calls.length
  const result = await tools.ensure()
  assert.equal(result.ffmpeg, 'system-ffmpeg')
  assert.equal(network.calls.length, from)
  await assert.rejects(fs.stat(tools.root), { code: 'ENOENT' })
  await tools.close()
})
test('missing tools download automatically once, persist checked files and are reused after restart', async () => {
  handler = normal
  const tools = manager('install'),
    from = network.calls.length
  const [first, second] = await Promise.all([tools.ensure(), tools.ensure()])
  assert.deepEqual(first, second)
  assert.equal(network.calls.length - from, 2)
  assert.deepEqual(await stages(tools), [])
  for (const name of ['ffmpeg', 'ffprobe']) {
    const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(first[name]), 'manifest.json')))
    assert.match(manifest.sha256, /^[a-f0-9]{64}$/)
    assert.equal(manifest.bytes, binary(name).length)
    assert.ok(
      (await fs.readFile(path.join(path.dirname(first[name]), 'LICENSE.txt'), 'utf8')).includes(
        'GNU GENERAL PUBLIC LICENSE',
      ),
    )
  }
  await tools.close()
  const restarted = manager('install')
  assert.deepEqual(await restarted.ensure(), first)
  assert.equal(network.calls.length - from, 2)
  await restarted.close()
})
test('a corrupt cached tool is replaced while the other verified tool is reused', async () => {
  handler = normal
  const tools = manager('install'),
    original = await tools.ensure()
  await tools.close()
  await fs.appendFile(original.ffmpeg, 'corruption')
  const repaired = manager('install'),
    from = network.calls.length
  await repaired.ensure()
  assert.equal(network.calls.length - from, 1)
  assert.deepEqual(await fs.readFile(original.ffmpeg), binary('ffmpeg'))
  await repaired.close()
})
test('transient failure retries through both official entry points; exhausted attempts can retry later', async () => {
  let attempts = 0
  handler = (call, response) => {
    if (++attempts <= 2) {
      response.writeHead(503)
      response.end('retry')
      return
    }
    return normal(call)
  }
  const tools = manager('retry')
  await tools.ensure()
  assert.equal(attempts, 4)
  await tools.close()
  handler = (_call, response) => {
    response.writeHead(503)
    response.end('failure')
  }
  const failed = manager('failure'),
    from = network.calls.length
  await assert.rejects(failed.ensure(), /HTTP 503/)
  assert.equal(network.calls.length - from, 6)
  assert.deepEqual(await stages(failed), [])
  handler = normal
  await failed.ensure()
  await failed.close()
})
test('HTML downloads and redirects to an untrusted host never execute as media tools', async () => {
  const original = archiveFor
  archiveFor = () => gzipSync(Buffer.from('<html>login required</html>'))
  handler = normal
  const tools = manager('html'),
    from = checked.length
  await assert.rejects(tools.ensure(), /不是当前平台的可执行文件/)
  assert.ok(!checked.slice(from).some((file) => file.startsWith(tools.root)))
  assert.deepEqual(await stages(tools), [])
  await tools.close()
  archiveFor = original
  handler = (_call, response) => {
    response.writeHead(302, { location: 'https://example.com/tool' })
    response.end()
  }
  const redirect = manager('redirect'),
    start = network.calls.length
  await assert.rejects(redirect.ensure(), /受信任的发布源/)
  assert.equal(network.calls.length - start, 1)
  await redirect.close()
})

const partFile = (tools) => path.join(tools.root, 'downloads/ffmpeg.gz.part')
async function cutResponse(tools, call, response) {
  const bytes = normal(call),
    count = Math.floor(bytes.length / 2)
  response.writeHead(200, { 'content-length': bytes.length, etag: '"fixture-v1"' })
  response.write(bytes.subarray(0, count))
  await waitFor(async () => (await fs.stat(partFile(tools)).catch(() => ({ size: 0 }))).size === count)
  return count
}
function ranged(call, response) {
  const bytes = normal(call),
    offset = Number(/^bytes=(\d+)-$/.exec(call.headers.range || '')?.[1] || 0)
  response.writeHead(offset ? 206 : 200, {
    'content-length': bytes.length - offset,
    etag: '"fixture-v1"',
    ...(offset ? { 'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}),
  })
  response.end(bytes.subarray(offset))
}

test('a broken response resumes its real compressed bytes through the official API with Range and If-Range', async () => {
  const tools = manager('resume'),
    from = network.calls.length
  let count
  handler = async (call, response) => {
    if (network.calls.length === from + 1) {
      count = await cutResponse(tools, call, response)
      response.destroy()
    } else ranged(call, response)
  }
  const result = await tools.ensure()
  const retry = network.calls[from + 1]
  assert.equal(retry.url.hostname, 'api.github.com')
  assert.equal(retry.headers.accept, 'application/octet-stream')
  assert.equal(retry.headers.range, `bytes=${count}-`)
  assert.equal(retry.headers['if-range'], '"fixture-v1"')
  assert.deepEqual(await fs.readFile(result.ffmpeg), binary('ffmpeg'))
  await assert.rejects(fs.stat(partFile(tools)), { code: 'ENOENT' })
  await tools.close()
})

test('plugin restart preserves a compressed partial and resumes without leaving a partial executable', async () => {
  const tools = manager('restart-resume')
  let count
  handler = async (call, response) => {
    count = await cutResponse(tools, call, response)
  }
  const rejected = assert.rejects(tools.ensure(), /取消或超时/)
  await waitFor(() => count)
  await tools.close()
  await rejected
  assert.equal((await fs.stat(partFile(tools))).size, count)
  assert.deepEqual(await stages(tools), [])
  const restarted = manager('restart-resume'),
    from = network.calls.length
  handler = ranged
  await restarted.ensure()
  assert.equal(network.calls[from].headers.range, `bytes=${count}-`)
  await restarted.close()
})

for (const mode of [
  'ignored-range',
  'changed-etag',
  'wrong-start',
  'wrong-total',
  'range-416',
  'no-validator',
]) {
  test(`resume handles ${mode} without joining different or misplaced bytes`, async () => {
    const tools = manager(mode),
      from = network.calls.length
    handler = async (call, response) => {
      const step = network.calls.length - from,
        bytes = normal(call)
      if (step === 1) {
        if (mode === 'no-validator') {
          response.writeHead(200, { 'content-length': bytes.length })
          response.write(bytes.subarray(0, Math.floor(bytes.length / 2)))
          await waitFor(async () => (await fs.stat(partFile(tools)).catch(() => ({ size: 0 }))).size > 0)
        } else await cutResponse(tools, call, response)
        response.destroy()
      } else if (step === 2 && mode !== 'no-validator') {
        assert.ok(call.headers.range)
        if (mode === 'ignored-range') {
          response.writeHead(200, { 'content-length': bytes.length, etag: '"fixture-v2"' })
          response.end(bytes)
        } else if (mode === 'range-416') {
          response.writeHead(416)
          response.end()
        } else {
          const offset = Number(/^bytes=(\d+)-$/.exec(call.headers.range)[1])
          response.writeHead(206, {
            'content-length': bytes.length - offset,
            etag: mode === 'changed-etag' ? '"fixture-v2"' : '"fixture-v1"',
            'content-range': `bytes ${offset + (mode === 'wrong-start' ? 1 : 0)}-${bytes.length - 1}/${bytes.length + (mode === 'wrong-total' ? 1 : 0)}`,
          })
          response.end(bytes.subarray(offset))
        }
      } else {
        assert.equal(call.headers.range, undefined)
        ranged(call, response)
      }
    }
    const result = await tools.ensure()
    assert.deepEqual(await fs.readFile(result.ffmpeg), binary('ffmpeg'))
    await tools.close()
  })
}

test('a same-size corrupt archive fails its pinned digest and is downloaded again before execution', async () => {
  const tools = manager('checksum'),
    from = network.calls.length
  handler = (call) => {
    const bytes = Buffer.from(normal(call))
    if (network.calls.length === from + 1) bytes[bytes.length - 1] ^= 1
    return bytes
  }
  const result = await tools.ensure()
  assert.equal(network.calls.length - from, 3)
  assert.deepEqual(await fs.readFile(result.ffmpeg), binary('ffmpeg'))
  await tools.close()
})

test('two plugin instances sharing a data directory serialize installation and reuse the result', async () => {
  handler = ranged
  const first = manager('shared'),
    second = manager('shared'),
    from = network.calls.length
  const results = await Promise.all([first.ensure(), second.ensure()])
  assert.deepEqual(results[0], results[1])
  assert.equal(network.calls.length - from, 2)
  await first.close()
  await second.close()
})
test('cancelling one waiting video does not cancel installation needed by other videos', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  handler = async (call) => {
    await gate
    return normal(call)
  }
  const tools = manager('waiter'),
    control = new AbortController()
  const first = tools.ensure(control.signal),
    second = tools.ensure()
  control.abort()
  await assert.rejects(first, /视频任务已取消/)
  release()
  assert.ok((await second).ffprobe)
  await tools.close()
})
test('plugin shutdown cancels the download and cleans incomplete executable files', async () => {
  handler = (_call, response) => {
    response.writeHead(200)
    response.write(header)
  }
  const tools = manager('shutdown'),
    from = network.calls.length
  const pending = tools.ensure()
  const rejected = assert.rejects(pending, /取消或超时/)
  await waitFor(() => network.calls.length > from)
  await tools.close()
  await rejected
  assert.deepEqual(await stages(tools), [])
})
test('Koishi shutdown during a background dependency check does not access disposed services', async () => {
  const app = new App()
  app.baseDir = path.join(folder, 'lifecycle')
  app.plugin(plugin, { ...config, autoInstall: false })
  await app.start()
  await app.stop()
  await new Promise((resolve) => setImmediate(resolve))
})

test('video timeout starts after automatic tool preparation and cancellation still prevents video work', async () => {
  const queue = new Queue(1, 1, 30)
  const ticket = queue.add(
    'a',
    'a',
    async () => 'video',
    async () => new Promise((resolve) => setTimeout(resolve, 70)),
  )
  assert.equal(await ticket.done, 'video')
  let ran = false,
    release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const next = queue.add(
    'b',
    'b',
    async () => {
      ran = true
    },
    () => gate,
  )
  queue.cancel(next.id, 'b')
  release()
  await assert.rejects(next.done, /取消/)
  assert.equal(ran, false)
  await queue.close()
})

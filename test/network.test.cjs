const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const { gzipSync } = require('node:zlib')
const fs = require('node:fs')
const { request, checkedUrl, isPublic, mediaKind } = require('../packages/music/lib/net')
const { networkFixture } = require('./fixture.cjs')
let fixture
before(async () => {
  fixture = await networkFixture((call, res) => {
    switch (call.url.pathname) {
      case '/redirect':
        res.writeHead(302, { location: 'https://cdn.example.com/final' })
        res.end()
        return
      case '/private':
        res.writeHead(302, { location: 'http://127.0.0.1/secret' })
        res.end()
        return
      case '/big':
        return Buffer.alloc(2048)
      case '/gzip':
        res.setHeader('Content-Encoding', 'gzip')
        return gzipSync(Buffer.alloc(5000))
      case '/slow':
        res.writeHead(200)
        res.write('waiting')
        return
      default:
        return { success: true }
    }
  })
})
after(async () => fixture.close())
test('both packages carry the same audited network implementation', () => {
  assert.equal(
    fs.readFileSync('packages/music/src/net.ts', 'utf8'),
    fs.readFileSync('packages/video/src/net.ts', 'utf8'),
  )
})
test('URL validation rejects malicious suffixes, credentials, local IPv4/IPv6 and unsafe ports', () => {
  for (const url of [
    'https://example.com.evil.org/a',
    'https://user:pass@example.com/a',
    'file:///a',
    'http://localhost/a',
    'http://127.0.0.1/a',
    'http://[::ffff:127.0.0.1]/a',
    'https://example.com:8080/a',
  ]) {
    assert.throws(() =>
      checkedUrl(url, { hosts: ['example.com', 'localhost', '127.0.0.1', '[::ffff:7f00:1]'] }),
    )
  }
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '192.168.1.1',
    '::1',
    'fd00::1',
    '::ffff:10.0.0.1',
    '198.18.0.1',
  ])
    assert.equal(isPublic(ip), false, ip)
  assert.equal(isPublic('8.8.8.8'), true)
})
test('redirects revalidate destination, strip credentials across origins and pin the resolved IP', async () => {
  await request('https://example.com/redirect', {
    hosts: ['example.com'],
    headers: { Cookie: 'private', Authorization: 'private' },
  })
  const last = fixture.calls.at(-1),
    socket = fixture.sockets.at(-1)
  assert.equal(last.headers.cookie, undefined)
  assert.equal(last.headers.authorization, undefined)
  assert.equal(socket.hostname, '93.184.216.34')
  assert.equal(socket.servername, 'cdn.example.com')
  await assert.rejects(
    request('https://example.com/private', { hosts: ['example.com', '127.0.0.1'] }),
    /内网|本地/,
  )
})
test('DNS rebinding/reserved DNS answer fails before opening a socket', async () => {
  const count = fixture.sockets.length
  fixture.dnsMock.mock.mockImplementationOnce(async () => [{ address: '127.0.0.1', family: 4 }])
  await assert.rejects(request('https://example.com/final', { hosts: ['example.com'] }), /解析到了/)
  assert.equal(fixture.sockets.length, count)
})

test('cross-origin redirects cannot forward a Cookie embedded in an API POST form', async () => {
  const count = fixture.calls.length
  await assert.rejects(
    request('https://example.com/redirect', {
      hosts: ['example.com'],
      method: 'POST',
      body: 'cookie=private-value',
    }),
    /不能跨来源/,
  )
  assert.equal(fixture.calls.length, count + 1)
})
test('stream limits, decompression limits and abort stop reads', async () => {
  const options = { hosts: ['example.com'], maxBytes: 1024 }
  await assert.rejects(request('https://example.com/big', options), /超过大小/)
  await assert.rejects(request('https://example.com/gzip', options), /解压/)
  const control = new AbortController()
  const pending = request('https://example.com/slow', { ...options, signal: control.signal })
  setTimeout(() => control.abort(), 30)
  await assert.rejects(pending, /取消|中断/)
  assert.equal(mediaKind(Buffer.from('<html>permission required</html>')), undefined)
})

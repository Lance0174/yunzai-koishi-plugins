const http = require('node:http')
const https = require('node:https')
const dns = require('node:dns/promises')
const { mock } = require('node:test')
const { once } = require('node:events')

async function waitFor(read, timeout = 4000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await read()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Local fixture timed out')
}

// Intercept only socket destination/DNS in tests. Production URL, redirect,
// header, size and media parsing checks continue to run on the real transport.
async function networkFixture(handler) {
  const calls = [],
    original = http.request
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const call = {
      url: new URL(req.url, `https://${req.headers.host}`),
      method: req.method,
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    }
    calls.push(call)
    try {
      const value = await handler(call, res)
      if (res.writableEnded || res.destroyed || value === undefined) return
      if (Buffer.isBuffer(value) || typeof value === 'string') res.end(value)
      else {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(value))
      }
    } catch (e) {
      res.statusCode = 500
      res.end('fixture handler error: ' + e.message)
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const lookups = [],
    sockets = []
  const dnsMock = mock.method(dns, 'lookup', async (host) => {
    lookups.push(host)
    return [{ address: '93.184.216.34', family: 4 }]
  })
  const redirect = (options, callback) => {
    if (['127.0.0.1', 'localhost'].includes(options.hostname || options.host))
      return original(options, callback)
    sockets.push(options)
    return original(
      {
        ...options,
        protocol: 'http:',
        hostname: '127.0.0.1',
        port: server.address().port,
        servername: undefined,
        agent: undefined,
      },
      callback,
    )
  }
  const httpMock = mock.method(http, 'request', redirect),
    httpsMock = mock.method(https, 'request', redirect)
  return {
    calls,
    lookups,
    sockets,
    dnsMock,
    close: async () => {
      httpMock.mock.restore()
      httpsMock.mock.restore()
      dnsMock.mock.restore()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
module.exports = { networkFixture, waitFor }

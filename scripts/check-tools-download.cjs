// Live integration check: download from the fixed upstream, interrupt, restart,
// require HTTP 206 recovery, then run the verified tools on a synthetic video.
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const https = require('node:https')
const assert = require('node:assert/strict')
const { MediaTools } = require('../packages/video/lib/tools')
const { ffmpeg, probe } = require('../packages/video/lib/media')
const reportPath = path.resolve(__dirname, '../artifacts/tools-download-live.json')
const config = {
  ffmpeg: 'absent-ffmpeg',
  ffprobe: 'absent-ffprobe',
  autoInstall: true,
  toolDownloadTimeout: 240000,
  proxy: '',
}
const trace = [],
  original = https.request
let base, active
const report = {
  checkedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  result: 'failed',
  trace,
  realQQ: false,
}
https.request = function (options, callback) {
  return original.call(this, options, (response) => {
    trace.push({
      host: options.hostname,
      range: options.headers.Range,
      status: response.statusCode,
      contentRange: response.headers['content-range'],
    })
    callback(response)
  })
}
async function main() {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'yunzai-live-download-'))
  const first = (active = new MediaTools(base, config, console.log))
  const partial = path.join(first.root, 'downloads/ffmpeg.gz.part')
  let ended = false,
    outcome
  const pending = first.ensure().then(
    () => {
      ended = true
      outcome = 'completed'
    },
    (e) => {
      ended = true
      outcome = e.message
    },
  )
  while (!ended) {
    const size = (await fs.stat(partial).catch(() => ({ size: 0 }))).size
    if (size >= 2 * 1024 * 1024) break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(ended, false, `Download ended before interruption: ${outcome}`)
  await first.close()
  await pending
  const saved = (report.savedBytes = (await fs.stat(partial)).size)
  assert.ok(saved >= 2 * 1024 * 1024)
  const restart = (active = new MediaTools(base, config, console.log))
  const result = await restart.ensure()
  assert.ok(
    trace.some((x) => x.status === 206 && x.range === `bytes=${saved}-`),
    'No real HTTP 206 continuation of saved bytes',
  )
  const file = path.join(base, 'resume-test.mp4')
  await ffmpeg(
    result.ffmpeg,
    [
      '-nostdin',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x120:r=10',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100',
      '-t',
      '1',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      file,
    ],
    new AbortController().signal,
    base,
  )
  const media = await probe(result.ffprobe, file, new AbortController().signal)
  assert.equal(media.video, 'h264')
  assert.equal(media.audio, 'aac')
  Object.assign(report, {
    result: 'passed',
    versions: result.versions,
    media,
    manifests: await Promise.all(
      ['ffmpeg', 'ffprobe'].map(async (name) =>
        JSON.parse(await fs.readFile(path.join(path.dirname(result[name]), 'manifest.json'))),
      ),
    ),
  })
  console.log('PASS: real HTTP 206 resume, pinned SHA256, ffmpeg encoding and ffprobe validation')
}
main()
  .catch((error) => {
    report.error = error.message
    console.error(error.message)
    process.exitCode = 1
  })
  .finally(async () => {
    await active?.close()
    https.request = original
    await fs.mkdir(path.dirname(reportPath), { recursive: true })
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
    if (
      base &&
      path.dirname(path.resolve(base)) === path.resolve(os.tmpdir()) &&
      path.basename(base).startsWith('yunzai-live-download-')
    )
      await fs.rm(base, { recursive: true, force: true })
  })

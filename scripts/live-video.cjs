const { VideoProviders, identify } = require('../packages/video/lib/providers')
const { Media, probe } = require('../packages/video/lib/media')
const fs = require('node:fs/promises')
const path = require('node:path')
async function main() {
  const config = {
    timeout: 25000,
    proxy: process.env.PROBE_PROXY || '',
    biliCookie: '',
    douyinCookie: '',
    xhsCookie: '',
    maxHeight: 720,
    maxVideoMB: 40,
    cacheMB: 0,
    cacheMinutes: 0,
    ffmpeg: process.env.FFMPEG || 'ffmpeg',
    ffprobe: process.env.FFPROBE || 'ffprobe',
  }
  const provider = new VideoProviders(config),
    directory = path.resolve('artifacts/live-video')
  await fs.mkdir(directory, { recursive: true })
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 180000)
  const row = {
    checkedAt: new Date().toISOString(),
    site: 'bilibili',
    authenticated: false,
    result: 'failed',
  }
  try {
    const video = await provider.resolve(identify('BV1GJ411x7h7'), 1, controller.signal)
    const media = new Media(directory, provider, config)
    const bytes = await media.prepare(video, controller.signal)
    const file = path.join(directory, 'output.mp4')
    await fs.writeFile(file, bytes)
    Object.assign(row, {
      result: 'passed',
      id: video.id,
      bytes: bytes.length,
      media: await probe(config.ffprobe, file, controller.signal),
      jobDirectoriesRemaining: (await fs.readdir(media.root)).filter((name) => name.startsWith('job-'))
        .length,
    })
  } catch (e) {
    row.error = e.message
  } finally {
    clearTimeout(timer)
    await fs.rm(directory, { recursive: true, force: true })
  }
  await fs.writeFile('artifacts/live-video.json', JSON.stringify(row, null, 2) + '\n')
  console.log(JSON.stringify(row, null, 2))
}
main().catch((e) => {
  console.error(e.message)
  process.exitCode = 1
})

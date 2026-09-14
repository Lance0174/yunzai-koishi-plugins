// Publish one or all plugin packages to npm from the CI workflow (or locally).
// Usage: node scripts/publish-npm.cjs <all|group-manager|music|video> [version]
// In CI, NODE_AUTH_TOKEN (an npm automation token) is used; publishing with an
// automation token does not require a one-time password.
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const root = path.resolve(__dirname, '..')
const packages = ['group-manager', 'music', 'video']
const names = {
  'group-manager': 'koishi-plugin-yunzai-group-manager',
  music: 'koishi-plugin-yunzai-music-request',
  video: 'koishi-plugin-yunzai-video-parser',
}

const target = process.argv[2] ?? 'all'
if (!['all', ...packages].includes(target)) {
  console.error(`Unknown target "${target}". Use all or one of: ${packages.join(', ')}`)
  process.exit(1)
}
const expectedVersion = process.argv[3]

function versionOf(dir) {
  return JSON.parse(fs.readFileSync(path.join(root, 'packages', dir, 'package.json'), 'utf8')).version
}

const selected = target === 'all' ? packages : [target]
for (const dir of selected) {
  const version = versionOf(dir)
  if (expectedVersion && version !== expectedVersion)
    throw new Error(`${dir} version ${version} does not match tag version ${expectedVersion}`)
  console.log(`Publishing ${names[dir]}@${version}`)
  execFileSync(
    'npm',
    ['publish', '--access', 'public', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: path.join(root, 'packages', dir), stdio: 'inherit', env: { ...process.env } },
  )
  console.log(`Published ${names[dir]}@${version}`)
}
console.log('All requested packages published.')

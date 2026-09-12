const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const root = path.resolve(__dirname, '..'),
  destination = path.join(root, 'artifacts/packages')
const npm = process.env.npm_execpath
if (!npm) throw new Error('Run npm run pack:all so npm_execpath is available.')
fs.mkdirSync(destination, { recursive: true })
execFileSync(process.execPath, [npm, 'run', 'build'], { cwd: root, stdio: 'inherit', windowsHide: true })
const result = []
for (const folder of ['group-manager', 'music', 'video']) {
  const cwd = path.join(root, 'packages', folder)
  const [info] = JSON.parse(
    execFileSync(
      process.execPath,
      [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', destination],
      { cwd, encoding: 'utf8', windowsHide: true },
    ),
  )
  if (
    !info.files.some((file) => file.path === 'lib/index.js') ||
    !info.files.some((file) => file.path === 'README.md')
  )
    throw new Error('Package is incomplete: ' + folder)
  if (info.files.some((file) => /(^|\/)(node_modules|test|src|\.env|artifacts)(\/|$)/.test(file.path)))
    throw new Error('Unexpected packaged file: ' + folder)
  const hash = createHash('sha256')
    .update(fs.readFileSync(path.join(destination, info.filename)))
    .digest('hex')
  result.push({
    name: info.name,
    version: info.version,
    file: info.filename,
    bytes: info.size,
    sha256: hash,
    files: info.files.map((file) => file.path),
  })
}
fs.writeFileSync(
  path.join(destination, 'SHA256SUMS'),
  result.map((item) => `${item.sha256}  ${item.file}`).join('\n') + '\n',
)
fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(result, null, 2) + '\n')
console.log(
  JSON.stringify(
    result.map(({ files, ...item }) => item),
    null,
    2,
  ),
)

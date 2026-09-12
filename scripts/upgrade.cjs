// Run inside Koishi after uploading group/music 0.3.0 and video 0.3.1 tarballs.
// Keeps YAML formatting and comments; never prints configuration values.
const fs = require('node:fs')
const path = require('node:path')
const names = ['group-manager', 'music-request', 'video-parser']
const version = '0.3.1'
const versions = { 'group-manager': '0.3.0', 'music-request': '0.3.0', 'video-parser': '0.3.1' }

function migrateYaml(content) {
  let plugin = '',
    pluginIndent = -1,
    skipIndent = -1
  const result = []
  for (let line of content.split(/\r?\n/)) {
    const indent = line.match(/^\s*/)[0].length
    const meaningful = line.trim() && !line.trimStart().startsWith('#')
    if (skipIndent >= 0) {
      if (!meaningful || indent > skipIndent) continue
      skipIndent = -1
    }
    if (meaningful && indent <= pluginIndent) {
      plugin = ''
      pluginIndent = -1
    }
    for (const name of names) {
      const pattern = new RegExp(`^(\\s*["']?~?)(?:ember|yunzai)-${name}(?=[:"'])`)
      if (pattern.test(line)) {
        plugin = name
        pluginIndent = indent
        line = line.replace(pattern, `$1yunzai-${name}`)
        break
      }
    }
    const remove =
      plugin === 'music-request'
        ? /^\s*(?:qqCookie|neteaseCookie|kugouCookie):/
        : plugin === 'group-manager'
          ? /^\s*managedGroups:/
          : /$a/
    if (indent > pluginIndent && remove.test(line)) {
      skipIndent = indent
      continue
    }
    result.push(line)
  }
  return result.join('\n')
}
function migrateJson(value) {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(migrateJson)
  const output = {}
  for (const [key, original] of Object.entries(value)) {
    const renamed = key.replace(/^(~?)ember-(group-manager|music-request|video-parser)(?=:|$)/, '$1yunzai-$2')
    let entry = migrateJson(original)
    if (/^~?yunzai-music-request(?=:|$)/.test(renamed) && entry && typeof entry === 'object')
      for (const name of ['qqCookie', 'neteaseCookie', 'kugouCookie']) delete entry[name]
    if (/^~?yunzai-group-manager(?=:|$)/.test(renamed) && entry && typeof entry === 'object')
      delete entry.managedGroups
    if (Object.hasOwn(output, renamed)) throw new Error('配置同时存在新旧插件键，请先合并重复配置。')
    output[renamed] = entry
  }
  return output
}
function prepare(directory) {
  const project = path.resolve(directory),
    file = path.join(project, 'package.json')
  const original = fs.readFileSync(file, 'utf8'),
    manifest = JSON.parse(original)
  if (!manifest.dependencies) manifest.dependencies = {}
  for (const name of names) {
    const tarball = `koishi-plugin-yunzai-${name}-${versions[name]}.tgz`
    if (!fs.existsSync(path.join(project, tarball)) || fs.statSync(path.join(project, tarball)).size === 0)
      throw new Error(`请先把 ${tarball} 放到当前 Koishi 项目目录。`)
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'])
      if (manifest[section]) delete manifest[section][`koishi-plugin-ember-${name}`]
    manifest.dependencies[`koishi-plugin-yunzai-${name}`] = `file:./${tarball}`
  }
  const imageName = 'koishi-plugin-telegraph-image-manager',
    image = manifest.dependencies[imageName]
  if (
    typeof image === 'string' &&
    image.startsWith('file:') &&
    !fs.existsSync(path.resolve(project, image.slice(5)))
  )
    manifest.dependencies[imageName] = '0.1.2'
  const changes = [{ file, original, content: JSON.stringify(manifest, null, 2) + '\n' }]
  for (const name of ['koishi.yml', 'koishi.yaml', 'koishi.json']) {
    const file = path.join(project, name)
    if (!fs.existsSync(file)) continue
    const original = fs.readFileSync(file, 'utf8')
    const content = name.endsWith('.json')
      ? JSON.stringify(migrateJson(JSON.parse(original)), null, 2) + '\n'
      : migrateYaml(original)
    // Avoid creating a duplicate renamed YAML key in the same mapping.
    if (!name.endsWith('.json')) {
      const before =
        original.match(/^\s*["']?~?(?:ember|yunzai)-(?:group-manager|music-request|video-parser)[^\n]*/gm) ||
        []
      const seen = new Set()
      for (const key of before) {
        const canonical = key.trim().replace('ember-', 'yunzai-')
        if (seen.has(canonical)) throw new Error('发现重复的新旧插件配置键，请先合并。')
        seen.add(canonical)
      }
    }
    if (original !== content) changes.push({ file, original, content })
  }
  return changes
}
function main() {
  const changes = prepare(process.cwd()),
    write = process.argv.includes('--write')
  console.log(`${write ? '迁移' : '预览'}文件：${changes.map((c) => path.basename(c.file)).join('、')}。`)
  if (!write) return console.log('确认文件后执行 node ./升级迁移.cjs --write，再执行 yarn install。')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-'),
    applied = []
  try {
    for (const change of changes) {
      fs.writeFileSync(`${change.file}.pre-${version}.${stamp}.bak`, change.original, {
        mode: 0o600,
        flag: 'wx',
      })
      const temporary = `${change.file}.migration-${stamp}.tmp`
      try {
        fs.writeFileSync(temporary, change.content, { mode: fs.statSync(change.file).mode, flag: 'wx' })
        fs.renameSync(temporary, change.file)
        applied.push(change)
      } finally {
        fs.rmSync(temporary, { force: true })
      }
    }
  } catch (error) {
    for (const change of applied.reverse()) fs.writeFileSync(change.file, change.original)
    throw error
  }
  console.log(
    '已保存备份、替换包名与配置键，并移除旧 Cookie 和管理群范围字段。现在执行 yarn install，成功后重启 Koishi。',
  )
}
if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
module.exports = { migrateYaml, migrateJson, prepare }

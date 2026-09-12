const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { migrateYaml, migrateJson, prepare } = require('../scripts/upgrade.cjs')
test('upgrade preserves nested plugin identities and unrelated settings while removing old account inputs', () => {
  const input =
    'plugins:\n  group:demo:\n    ember-group-manager:one:\n      reviewers: ["1001"]\n      managedGroups:\n        - "600"\n      blackUsers: []\n    ~ember-music-request:two:\n      neteaseCookie: |\n        synthetic-secret\n      output: voice\n    other:\n      neteaseCookie: unrelated\n'
  const result = migrateYaml(input)
  assert.ok(result.includes('yunzai-group-manager:one:'))
  assert.ok(result.includes('~yunzai-music-request:two:'))
  assert.ok(result.includes('reviewers: ["1001"]'))
  assert.ok(result.includes('output: voice'))
  assert.ok(result.includes('neteaseCookie: unrelated'))
  assert.equal(result.includes('synthetic-secret'), false)
  assert.equal(result.includes('managedGroups'), false)
  assert.deepEqual(
    migrateJson({ plugins: { 'ember-music-request:id': { output: 'voice', qqCookie: 'synthetic' } } }),
    { plugins: { 'yunzai-music-request:id': { output: 'voice' } } },
  )
})
test('upgrade replaces missing legacy file dependencies, verifies new archives and backs up before writing', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'yunzai-upgrade-'))
  try {
    const original = JSON.stringify({
      name: 'koishi-instance',
      dependencies: {
        koishi: '4.18.11',
        'koishi-plugin-auto-mas': '0.0.2',
        'koishi-plugin-ember-video-parser': 'file:missing.tgz',
        'koishi-plugin-telegraph-image-manager': 'file:missing-image.tgz',
      },
    })
    fs.writeFileSync(path.join(folder, 'package.json'), original)
    assert.throws(() => prepare(folder), /请先/)
    assert.equal(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'), original)
    for (const name of ['group-manager', 'music-request', 'video-parser'])
      fs.writeFileSync(
        path.join(folder, `koishi-plugin-yunzai-${name}-${name === 'video-parser' ? '0.3.1' : '0.3.0'}.tgz`),
        'fixture',
      )
    fs.writeFileSync(
      path.join(folder, 'koishi.yml'),
      'plugins:\n  ember-video-parser:abc:\n    autoParse: true\n',
    )
    execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/upgrade.cjs'), '--write'], {
      cwd: folder,
      windowsHide: true,
    })
    const result = JSON.parse(fs.readFileSync(path.join(folder, 'package.json')))
    assert.equal(result.dependencies['koishi-plugin-auto-mas'], '0.0.2')
    assert.equal(result.dependencies.koishi, '4.18.11')
    assert.equal(result.dependencies['koishi-plugin-telegraph-image-manager'], '0.1.2')
    assert.equal(result.dependencies['koishi-plugin-ember-video-parser'], undefined)
    assert.equal(
      result.dependencies['koishi-plugin-yunzai-video-parser'],
      'file:./koishi-plugin-yunzai-video-parser-0.3.1.tgz',
    )
    assert.ok(fs.readdirSync(folder).some((name) => name.startsWith('koishi.yml.pre-0.3.1.')))
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

/**
 * entry.test.mjs — dsh 0.1.5-rc.1 适配守护测试（真实入口 + 声明面 + 键集合一致性）。
 *
 * 覆盖 dsh-plugin-audit 的盲区清单：
 *   1. 真实加载路径：直接 import('../src/index.js')（P0 级 import/顶层求值错误当场炸出）
 *   2. 声明面：version / exports / dsh.bundle.patch / dsh.client.platform
 *   3. engines 判定表：dsh.engines.dsh 与依赖包区间必须真的覆盖 0.1.5-rc.1
 *      （npm semver 预发布同元组规则），内置手写比较器 + 反证 + 与宿主真实
 *      semver.satisfies 逐行交叉验证
 *   4. 键集合一致性：host Config 键 === client FIELD_KEYS === cordis.patch.yml config 键
 *      （三处不等 = 静默调不到 / 静默丢配置）；client FIELD_VIEWS 必须是其带输入框的子集
 *   5. 依赖卫生：无安装期脚本
 *
 * 运行：node --test tests/*.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const clientSource = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const patchSource = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')

const ENTRY = await import('../src/index.js')

// ---------------------------------------------------------------------------
// 1. 真实入口加载（测试盲区封堵）
// ---------------------------------------------------------------------------

function makeCtx() {
  const registered = []
  const installs = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on() { return () => {} },
    inject(services, cb) {
      cb({ settings: { installSection(owner, ns, schema, entry, hooks) { installs.push({ owner, ns, schema, entry, hooks }) } } })
      return ctx
    },
    tools: { register(def) { registered.push(def); return () => {} } },
  }
  return { ctx, registered, installs }
}

test('entry: src/index.js 真实加载路径 + 导出面', () => {
  assert.equal(typeof ENTRY.apply, 'function')
  assert.equal(ENTRY.name, 'web-fetch')
  assert.equal(ENTRY.SETTINGS_NS, 'web-fetch')
  assert.equal(typeof ENTRY.Config, 'function')
  assert.deepEqual([...ENTRY.inject], ['tools', 'settings'])
  // apply 必须同步（Cordis 红线：await 后注册 effect 会抛 Invalid effect）
  const { ctx, registered, installs } = makeCtx()
  const ret = ENTRY.apply(ctx, { cdpEnabled: true, tavilyEnabled: false })
  assert.equal(ret, undefined)
  assert.equal(registered.length, 2, 'one tool per strategy')
  assert.deepEqual(registered.map((t) => t.name).sort(), ['web_fetch_cdp', 'web_fetch_tavily'])
  assert.equal(installs.length, 1)
  assert.equal(installs[0].ns, 'web-fetch')
  assert.equal(typeof installs[0].hooks.setSource, 'function')
  assert.equal(typeof installs[0].hooks.onChange, 'function')
})

test('entry: 每个工具都满足 host defineTool 的强制声明（output.schema + render）', () => {
  const { ctx, registered } = makeCtx()
  ENTRY.apply(ctx, {})
  for (const tool of registered) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 0)
    assert.equal(typeof tool.output, 'object', tool.name + ' must declare output')
    assert.equal(typeof tool.output.render, 'function', tool.name + ' must declare output.render')
    assert.equal(typeof tool.execute, 'function')
    assert.ok(tool.parameters && tool.parameters.properties && tool.parameters.properties.query,
      tool.name + ' must declare a query parameter')
  }
})

test('entry: settings.setSource 热更新活引用（闭包传参快照陷阱）', async () => {
  const { ctx, registered, installs } = makeCtx()
  ENTRY.apply(ctx, { cdpEnabled: false, tavilyEnabled: false })
  const { hooks } = installs[0]
  // 面板/文件把新值推到服务层，插件闭包必须跟上（否则禁用态永远是真的）
  hooks.setSource(() => ({ cdpEnabled: true, tavilyEnabled: false, cdpEndpoint: 'http://127.0.0.1:1' }))
  const cdp = registered.find((t) => t.name === 'web_fetch_cdp')
  // 启用后不应再抛「data source disabled」——改为走到真实连接失败路径
  let message = ''
  try { await cdp.execute({ query: 'example.com' }, undefined) } catch (err) { message = String(err.message) }
  assert.ok(!message.includes('data source disabled'),
    'execute must read the live source, not the apply-time snapshot; got: ' + message)
  assert.ok(/web-fetch \(cdp\)/.test(message), 'should fail later in the fetch path; got: ' + message)
})

test('entry: 禁用态抛错文案含字段名与当前值（可诊断）', async () => {
  const { ctx, registered } = makeCtx()
  ENTRY.apply(ctx, { cdpEnabled: false, tavilyEnabled: false })
  const cdp = registered.find((t) => t.name === 'web_fetch_cdp')
  await assert.rejects(() => cdp.execute({ query: 'https://example.com' }, undefined),
    (err) => err.message.includes('data source disabled') && err.message.includes('cdpEnabled'))
})

// ---------------------------------------------------------------------------
// 2. 声明面
// ---------------------------------------------------------------------------

test('manifest: version / exports / bundle / client 平台声明', () => {
  assert.equal(pkg.version, '0.1.5-rc.1')
  assert.equal(pkg.main, 'src/index.js')
  assert.equal(pkg.exports['.'], './src/index.js')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  for (const f of ['src', 'lib', 'tests', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(pkg.files.includes(f), 'files must ship ' + f)
  }
})

// ---------------------------------------------------------------------------
// 3. engines 判定表（内置手写比较器，不引 semver 依赖）
// ---------------------------------------------------------------------------

function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text).trim())
  if (!m) return undefined
  return {
    major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]),
    pre: m[4] === undefined ? [] : m[4].split('.'),
  }
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1   // release > prerelease
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1 }
    else if (nx !== ny) return nx ? -1 : 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function compare(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  return comparePrerelease(a.pre, b.pre)
}

/** npm semver 预发布规则的最小实现：只支持 '>=X.Y.Z[-pre] <A.B.C[-pre]' 的 '||' 组合。 */
function satisfies(version, range) {
  const v = parseVersion(version)
  if (v === undefined) return false
  return String(range).split('||').some((clause) => {
    const terms = clause.trim().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return false
    const bounds = []
    for (const term of terms) {
      const match = /^(>=|<)(.+)$/.exec(term)
      if (match === null) return false
      const bound = parseVersion(match[2])
      if (bound === undefined) return false
      bounds.push({ op: match[1], version: bound })
    }
    for (const bound of bounds) {
      const order = compare(v, bound.version)
      if (bound.op === '>=' && order < 0) return false
      if (bound.op === '<' && order >= 0) return false
    }
    // 预发布版本只被「区间内含同一 [major,minor,patch] 元组的预发布」满足
    if (v.pre.length > 0) {
      const anchored = bounds.some((bound) =>
        bound.version.major === v.major &&
        bound.version.minor === v.minor &&
        bound.version.patch === v.patch &&
        bound.version.pre.length > 0)
      if (!anchored) return false
    }
    return true
  })
}

const DECLARED = pkg.dsh.engines.dsh
const OLD_RANGE = '>=0.1.2-alpha.3 <0.2.0'
const DEP_RANGES = [
  ['@deepseek-ai/dsh-settings', pkg.dependencies['@deepseek-ai/dsh-settings']],
  ['@deepseek-ai/dsh-tools', pkg.dependencies['@deepseek-ai/dsh-tools']],
]

// 判定表（左：版本；右：是否被声明区间覆盖）
const DECISION_TABLE = [
  ['0.1.2-alpha.3', true],
  ['0.1.2-rc.1', true],
  ['0.1.3', true],
  ['0.1.4', true],
  ['0.1.5-alpha.1', true],
  ['0.1.5-rc.1', true],
  ['0.1.5', true],
  ['0.1.6', true],
  ['0.1.9-alpha.1', false],
  ['0.2.0', false],
]

test('engines: 判定表逐行命中 dsh.engines.dsh 与全部 dsh 依赖区间', () => {
  for (const [version, expected] of DECISION_TABLE) {
    assert.equal(satisfies(version, DECLARED), expected, 'dsh.engines.dsh must ' + (expected ? 'cover ' : 'exclude ') + version)
    for (const [name, range] of DEP_RANGES) {
      assert.equal(satisfies(version, range), expected,
        'dependency range for ' + name + ' must ' + (expected ? 'cover ' : 'exclude ') + version)
    }
  }
  // 声称适配的宿主版本必须真的被覆盖
  assert.equal(satisfies('0.1.5-rc.1', DECLARED), true, 'declared adaptation target must be covered by its own range')
})

test('engines: 反证——旧单区间覆盖不了 0.1.5-rc.1（这正是本轮修复的缺陷）', () => {
  assert.equal(satisfies('0.1.5-rc.1', OLD_RANGE), false)
  assert.equal(satisfies('0.1.2-rc.1', OLD_RANGE), true)
  assert.notEqual(DECLARED, OLD_RANGE)
  // 每一处携带 dsh 版本区间的字段都必须换掉旧区间（漏一处 = 声明与事实不符）
  for (const [name, range] of DEP_RANGES) assert.notEqual(range, OLD_RANGE, name + ' still carries the stale range')
})

test('engines: 与宿主真实 semver.satisfies 逐行交叉验证', () => {
  let semver
  try {
    const require = createRequire('/usr/lib/node_modules/@deepseek-ai/dsh/package.json')
    semver = require('semver')
  } catch {
    semver = undefined
  }
  if (semver === undefined) {
    console.log('SKIP: host semver not resolvable in this environment — hand-rolled comparator assertions still ran')
    return
  }
  let crossChecked = 0
  for (const [version, expected] of DECISION_TABLE) {
    assert.equal(semver.satisfies(version, DECLARED), expected, 'host semver disagrees for ' + version)
    for (const [name, range] of DEP_RANGES) {
      assert.equal(semver.satisfies(version, range), expected, 'host semver disagrees for ' + name + ' at ' + version)
    }
    assert.equal(semver.satisfies(version, OLD_RANGE), satisfies(version, OLD_RANGE), 'comparator drift at ' + version)
    crossChecked += 1
  }
  assert.ok(crossChecked > 0)
})

// ---------------------------------------------------------------------------
// 4. 键集合一致性（host schema ↔ client 表单 ↔ 补丁 config）
// ---------------------------------------------------------------------------

function extract(source, pattern, label) {
  const match = pattern.exec(source)
  assert.ok(match !== null, 'could not extract ' + label)
  return match
}

test('keys: host Config 键 === client FIELD_KEYS === cordis.patch.yml config 键', () => {
  const hostKeys = Object.keys(ENTRY.Config.dict ?? {}).sort()
  assert.ok(hostKeys.length > 0, 'host Config must expose its key set via .dict')

  const fieldsBlock = extract(clientSource, /const FIELD_KEYS=\[([\s\S]*?)\]/, 'FIELD_KEYS')[1]
  const clientKeys = [...fieldsBlock.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map((m) => m[1]).sort()

  const configBlock = extract(patchSource, /- insert:[\s\S]*$/, 'patch insert block')[0]
  const patchKeys = [...configBlock.matchAll(/^\s{8}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]).sort()

  assert.deepEqual(hostKeys, clientKeys,
    'host schema and client form must agree, else the toggle is silently unreachable')
  assert.deepEqual(hostKeys, patchKeys,
    'host schema and the shipped patch config must agree, else a key is silently dropped')
})

test('keys: client FIELD_VIEWS 是 FIELD_KEYS 的带输入框子集（开关单独渲染）', () => {
  const fieldsBlock = extract(clientSource, /const FIELD_KEYS=\[([\s\S]*?)\]/, 'FIELD_KEYS')[1]
  const clientKeys = new Set([...fieldsBlock.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map((m) => m[1]))

  const viewsBlock = extract(clientSource, /const FIELD_VIEWS = \[([\s\S]*?)\n    \]/, 'FIELD_VIEWS')[1]
  const viewKeys = [...viewsBlock.matchAll(/key:"([A-Za-z][A-Za-z0-9]*)"/g)].map((m) => m[1])

  assert.ok(viewKeys.length > 0, 'FIELD_VIEWS must not be empty')
  for (const key of viewKeys) {
    assert.ok(clientKeys.has(key), 'FIELD_VIEWS key must also exist in FIELD_KEYS: ' + key)
  }
  // 两个开关由 ToggleField 单独渲染，不应出现在行级字段视图里
  assert.ok(!viewKeys.includes('cdpEnabled'), 'boolean toggles get their own renderer')
  assert.ok(!viewKeys.includes('tavilyEnabled'), 'boolean toggles get their own renderer')
  assert.equal(viewKeys.length, clientKeys.size - 2, 'every non-toggle field must have a row view')
})

// ---------------------------------------------------------------------------
// 5. 依赖卫生
// ---------------------------------------------------------------------------

test('hygiene: 无安装期脚本、无原生编译依赖', () => {
  const lifecycle = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly']
  for (const key of lifecycle) {
    assert.ok(!(pkg.scripts && pkg.scripts[key]), 'must not declare a lifecycle script: ' + key)
  }
  const declared = Object.keys(pkg.dependencies ?? {})
  assert.deepEqual(declared.sort(), ['@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery'])
  assert.deepEqual(Object.keys(pkg.optionalDependencies ?? {}), [])
})


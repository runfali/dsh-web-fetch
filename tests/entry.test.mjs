/**
 * entry.test.mjs —— dsh 0.1.7-rc.1 适配守护测试（真实入口 + 声明面 + 键集合一致性）。
 *
 * 覆盖 dsh-plugin-audit 的盲区清单：
 *   1. 真实加载路径：直接 import('../src/index.js')（P0 级 import/顶层求值错误当场炸出）
 *   2. 0.1.7 设置契约：Config 必须导出、八个可编辑字段必须 .volatile()、apply 必须
 *      注册 {auto:false} 展示策略（否则插件页无配置项），且热更新经 volatile 活引用到达 execute
 *   3. 声明面：version / exports / dsh.bundle.patch / dsh.client.platform / peer 区间
 *   4. engines 判定表：dsh.engines.dsh 与 dsh peer 区间必须覆盖 0.1.7-rc.1（npm semver
 *      预发布同元组规则），内置手写比较器 + 反证 + 与真实 semver.satisfies 逐行交叉验证
 *   5. 键集合一致性：host Config 键 === client FIELD_KEYS === cordis.patch.yml config 键
 *   6. 依赖卫生：无安装期脚本
 *
 * 运行：node tests/entry.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let passed = 0
const ok = (label) => { passed += 1; console.log('  ✓ ' + label) }

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const clientSource = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const patchSource = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')

const ENTRY = await import('../src/index.js')

// ---------------------------------------------------------------------------
// 1. 真实入口加载 + 0.1.7 设置契约
// ---------------------------------------------------------------------------

function makeCtx() {
  const registered = []
  const seen = { configure: 0, autoPolicy: undefined, injects: [], effects: 0 }
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    fiber: { id: 'test-fiber' },
    effect(fn) { seen.effects += 1; const d = fn(); return typeof d === 'function' ? d : () => {} },
    on() { return () => {} },
    inject(services, cb) {
      seen.injects.push(services)
      cb({
        settings: {
          configure(presentation, owner) { seen.configure += 1; seen.autoPolicy = presentation && presentation.auto; return () => {} },
        },
        effect: ctx.effect,
        on: ctx.on,
        fiber: ctx.fiber,
      })
      return () => {}
    },
    tools: { register(def) { registered.push(def); return () => {} } },
  }
  return { ctx, registered, seen }
}

assert.equal(typeof ENTRY.apply, 'function')
assert.equal(ENTRY.name, 'web-fetch')
assert.equal(ENTRY.SETTINGS_NS, 'web-fetch')
assert.equal(typeof ENTRY.Config, 'function', 'Config 必须从模块导出（0.1.7 命名空间来源）')
assert.equal(typeof ENTRY.readField, 'function', 'readField 必须导出（volatile 解引用契约）')
assert.deepEqual([...ENTRY.inject], ['tools'], 'tools 是硬依赖；settings 走 apply 内等待式注入')
ok('宿主入口真实 import 成功（apply / name / SETTINGS_NS / Config / readField / inject）')

const CONFIG_KEYS = ['cdpEnabled', 'cdpEndpoint', 'cdpTimeoutMs', 'cdpWaitMs', 'tavilyEnabled', 'tavilyEndpoint', 'tavilyApiKey', 'tavilyTimeoutMs']
for (const key of CONFIG_KEYS) {
  assert.ok(ENTRY.Config.dict[key], 'Config 缺字段 ' + key)
  assert.equal(ENTRY.Config.dict[key].meta?.volatile, true,
    'Config.' + key + ' 必须 .volatile()——0.1.7 的 describe()/write() 只认 volatile 路径，非 volatile 字段在设置页写不进去')
}
ok('Config 八个可编辑字段均为 .volatile()（0.1.7 热编辑契约，键集合 = ' + CONFIG_KEYS.length + '）')

// apply 必须同步（Cordis 红线：await 后注册 effect 会抛 Invalid effect），且必须注册展示策略
{
  const { ctx, registered, seen } = makeCtx()
  const ret = ENTRY.apply(ctx, { cdpEnabled: true, tavilyEnabled: false })
  assert.equal(ret, undefined, 'apply 必须同步返回 undefined')
  assert.equal(seen.configure, 1, 'apply 必须经 ctx.inject(["settings"]) 调 settings.configure 一次')
  assert.equal(seen.autoPolicy, false, '必须注册 {auto:false}（关闭宿主自动默认页，卡片由 client 半提供）')
  assert.deepEqual(seen.injects, [['settings']], 'apply 内必须等待式注入 settings 服务')
  assert.equal(registered.length, 2, 'one tool per strategy')
  assert.deepEqual(registered.map((t) => t.name).sort(), ['web_fetch_cdp', 'web_fetch_tavily'])
}
ok('apply：同步 / configure({auto:false}) / 等待式注入 settings / 两工具注册')

// 热更新：volatile 活引用必须每条 execute 现读（0.1.7 设置页保存即时生效的机制本体）
{
  const live = { cdpEnabled: false, tavilyEnabled: false }
  const volatileRow = {
    cdpEnabled: { get: () => live.cdpEnabled },
    tavilyEnabled: { get: () => live.tavilyEnabled },
    cdpEndpoint: { get: () => 'http://127.0.0.1:1' },
  }
  const { ctx, registered } = makeCtx()
  ENTRY.apply(ctx, volatileRow)
  const cdp = registered.find((t) => t.name === 'web_fetch_cdp')
  await assert.rejects(() => cdp.execute({ url: 'https://example.com' }, undefined),
    (err) => err.message.includes('data source disabled'), '初始禁用态应报禁用')
  live.cdpEnabled = true  // 模拟设置页保存：同一个活引用换了值
  let message = ''
  try { await cdp.execute({ url: 'example.com' }, undefined) } catch (err) { message = String(err.message) }
  assert.ok(!message.includes('data source disabled'),
    'execute 必须现读 volatile 活引用（否则设置页保存后仍读旧值）：' + message)
  assert.ok(/web-fetch \(cdp\)/.test(message), '启用后应走到真实连接失败路径；' + message)
}
ok('热更新：volatile 活引用逐次现读（设置页保存即时生效）')

// 兼容：非 volatile 裸值形状（旧宿主 / 纯对象行）同样可用
{
  const { ctx, registered } = makeCtx()
  ENTRY.apply(ctx, { cdpEnabled: true, tavilyEnabled: false, cdpEndpoint: 'http://127.0.0.1:1' })
  const cdp = registered.find((t) => t.name === 'web_fetch_cdp')
  let message = ''
  try { await cdp.execute({ url: 'example.com' }, undefined) } catch (err) { message = String(err.message) }
  assert.ok(!message.includes('data source disabled'), '裸值形状不应被判为禁用：' + message)
}
ok('兼容：非 volatile 裸值配置形状仍可用')

// 每个工具都满足 host defineTool 的强制声明（output.schema + render）
{
  const { ctx, registered } = makeCtx()
  ENTRY.apply(ctx, {})
  for (const tool of registered) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 0)
    assert.equal(typeof tool.output, 'object', tool.name + ' must declare output')
    assert.equal(typeof tool.output.render, 'function', tool.name + ' must declare output.render')
    assert.equal(typeof tool.execute, 'function')
    assert.ok(tool.parameters && tool.parameters.properties && tool.parameters.properties.url,
      tool.name + ' must declare a url parameter')
    assert.equal(Object.hasOwn(tool.parameters.properties, 'query'), false,
      tool.name + ' must not declare a legacy query parameter (renamed to url)')
  }
}
ok('两工具声明面完整（output.schema + render + url 参数）')

// 禁用态抛错文案可诊断（含插件页指引，不含已废弃的 Settings 入口）
{
  const { ctx, registered } = makeCtx()
  ENTRY.apply(ctx, { cdpEnabled: false, tavilyEnabled: false })
  const cdp = registered.find((t) => t.name === 'web_fetch_cdp')
  await assert.rejects(() => cdp.execute({ url: 'https://example.com' }, undefined),
    (err) => err.message.includes('data source disabled') && err.message.includes('cdpEnabled') && err.message.includes('Plugins page'))
}
ok('禁用态文案含字段名 + 当前值 + 插件页指引')

// ---------------------------------------------------------------------------
// 2. 声明面
// ---------------------------------------------------------------------------

assert.equal(pkg.version, '0.1.7-rc.1', '版本号必须跟宿主发布号（家族惯例）')
assert.equal(pkg.main, 'src/index.js')
assert.equal(pkg.exports['.'], './src/index.js')
assert.equal(pkg.exports['./client'], './lib/client.js')
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml', 'dsh.bundle.patch 必须声明（装上≠挂载）')
assert.equal(pkg.dsh.client.platform, 'web')
for (const f of ['src', 'lib', 'tests', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
  assert.ok(pkg.files.includes(f), 'files must ship ' + f)
}
ok('manifest：version 0.1.7-rc.1 / exports / bundle patch / client 平台声明')

// ---------------------------------------------------------------------------
// 3. engines 判定表（内置手写比较器，不引 semver 依赖）
// ---------------------------------------------------------------------------

function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text).trim())
  if (!m) return undefined
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] === undefined ? [] : m[4].split('.') }
}
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i]; const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x); const ny = /^\d+$/.test(y)
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1 }
    else if (nx !== ny) return nx ? -1 : 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}
function compare(a, b) {
  for (const key of ['major', 'minor', 'patch']) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
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
    if (v.pre.length > 0) {
      const anchored = bounds.some((bound) =>
        bound.version.major === v.major && bound.version.minor === v.minor && bound.version.patch === v.patch && bound.version.pre.length > 0)
      if (!anchored) return false
    }
    return true
  })
}

const DECLARED = pkg.dsh.engines.dsh
const OLD_RANGE = '>=0.1.2-alpha.3 <0.2.0'
const DEP_RANGES = [
  ['@deepseek-ai/dsh (peer)', pkg.peerDependencies['@deepseek-ai/dsh']],
  ['@deepseek-ai/dsh-settings (peer)', pkg.peerDependencies['@deepseek-ai/dsh-settings']],
  ['@deepseek-ai/dsh-tools (peer)', pkg.peerDependencies['@deepseek-ai/dsh-tools']],
]
const DECISION_TABLE = [
  ['0.1.2-alpha.3', true],
  ['0.1.2-rc.1', true],
  ['0.1.3', true],
  ['0.1.4', true],
  ['0.1.5-alpha.1', true],
  ['0.1.5-rc.1', true],
  ['0.1.5', true],
  ['0.1.6', true],
  ['0.1.7-alpha.1', true],
  ['0.1.7-rc.1', true],
  ['0.1.7', true],
  ['0.1.9-alpha.1', false],
  ['0.2.0', false],
]

for (const [version, expected] of DECISION_TABLE) {
  assert.equal(satisfies(version, DECLARED), expected, 'dsh.engines.dsh must ' + (expected ? 'cover ' : 'exclude ') + version)
  for (const [name, range] of DEP_RANGES) {
    assert.equal(satisfies(version, range), expected, 'peer range for ' + name + ' must ' + (expected ? 'cover ' : 'exclude ') + version)
  }
}
assert.deepEqual([...ENTRY.inject], ['tools'], 'inject 声明不得回退')
ok('engines 判定表 ' + DECISION_TABLE.length + ' 行逐行通过（含 0.1.7-rc.1 覆盖 / 0.1.9-alpha.1 与 0.2.0 排除）')

assert.equal(satisfies('0.1.7-rc.1', OLD_RANGE), false, '旧单区间本不应覆盖 0.1.7-rc.1，判定器写反了')
assert.notEqual(DECLARED, OLD_RANGE)
ok('反证：旧单区间不覆盖 0.1.7-rc.1（故析取区间非冗余声明）')

{
  const req = createRequire(import.meta.url)
  let semver
  for (const candidate of ['semver', 'C:/Users/Doctor/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/semver']) {
    try { semver = req(candidate); break } catch { /* next */ }
  }
  if (semver && typeof semver.satisfies === 'function') {
    for (const [version, expected] of DECISION_TABLE) {
      assert.equal(semver.satisfies(version, DECLARED), expected, 'real semver disagrees for ' + version)
      for (const [name, range] of DEP_RANGES) assert.equal(semver.satisfies(version, range), expected, 'real semver disagrees for ' + name + ' at ' + version)
    }
    ok('内置判定器与真实 semver.satisfies 逐行一致（' + DECISION_TABLE.length + ' 行 × ' + (1 + DEP_RANGES.length) + ' 个区间）')
  } else {
    ok('semver 不可解析，跳过交叉验证（不假绿）')
  }
}

// ---------------------------------------------------------------------------
// 4. 键集合一致性（host schema ↔ client 表单 ↔ 补丁 config）
// ---------------------------------------------------------------------------

function extract(source, pattern, label) {
  const match = pattern.exec(source)
  assert.ok(match !== null, 'could not extract ' + label)
  return match
}

const hostKeys = Object.keys(ENTRY.Config.dict ?? {}).sort()
assert.deepEqual(hostKeys, [...CONFIG_KEYS].sort(), 'host Config 键集合漂移')

const fieldsBlock = extract(clientSource, /const FIELD_KEYS=\[([\s\S]*?)\]/, 'FIELD_KEYS')[1]
const clientKeys = [...fieldsBlock.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map((m) => m[1]).sort()

const configBlock = extract(patchSource, /- insert:[\s\S]*$/, 'patch insert block')[0]
const patchKeys = [...configBlock.matchAll(/^\s{8}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]).sort()

assert.deepEqual(hostKeys, clientKeys, 'host schema 与 client 表单必须逐键相等，否则开关静默调不到')
assert.deepEqual(hostKeys, patchKeys, 'host schema 与随包补丁 config 必须逐键相等，否则某键被静默丢弃')
ok('三处键集合逐键相等（Config ↔ client FIELD_KEYS ↔ cordis.patch.yml）')

const viewsBlock = extract(clientSource, /const FIELD_VIEWS = \[([\s\S]*?)\n    \]/, 'FIELD_VIEWS')[1]
const viewKeys = [...viewsBlock.matchAll(/key:"([A-Za-z][A-Za-z0-9]*)"/g)].map((m) => m[1])
for (const key of viewKeys) assert.ok(clientKeys.includes(key), 'FIELD_VIEWS key must exist in FIELD_KEYS: ' + key)
assert.ok(!viewKeys.includes('cdpEnabled') && !viewKeys.includes('tavilyEnabled'), '布尔开关单独渲染，不应出现在行级字段视图')
assert.equal(viewKeys.length, clientKeys.length - 2, '每个非开关字段都必须有行视图')
ok('client FIELD_VIEWS 是 FIELD_KEYS 的输入框子集（两个开关单独渲染）')

// ---------------------------------------------------------------------------
// 5. 依赖卫生
// ---------------------------------------------------------------------------

const lifecycle = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly']
for (const key of lifecycle) assert.ok(!(pkg.scripts && pkg.scripts[key]), 'must not declare a lifecycle script: ' + key)
assert.equal(pkg.dependencies, undefined, '零运行时 dependencies（只声明 peerDependencies）')
assert.equal(pkg.optionalDependencies, undefined, '不得声明 optionalDependencies')
ok('依赖卫生：无安装期脚本、无 runtime dependencies（peer-only）')

console.log('\n全部通过: ' + passed + ' 组')

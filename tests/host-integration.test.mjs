/**
 * host-integration.test.mjs —— 真宿主对象契约测试（不是自造桩）。
 *
 * 用装在本机的 dsh 0.1.7-rc.1 真实包（@deepseek-ai/cordis + dsh-tools +
 * dsh-system-prompt + dsh-settings）驱动本插件，封堵 dsh-plugin-audit 的
 * 「契约形状盲区」——自造 ctx 桩永远验不出 host 真实现是否接受我们的载荷：
 *   1. 真实 Cordis Context + 真实 ToolRuntime 上 apply 合法（工具进真注册表）
 *   2. 工具定义被 host 的 defineTool 强制声明校验接受（output.schema + render）
 *   3. 真 schema 校验：execute 前 host 就挡掉非法参数（含旧参数名 query）
 *   4. 端到端 execute + 真 render 输出
 *   5. 0.1.7 设置命名空间契约（真 SettingsForms 服务）：describe() 必须枚举到
 *      web-fetch、volatile 字段可写、非 volatile 字段被排除（本条守护「插件页没有
 *      配置入口」那类真机 P1：Config 未导出 / 字段没 .volatile() 时命名空间消失）
 *
 * 依赖解析：插件自身 node_modules（开发依赖，与宿主同版本）→ 宿主安装目录；
 * 解析不到时显式 skip 并打印原因（不假绿）。
 *
 * 运行：node tests/host-integration.test.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

let passed = 0
const ok = (label) => { passed += 1; console.log('  ✓ ' + label) }

const HOST_PKG = 'C:/Users/Doctor/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json'
const { apply, SETTINGS_NS, Config } = await import('../src/index.js')

/** 解析包的安装目录：插件开发依赖优先，其次宿主安装目录。 */
function resolveDepDir(name) {
  for (const from of [import.meta.url, HOST_PKG]) {
    try {
      return dirname(createRequire(from).resolve(name + '/package.json'))
    } catch { /* try next */ }
  }
  return undefined
}

/** 按包自身 exports/main 解析 ESM 入口并真实 import（不猜文件布局）。 */
async function loadDep(name) {
  const dir = resolveDepDir(name)
  if (dir === undefined) return undefined
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const entry = manifest.exports?.['.']
  const rel = typeof entry === 'string'
    ? entry
    : (entry?.import ?? entry?.default ?? manifest.module ?? manifest.main)
  return import(pathToFileURL(join(dir, rel)).href)
}

const DEP_NAMES = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-settings']
const missing = DEP_NAMES.filter((name) => resolveDepDir(name) === undefined)

if (missing.length > 0) {
  console.log('SKIP: unresolvable host deps: ' + missing.join(', '))
  process.exit(0)
}

const [cordisMod, toolsMod, promptMod, settingsMod] = await Promise.all([
  loadDep('@deepseek-ai/cordis'),
  loadDep('@deepseek-ai/dsh-tools'),
  loadDep('@deepseek-ai/dsh-system-prompt'),
  loadDep('@deepseek-ai/dsh-settings'),
])
const Context = cordisMod.Context ?? cordisMod.default?.Context
const resolveConfig = cordisMod.resolveConfig
const ToolRuntime = toolsMod.default ?? toolsMod.ToolRuntime
const SystemPrompt = promptMod.SystemPrompt
const SettingsForms = settingsMod.default ?? settingsMod.SettingsForms
assert.equal(typeof Context, 'function', 'real cordis Context must be constructible')
assert.equal(typeof ToolRuntime, 'function', 'real ToolRuntime must be constructible')
assert.equal(typeof SettingsForms, 'function', 'real SettingsForms must be constructible')
ok('真实宿主包可解析：cordis / dsh-tools / dsh-system-prompt / dsh-settings')

/** 搭真实工具宿主：真实 Context + 真实 ToolRuntime + 真实 SystemPrompt。 */
function makeHost(pluginConfig) {
  const root = new Context()
  const systemPrompt = new SystemPrompt(root, {})
  const tools = new ToolRuntime(root, { mode: 'native' })
  const ctx = root.extend({ systemPrompt, tools })
  apply(ctx, pluginConfig ?? {})
  return {
    ctx, tools,
    settle: () => new Promise((resolve) => setTimeout(resolve, 30)),
  }
}

/** 打桩 fetch 并记录调用；返回恢复函数。 */
function stubFetch(calls, payload = { results: [] }, ok2 = true, status = 200) {
  const real = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null })
    return { ok: ok2, status, json: async () => payload }
  }
  return () => { globalThis.fetch = real }
}

const SAMPLE = { results: [{ url: 'https://a.example', title: '<b>A</b>', content: 'alpha content body long enough' }] }

// ---------------------------------------------------------------------------
// 1. 真注册表 + schema 投影
// ---------------------------------------------------------------------------
{
  const host = makeHost({})
  await host.settle()
  const visible = [...host.tools.view().visible.keys()].sort()
  assert.deepEqual(visible, ['web_fetch_cdp', 'web_fetch_tavily'], 'host registry must carry both tools: ' + JSON.stringify(visible))
  const schemas = host.tools.schemas()
  const tavily = schemas.find((s) => s.name === 'web_fetch_tavily')
  assert.ok(tavily, 'schema projection must include the tavily tool')
  assert.ok(tavily.parameters.properties.url, 'url parameter must survive projection')
  assert.ok(!tavily.parameters.properties.query, 'legacy query parameter must be gone after the rename')
  assert.equal(typeof tavily.parameters.properties.maxResults.type, 'string', 'maxResults is a JSON-schema type string after compilation')
  ok('真实 ToolRuntime 接受两个工具注册，schema 投影保留 url / 去掉 query')
}

// ---------------------------------------------------------------------------
// 2. 端到端 execute（真 schemastery 校验 + 真 render）
// ---------------------------------------------------------------------------
{
  const host = makeHost({ cdpEnabled: false, tavilyEnabled: true, tavilyApiKey: 'k-test', tavilyEndpoint: 'https://api.tavily.com/extract' })
  await host.settle()
  const tool = host.tools.get('web_fetch_tavily')
  assert.ok(tool, 'tavily tool must be resolvable from the host registry')

  await assert.rejects(() => tool.execute({}, undefined),
    (err) => err.name === 'ToolArgsError' || /url/.test(String(err.message)),
    'host schema validation must reject a missing required parameter')
  await assert.rejects(() => tool.execute({ query: 'https://a.example' }, undefined),
    (err) => err.name === 'ToolArgsError' || /url|missing/i.test(String(err.message)),
    'the legacy name must be rejected, not silently accepted')

  const calls = []
  const restore = stubFetch(calls, SAMPLE)
  try {
    const value = await tool.execute({ url: 'https://a.example' }, { signal: undefined })
    assert.equal(calls.length, 1, 'exactly one upstream call')
    assert.equal(calls[0].url, 'https://api.tavily.com/extract')
    assert.deepEqual(calls[0].body.urls, ['https://a.example'], 'URL input must use the urls field')
    assert.equal(value.sources[0].url, 'https://a.example')
    assert.equal(value.sources[0].title, 'A', 'HTML must be stripped')
    const rendered = tool.output.render({}, value)
    assert.ok(Array.isArray(rendered) && rendered[0].type === 'text')
    assert.ok(rendered[0].text.includes('https://a.example'))
  } finally { restore() }
  ok('端到端 execute：真校验拦缺参/旧参数名，真 render 产出文本')
}

// ---------------------------------------------------------------------------
// 3. 0.1.7 设置命名空间契约（真 SettingsForms 服务 + 真 cordis Context）
// ---------------------------------------------------------------------------
/** 真 SettingsForms 需要 cordis Context 语义（Service 构造期经 ctx.reflect.provide
 * 自注册、ctx.on/ctx.effect 挂生命周期），故用真 Context + provide 出的三条服务桩：
 * loader / profileContext / configEditor。fiber 形状照宿主 describe() 的读取点构造
 * （fiber.runtime.Config 即 cordis runtime，正是「Config 未导出 ⇒ 命名空间消失」
 * 那条真机 P1 的判定点）。 */
function makeSettingsHarness() {
  const root = new Context()
  root.provide('loader', { await: () => Promise.resolve() })
  root.provide('profileContext', { home: join(tmpdir(), 'dsh-web-fetch-harness') })
  const entries = []
  const base = {}
  const userLayer = {}
  root.provide('configEditor', {
    entries: () => entries,
    configuration: () => entries.map((e) => ({ entry: e, inherited: base[e.options.id] ?? {}, override: userLayer[e.options.id] ?? {} })),
    documentPath: join(tmpdir(), 'cordis.patch.yml'),
    edit: async (entry, change) => {
      const id = entry.options.id
      userLayer[id] = await change(userLayer[id] ?? {}, base[id] ?? {})
    },
  })
  const settings = new SettingsForms(root)
  /** 追加一个入口：schema 传 undefined 即模拟「模块没导出 Config」。 */
  const addEntry = (id, schema) => {
    const runtime = { Config: schema }
    entries.push({
      id,
      options: { id, config: {} },
      fiber: { runtime, state: 2, uid: 'uid-' + id, config: resolveConfig(runtime, {}), ctx: root },
    })
  }
  return { settings, addEntry, userLayer }
}

{
  const harness = makeSettingsHarness()
  harness.addEntry(SETTINGS_NS, Config)
  const described = harness.settings.describe()
  const row = described.find((d) => d.ns === SETTINGS_NS)
  assert.ok(row, 'describe() 必须枚举到 ' + SETTINGS_NS + '（否则插件页没有配置入口）: ' + JSON.stringify(described.map((d) => d.ns)))
  assert.equal(row.applies, 'live', 'volatile 表单的 applies 必须是 live（原地提交，不重启 fiber）')
  const defaults = { cdpEnabled: true, cdpEndpoint: 'http://10.200.0.5:9222', cdpTimeoutMs: 60000, cdpWaitMs: 2000, tavilyEnabled: false, tavilyEndpoint: 'https://api.tavily.com/extract', tavilyApiKey: '', tavilyTimeoutMs: 30000 }
  assert.deepEqual(row.value, defaults, 'describe() 的 value 必须是 schema 默认值解析结果（八个 volatile 字段全在册）')
  assert.deepEqual(row.user, {}, '干净宿主上 user 层为空')
  ok('真 SettingsForms.describe()：web-fetch 命名空间可见 + 八个 volatile 字段默认值正确')

  await harness.settings.update(SETTINGS_NS, { tavilyEnabled: true, cdpTimeoutMs: 45000 })
  const written = harness.settings.describe().find((d) => d.ns === SETTINGS_NS)
  assert.deepEqual(written.user, { tavilyEnabled: true, cdpTimeoutMs: 45000 }, 'update() 必须把 volatile 字段写进 user 层')
  ok('真 SettingsForms.update()：volatile 字段可写并体现在 user 层')

  await assert.rejects(() => harness.settings.update(SETTINGS_NS, { nope: 1 }),
    /not volatile/, 'schema 之外的字段必须被 isVolatilePath 拒绝（写入面不静默扩张）')
  ok('真 SettingsForms.update()：schema 外字段被拒（写入面收敛）')
}

// 反证：缺 Config 导出 / 无 volatile 字段的入口必须不可见（否则上面的「可见」断言无意义）
{
  const z = (await import('@deepseek-ai/schemastery')).default
  const harness = makeSettingsHarness()
  harness.addEntry(SETTINGS_NS, Config)
  harness.addEntry('no-config-export', undefined)
  harness.addEntry('no-volatile-field', z.object({ enabled: z.boolean().default(true) }))
  const ns = harness.settings.describe().map((d) => d.ns)
  assert.ok(ns.includes(SETTINGS_NS), '本插件命名空间必须可见')
  assert.ok(!ns.includes('no-config-export'), '未导出 Config 的入口必须被 describe() 排除（真机 P1 形态：插件页无配置项）')
  assert.ok(!ns.includes('no-volatile-field'), '无 volatile 字段的入口必须被 describe() 排除')
  ok('反证：缺 Config / 无 volatile 字段的入口都被排除（判据非恒真）')
}

console.log('\n全部通过: ' + passed + ' 组')

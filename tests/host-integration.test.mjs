/**
 * host-integration.test.mjs —— 真宿主对象契约测试（不是自造桩）。
 *
 * 用装在本机的 dsh 0.1.5-rc.1 真实包（@deepseek-ai/cordis + dsh-tools +
 * dsh-system-prompt + dsh-settings-file）驱动本插件，封堵 dsh-plugin-audit 的
 * 「契约形状盲区」——自造 ctx 桩永远验不出 host 真实现是否接受我们的载荷：
 *   1. 真实 Cordis Context + 真实 ToolRuntime 上 apply 合法（同步 apply、工具入注册表）
 *   2. 工具定义被 host 的 defineTool 强制声明校验接受（output.schema + render）
 *   3. 真实文件型 settings provider：命名空间被 serve，工具调用读到活值
 *   4. 文档提交（模拟设置页保存）后工具行为立刻改变 = 热更新真的接通
 *   5. 真实 schema 校验：execute 前 host 会挡掉非法参数
 *
 * 依赖解析：插件自身 node_modules（开发依赖，与宿主同版本）→ 宿主安装目录；
 * 解析不到时显式 skip 并打印原因（不假绿）。
 *
 * 运行：node --test tests/host-integration.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HOST_PKG = '/usr/lib/node_modules/@deepseek-ai/dsh/package.json'
const { apply, SETTINGS_NS } = await import('../src/index.js')

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

const DEP_NAMES = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-settings-file']
const missing = DEP_NAMES.filter((name) => resolveDepDir(name) === undefined)

test('host-contract: 真实 dsh 依赖可解析（否则显式 skip，不假绿）', (t) => {
  if (missing.length > 0) return t.skip('unresolvable host deps: ' + missing.join(', '))
  assert.deepEqual(missing, [])
})

/**
 * 搭真实宿主：真实 Context + 真实 ToolRuntime + 真实 SystemPrompt + 真实文件型 SettingsProvider。
 * 全部是 host 自己的实现，插件面对的载荷形状与线上一致。
 */
async function makeHost(pluginConfig) {
  const [{ Context }, toolsMod, { SystemPrompt }, { FileSettingsProvider }] = await Promise.all([
    loadDep('@deepseek-ai/cordis'),
    loadDep('@deepseek-ai/dsh-tools'),
    loadDep('@deepseek-ai/dsh-system-prompt'),
    loadDep('@deepseek-ai/dsh-settings-file'),
  ])
  const ToolRuntime = toolsMod.default ?? toolsMod.ToolRuntime
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wf-'))
  const root = new Context()
  const systemPrompt = new SystemPrompt(root, {})
  const tools = new ToolRuntime(root, { mode: 'native' })
  const store = new FileSettingsProvider(root, { path: join(dir, 'settings.yaml'), watch: false })
  const ctx = root.extend({ systemPrompt, tools, settings: store })
  apply(ctx, pluginConfig ?? {})
  return {
    ctx, tools, store, dir,
    /** 宿主 effect 在 microtask 落地：等一拍再断言注册表。 */
    settle: () => new Promise((resolve) => setTimeout(resolve, 20)),
    cleanup() { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } },
  }
}

/** 打桩 fetch 并记录调用；返回恢复函数。 */
function stubFetch(calls, payload = { results: [] }, ok = true, status = 200) {
  const real = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null })
    return { ok, status, json: async () => payload }
  }
  return () => { globalThis.fetch = real }
}

const SAMPLE = {
  results: [
    { url: 'https://a.example', title: '<b>A</b>', content: 'alpha content body long enough' },
  ],
}

test('host-contract: 真实 ToolRuntime 接受两个工具注册，命名空间被 serve', async (t) => {
  if (missing.length > 0) return t.skip('unresolvable host deps: ' + missing.join(', '))
  const host = await makeHost({})
  try {
    await host.settle()
    // 宿主真实注册表里有我们的两个工具（不是我们自己的数组）
    const visible = [...host.tools.view().visible.keys()].sort()
    assert.deepEqual(visible, ['web_fetch_cdp', 'web_fetch_tavily'],
      'host registry must carry both tools: ' + JSON.stringify(visible))
    // 宿主真的 serve 了这个命名空间（设置卡挂到「插件配置」页的前提）
    const namespaces = host.store.describe().map((d) => d.ns)
    assert.ok(namespaces.includes(SETTINGS_NS),
      'host must serve the namespace: ' + JSON.stringify(namespaces))
    // schema 投影（喂给模型的形态）保留必填 url 参数
    const schemas = host.tools.schemas()
    const tavily = schemas.find((s) => s.name === 'web_fetch_tavily')
    assert.ok(tavily, 'schema projection must include the tavily tool')
    assert.ok(tavily.parameters.properties.url, 'url parameter must survive projection')
    assert.ok(!tavily.parameters.properties.query, 'legacy query parameter must be gone after the rename')
    assert.equal(typeof tavily.parameters.properties.maxResults.type, 'string',
      'maxResults is a JSON-schema type string after compilation')
  } finally { host.cleanup() }
})

test('host-contract: 端到端 execute——真 schemastery 解析的配置 + 真 fetch 桩', async (t) => {
  if (missing.length > 0) return t.skip('unresolvable host deps: ' + missing.join(', '))
  const host = await makeHost({
    cdpEnabled: false, tavilyEnabled: true,
    tavilyApiKey: 'k-test', tavilyEndpoint: 'https://api.tavily.com/extract',
  })
  try {
    await host.settle()
    const tool = host.tools.get('web_fetch_tavily')
    assert.ok(tool, 'tavily tool must be resolvable from the host registry')

    // host 的 defineTool 包装了 execute：非法参数应被 ToolArgsError 挡在业务前
    await assert.rejects(() => tool.execute({}, undefined),
      (err) => err.name === 'ToolArgsError' || /url/.test(String(err.message)),
      'host schema validation must reject a missing required parameter')

    // 回归：参数已由 query 改名为 url，旧名必须「响亮失败」而非静默降级。
    // 实测证据（真 host 探针）：execute({}) 与 execute({query:...}) 得到同一个
    // ToolArgsError: invalid arguments: missing required property "url"，
    // 且两者都没走到网络层（对照 execute({url:...}) 才发出真实请求）——
    // 即校验发生在 execute 之前。故任何「兼容旧名」的别名分支在真 host 上永不可达，
    // 写它就是死代码，只会伪装出健壮性。迁移友好性改由这条错误原文承担：
    // 它直接点出新参数名 url（README 亦有迁移说明）。
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
      assert.equal(value.sources.length, 1)
      assert.equal(value.sources[0].url, 'https://a.example')
      assert.equal(value.sources[0].title, 'A', 'HTML must be stripped')
      // render 回调是 host 契约的一部分：必须产出可渲染的 content 数组
      const rendered = tool.output.render({}, value)
      assert.ok(Array.isArray(rendered) && rendered[0].type === 'text')
      assert.ok(rendered[0].text.includes('https://a.example'))
    } finally { restore() }
  } finally { host.cleanup() }
})

test('host-contract: 文档提交后工具立刻读到新值（热更新真的接通，非 apply 快照）', async (t) => {
  if (missing.length > 0) return t.skip('unresolvable host deps: ' + missing.join(', '))
  const host = await makeHost({ tavilyEnabled: false, cdpEnabled: false })
  try {
    await host.settle()
    const tool = host.tools.get('web_fetch_tavily')
    // 初始禁用 → 明确报错
    await assert.rejects(() => tool.execute({ url: 'https://a.example' }, undefined),
      (err) => err.message.includes('data source disabled'))

    // 模拟设置页保存：文档提交到宿主 provider
    await host.store.update(SETTINGS_NS, { tavilyEnabled: true, tavilyApiKey: 'k-live' })
    const calls = []
    const restore = stubFetch(calls, SAMPLE)
    try {
      const value = await tool.execute({ url: 'https://a.example' }, undefined)
      assert.equal(calls.length, 1, 'live source must win over the apply-time snapshot')
      assert.equal(calls[0].body.api_key, 'k-live', 'the newly saved key must be sent')
      assert.equal(value.sources.length, 1)
    } finally { restore() }
  } finally { host.cleanup() }
})

test('host-contract: 真 settings provider 的默认值来自插件 schema，不是硬编码', async (t) => {
  if (missing.length > 0) return t.skip('unresolvable host deps: ' + missing.join(', '))
  const host = await makeHost({})
  try {
    await host.settle()
    const descriptor = host.store.describe().find((d) => d.ns === SETTINGS_NS)
    assert.ok(descriptor, 'namespace must be described')
    const value = descriptor.value
    // schema 的 .default() 经宿主解析后落到 resolved 值上
    assert.equal(value.cdpEnabled, true)
    assert.equal(value.cdpTimeoutMs, 60000)
    assert.equal(value.cdpWaitMs, 2000)
    assert.equal(value.tavilyEnabled, false)
    assert.equal(value.tavilyTimeoutMs, 30000)
    assert.equal(value.tavilyApiKey, '')
    assert.deepEqual(descriptor.user ?? {}, {}, 'no user layer written on a clean host')
  } finally { host.cleanup() }
})


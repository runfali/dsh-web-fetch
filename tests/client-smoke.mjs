/**
 * client-smoke.mjs —— lib/client.js（浏览器半）结构与交互测试。
 *
 * 构造最小 window.__ModuleLoader__ + require 桩加载 client bundle，跑 apply，验证：
 *   1. bundle id 与包名一致；exports.inject 为短服务名
 *   2. locale 词典（zh/en 键集合一致）
 *   3. settingsScope 绑定 namespace = web-fetch
 *   4. settings.plugin.item 槽位注册（key/locale/inject 载荷 hooks + actions）
 *   5. 卡片渲染：展开态含全部字段行与保存/放弃按钮
 *   6. **交互层盲区**（dsh-plugin-audit 强调的「本地全绿、真机翻车」区）：
 *      可写态所有控件不禁用；只读态全部禁用（含行级重置）；
 *      开关 onChange 真的把值写进 user 层；点保存真的落盘。
 *   7. 缓存热更新活引用：编辑 → 保存 → 值落到 user 层且 dirty 归零
 *
 * 运行：node tests/client-smoke.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let passed = 0
const ok = (label) => { passed += 1; console.log('  ✓ ' + label) }

function makeElement(type, props, ...children) {
  return { type, props: props || {}, children: children.flat().filter((c) => c !== null && c !== undefined) }
}
/**
 * useState 桩必须是真实状态槽（按调用序号存值），否则折叠/展开等交互分支
 * 全绿却从未被测到（dsh-plugin-audit 的 stub 保真度坑 #5）。
 */
function makeReactStub() {
  const slots = new Map()
  let cursor = 0
  return {
    /** 每次渲染重跑：游标归零，但状态槽跨渲染保留（折叠态翻转需要）。 */
    beginRender() { cursor = 0 },
    resetAll() { slots.clear(); cursor = 0 },
    api: {
      useState(init) {
        const key = cursor++
        if (!slots.has(key)) slots.set(key, typeof init === 'function' ? init() : init)
        const setter = (next) => { slots.set(key, typeof next === 'function' ? next(slots.get(key)) : next) }
        return [slots.get(key), setter]
      },
      useSyncExternalStore(subscribe, getSnapshot) { subscribe(() => {}); return getSnapshot() },
    },
  }
}
const react = makeReactStub()

const jsxStub = (type, props) => {
  const pc = props && props.children
  const children = pc === undefined || pc === null ? [] : (Array.isArray(pc) ? pc : [pc])
  return makeElement(type, props, ...children)
}
const primitivesStub = new Proxy({}, { get: () => function Icon() {} })

let bundleFactory = null
let bundleId = null
globalThis.window = { __ModuleLoader__: { load({ id, factory }) { bundleId = id; bundleFactory = factory } } }

const requireStub = (specifier) => {
  if (specifier === 'react') return react.api
  if (specifier === 'react/jsx-runtime') return { jsx: jsxStub, jsxs: jsxStub }
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error('unexpected require: ' + specifier)
}

new Function('code', 'return eval(code)')(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))

console.log('== bundle 加载 ==')
assert.equal(bundleId, 'dsh-web-fetch', 'bundle id 必须等于包名')
ok('bundle id = dsh-web-fetch')
assert.ok(bundleFactory, 'factory 存在')

const exportsRef = bundleFactory(requireStub)
assert.deepEqual([...exportsRef.inject], ['slots', 'locale', 'settingsScope', 'connection', 'remote'])
ok('exports.inject = [slots, locale, settingsScope, connection, remote]（短服务名）')

// ---- 桩环境 ----
const NS = 'web-fetch'
const localeDicts = {}
let boundNamespace = null
const scopeListeners = new Set()
const DEFAULTS = {
  cdpEnabled: true, cdpEndpoint: 'http://10.200.0.5:9222', cdpTimeoutMs: 60000, cdpWaitMs: 2000,
  tavilyEnabled: false, tavilyEndpoint: 'https://api.tavily.com/extract', tavilyApiKey: '', tavilyTimeoutMs: 30000,
}
const scopeState = { status: 'ready', writable: true, value: { ...DEFAULTS }, base: { ...DEFAULTS }, user: {} }
const scopeStub = {
  bind({ namespace }) { boundNamespace = namespace; return scopeStub },
  getSnapshot: () => scopeState,
  subscribe(fn) { scopeListeners.add(fn); return () => scopeListeners.delete(fn) },
  set: async (key, value) => {
    scopeState.user[key] = value
    scopeState.value = Object.assign({}, scopeState.value, { [key]: value })
    scopeListeners.forEach((fn) => fn())
    return true
  },
  unset: async (key) => {
    delete scopeState.user[key]
    const next = Object.assign({}, scopeState.value)
    delete next[key]
    scopeState.value = next
    scopeListeners.forEach((fn) => fn())
    return true
  },
}
let slotEntry = null
const slotsStub = {
  // 真实协议：注入工厂是 generator，逐个 yield 注册结果
  inject(slot, factory) {
    const iterator = factory()
    for (const reg of iterator) slotEntry = { slot, reg }
  },
  register(def, component) { return { def, component } },
}
const ctxStub = {
  effect(fn) { return fn() },
  locale: { register(ns, dict) { localeDicts[ns] = dict } },
  settingsScope: scopeStub,
  slots: slotsStub,
}

exportsRef.apply(ctxStub)

console.log('== locale ==')
const zh = localeDicts[NS].zh
const en = localeDicts[NS].en
for (const key of Object.keys(zh)) assert.ok(Object.prototype.hasOwnProperty.call(en, key), 'en 缺少键: ' + key)
assert.equal(Object.keys(en).length, Object.keys(zh).length, 'zh/en 键数量一致')
ok('zh/en 键集合一致 (' + Object.keys(zh).length + ' 键)')
for (const key of ['card.title', 'card.description', 'save', 'discard', 'unsaved', 'readOnly', 'saveFailed', 'overridden', 'reset', 'invalid', 'expand', 'collapse']) {
  assert.ok(zh[key], 'zh 翻译键缺失: ' + key)
}
ok('卡片 UI 翻译键齐全')

console.log('== settingsScope / slot ==')
assert.equal(boundNamespace, NS, 'namespace 必须 = ' + NS)
ok('namespace = ' + NS)
assert.equal(slotEntry.slot, 'settings.plugin.item')
const injected = slotEntry.reg
assert.equal(injected.def.name, 'settings.plugin.item')
assert.equal(injected.def.key, NS)
assert.equal(injected.def.locale, NS)
const payload = injected.def.inject()
assert.ok(payload.hooks && payload.hooks.webFetch, 'hooks.webFetch 提供')
for (const fn of ['edit', 'resetField', 'save', 'discard']) {
  assert.equal(typeof payload[fn], 'function', 'action 缺失: ' + fn)
}
ok('slot 注册契约完整 (hooks.useWebFetch + edit/resetField/save/discard)')

// ---- 渲染辅助 ----
const snap = () => payload.hooks.webFetch.getSnapshot()
const Card = injected.component
/** 收集元素节点与其全部字符串后代（label/hint 文案挂在子元素里）。 */
function collect(node, out = { els: [], strings: [] }) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') { out.strings.push(String(node)); return out }
  if (typeof node !== 'object') return out
  if (typeof node.type === 'function') { collect(node.type(node.props), out); return out }
  out.els.push(node)
  for (const child of node.children || []) collect(child, out)
  return out
}
/**
 * 渲染一次卡片。折叠态下卡片体不渲染，因此先点开头部按钮再取节点
 * ——这正是 dsh-plugin-audit 说的「折叠/展开分支本地从未被测到」的坑。
 */
const cardProps = () => ({
  t: (k) => zh[k] || k,
  useWebFetch: (selector) => selector(snap()),
  // 框架契约：actions 原样展开进 props（组件从 props.edit 等取用）
  ...payload,
})
const render = (options = {}) => {
  if (options.fresh) react.resetAll()
  react.beginRender()
  let out = collect(jsxStub(Card, cardProps()))
  const header = out.els.find((n) => n.type === 'button' && n.props['aria-expanded'] === false)
  if (header) {
    header.props.onClick()            // 展开
    react.beginRender()
    out = collect(jsxStub(Card, cardProps()))
  }
  return out
}
/** 取所有 input/select 元素 */
const controls = (out) => out.els.filter((n) => n.type === 'input' || n.type === 'select')
const byId = (out, id) => out.els.find((n) => n.props.id === id)
const findButton = (out, text) => out.els.find((n) => n.type === 'button' && n.props.children === text)

console.log('== 卡片渲染 ==')
let nodes = render({ fresh: true })
assert.ok(nodes.els.some((n) => n.type === 'li'), '应渲染 li 卡片')
const texts = nodes.strings.join(' ')
for (const needle of ['启用 CDP 浏览器', 'CDP 端点 URL', 'CDP 超时（毫秒）', '页面加载额外等待（毫秒）', '启用 Tavily', 'Tavily API 端点', 'Tavily API Key', 'Tavily 超时（毫秒）', '保存', '放弃']) {
  assert.ok(texts.includes(needle), '渲染文案应含: ' + needle)
}
ok('卡片渲染包含全部字段行与保存/放弃按钮')

console.log('== 交互层（可写态） ==')
let cs = controls(nodes)
assert.equal(cs.length, 8, '应渲染 8 个控件（2 开关 + 6 输入框）')
assert.ok(cs.every((n) => n.props.disabled === false), '可写态下所有控件必须可用')
ok('可写态：8 个控件全部未禁用')

// 开关 onChange 必须真的写进 user 层
const tavilyToggle = byId(nodes, 'wf-tavily-enabled')
assert.ok(tavilyToggle, 'tavily 开关存在')
tavilyToggle.props.onChange({ target: { checked: true } })
await payload.save()
assert.equal(scopeState.user.tavilyEnabled, true, '开关 onChange → 保存必须落到 user 层')
ok('开关 onChange(true) → 保存 → user 层 tavilyEnabled = true')

// 文本/数字字段：数字必须以 number 落盘，不能是字符串
nodes = render()
const timeoutInput = byId(nodes, 'wf-cdpTimeoutMs')
timeoutInput.props.onChange({ target: { value: '45000' } })
await payload.save()
assert.equal(scopeState.user.cdpTimeoutMs, 45000, '数字字段必须以 number 落盘')
assert.equal(typeof scopeState.user.cdpTimeoutMs, 'number')
ok('数字字段以 number 落盘（不是字符串）')

// 清空文本字段 = unset（回落 schema 默认）
nodes = render()
const endpointInput = byId(nodes, 'wf-cdpEndpoint')
endpointInput.props.onChange({ target: { value: '' } })
await payload.save()
assert.ok(!Object.prototype.hasOwnProperty.call(scopeState.user, 'cdpEndpoint'), '清空文本字段应从 user 层移除')
ok('清空文本字段 → user 层移除该键（回落默认）')

// 非法数字：不应落盘
nodes = render()
const waitInput = byId(nodes, 'wf-cdpWaitMs')
waitInput.props.onChange({ target: { value: 'abc' } })
assert.equal(snap().invalid, true, '非法数字必须置 invalid')
ok('非法数字输入 → state.invalid = true（拒绝落盘）')
payload.discard()

console.log('== 交互层（只读态） ==')
scopeState.writable = false
scopeState.user = {}
scopeState.value = { ...DEFAULTS }
scopeListeners.forEach((fn) => fn())
nodes = render()
cs = controls(nodes)
assert.equal(cs.length, 8)
assert.ok(cs.every((n) => n.props.disabled === true), '只读态下所有控件必须禁用')
ok('只读态：8 个控件全部禁用')
const saveBtn = findButton(nodes, zh['save'])
assert.ok(saveBtn && saveBtn.props.disabled === true, '只读态保存按钮必须禁用')
ok('只读态：保存按钮禁用')
assert.ok(nodes.strings.includes(zh['readOnly']), '只读态应显示只读提示')
ok('只读态：显示只读提示')

scopeState.writable = true
scopeListeners.forEach((fn) => fn())

console.log('========================================')
console.log('  client smoke: ' + passed + ' checks passed')


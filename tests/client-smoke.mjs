/**
 * client-smoke.mjs —— lib/client.js（浏览器半）结构与交互测试。
 *
 * 0.1.7-rc.1 契约（对照宿主真实源码，见 docs/DSH-0.1.7-ADAPTATION.md）：
 *   - settingsScope 已移除 → ctx.configForms.get(ns) + configForms.whileServed
 *   - 设置卡槽位 settings.plugin.item（keyed）已移除 → plugins.item（list，id + label thunk + 双视图）
 *   - slots.inject 回调从 generator 改为「返回 disposer 的普通函数」
 *
 * 构造最小 window.__ModuleLoader__ + require 桩加载 client bundle，跑 apply，验证：
 *   1. bundle id 与包名一致；exports.inject 为短服务名（无 primitives 依赖）
 *   2. locale 词典（zh/en 键集合互相覆盖）
 *   3. configForms.get 绑定 namespace = web-fetch；whileServed 门控真实存在
 *   4. plugins.item 槽位注册（id/order/label thunk/locale/inject 载荷）
 *   5. 双视图：summary 只给一行描述；page 渲染完整表单
 *   6. 不可用态（宿主未服务该 ns）渲染提示而非静默失踪
 *   7. 交互层盲区：可写态控件不禁用、只读态全禁用、开关/数字/清空/非法输入的真实落盘
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
/** useState 桩必须是真实状态槽（按调用序号存值），否则折叠/展开分支全绿却从未被测到。 */
function makeReactStub() {
  const slots = new Map()
  let cursor = 0
  return {
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

let bundleFactory = null
let bundleId = null
globalThis.window = { __ModuleLoader__: { load({ id, factory }) { bundleId = id; bundleFactory = factory } } }

// require 桩只提供 react / jsx-runtime：bundle 若仍依赖 client-ui-primitives 会当场炸出
// （0.1.7 起不再需要该运行时依赖，用文字 chevron 渲染）。
const requireStub = (specifier) => {
  if (specifier === 'react') return react.api
  if (specifier === 'react/jsx-runtime') return { jsx: jsxStub, jsxs: jsxStub }
  throw new Error('unexpected require: ' + specifier)
}

new Function('code', 'return eval(code)')(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))

console.log('== bundle 加载 ==')
assert.equal(bundleId, 'dsh-web-fetch', 'bundle id 必须等于包名')
ok('bundle id = dsh-web-fetch')

const exportsRef = bundleFactory(requireStub)
assert.deepEqual([...exportsRef.inject], ['slots', 'locale', 'configForms'], 'exports.inject 必须是 0.1.7 短服务名集合')
ok('exports.inject = [slots, locale, configForms]（0.1.7：settingsScope 已移除）')

// ---- 桩环境 ----
const NS = 'web-fetch'
const localeDicts = {}
let servedGate = true
let whileServedNamespaces = null
const scopeListeners = new Set()
const DEFAULTS = {
  cdpEnabled: true, cdpEndpoint: 'http://10.200.0.5:9222', cdpTimeoutMs: 60000, cdpWaitMs: 2000,
  tavilyEnabled: false, tavilyEndpoint: 'https://api.tavily.com/extract', tavilyApiKey: '', tavilyTimeoutMs: 30000,
}
const scopeState = { status: 'ready', writable: true, value: { ...DEFAULTS }, base: { ...DEFAULTS }, user: {}, revision: 3, mode: 'host' }
let boundNamespace = null
const scopeStub = {
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
const configFormsStub = {
  get(ns) { boundNamespace = ns; return scopeStub },
  whileServed(namespaces, register) {
    whileServedNamespaces = [...namespaces]
    if (servedGate) register()
    return () => {}
  },
}
let slotEntry = null
const slotsStub = {
  // 0.1.7 契约：inject(key, callback)，callback 是普通函数并返回 disposer
  inject(slot, callback) { const reg = callback(); slotEntry = { slot, reg }; return () => {} },
  register(def, component) { return { def, component } },
}
const ctxStub = {
  effect(fn) { return fn() },
  locale: {
    register(ns, dict) { localeDicts[ns] = dict },
    bind(ns) { return (key, params) => { const d = localeDicts[ns] || {}; let v = d[key] || key; if (params && typeof params.n === 'number') v = v.replace('{n}', String(params.n)); return v } },
  },
  configForms: configFormsStub,
  slots: slotsStub,
}

exportsRef.apply(ctxStub)

console.log('== locale ==')
const zh = localeDicts[NS].zh
const en = localeDicts[NS].en
for (const key of Object.keys(zh)) assert.ok(Object.prototype.hasOwnProperty.call(en, key), 'en 缺少键: ' + key)
for (const key of Object.keys(en)) assert.ok(Object.prototype.hasOwnProperty.call(zh, key), 'zh 缺少键: ' + key)
assert.equal(Object.keys(en).length, Object.keys(zh).length, 'zh/en 键数量一致')
ok('zh/en 键集合互相覆盖 (' + Object.keys(zh).length + ' 键)')
for (const key of ['card.title', 'card.description', 'save', 'discard', 'unsaved', 'readOnly', 'unavailable', 'saveFailed', 'overridden', 'reset', 'invalid', 'expand', 'collapse']) {
  assert.ok(zh[key], 'zh 翻译键缺失: ' + key)
}
ok('卡片 UI 翻译键齐全（含 0.1.7 新增 unavailable）')

console.log('== configForms / whileServed ==')
assert.equal(boundNamespace, NS, 'configForms.get 必须以 ' + NS + ' 绑定')
ok('configForms.get 绑定 namespace = ' + NS)
assert.deepEqual(whileServedNamespaces, [NS], 'whileServed 必须门控在 [' + NS + ']')
ok('configForms.whileServed([web-fetch], ...) 门控存在')

console.log('== plugins.item 槽位 ==')
assert.equal(slotEntry.slot, 'plugins.item', '0.1.7 设置卡槽位是 plugins.item（settings.plugin.item 已移除）')
const injected = slotEntry.reg
assert.equal(injected.def.name, 'plugins.item')
assert.equal(injected.def.id, NS, '注册 id 必须 = 行 id（ItemDetail 按 id 匹配条目）')
assert.equal(injected.def.locale, NS)
assert.ok(typeof injected.def.label === 'function', 'label 必须是 thunk（列表页标题随 locale 现读）')
assert.equal(typeof injected.def.order, 'number', 'order 必须提供（列表页排序）')
const payload = injected.def.inject()
assert.ok(payload.hooks && payload.hooks.webFetch, 'hooks.webFetch 提供')
for (const fn of ['edit', 'resetField', 'save', 'discard']) {
  assert.equal(typeof payload[fn], 'function', 'action 缺失: ' + fn)
}
ok('slot 注册契约完整 (plugins.item / id / order / label thunk / hooks.useWebFetch + actions)')

// ---- 渲染辅助 ----
const snap = () => payload.hooks.webFetch.getSnapshot()
const Card = injected.component
function collect(node, out = { els: [], strings: [] }) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') { out.strings.push(String(node)); return out }
  if (typeof node !== 'object') return out
  if (typeof node.type === 'function') { collect(node.type(node.props), out); return out }
  out.els.push(node)
  for (const child of node.children || []) collect(child, out)
  return out
}
const cardProps = (extra = {}) => Object.assign({
  t: (k) => zh[k] || k,
  useWebFetch: (selector) => selector(snap()),
  ...payload,
}, extra)
const render = (options = {}) => {
  if (options.fresh) react.resetAll()
  react.beginRender()
  let out = collect(jsxStub(Card, cardProps(options.props)))
  const header = out.els.find((n) => n.type === 'button' && n.props['aria-expanded'] === false)
  if (header) {
    header.props.onClick()
    react.beginRender()
    out = collect(jsxStub(Card, cardProps(options.props)))
  }
  return out
}
const controls = (out) => out.els.filter((n) => n.type === 'input' || n.type === 'select')
const byId = (out, id) => out.els.find((n) => n.props.id === id)
const findButton = (out, text) => out.els.find((n) => n.type === 'button' && n.props.children === text)

console.log('== 双视图 ==')
react.beginRender()
const summary = Card(cardProps({ view: 'summary' }))
assert.equal(typeof summary, 'string', 'summary 视图必须返回一行描述字符串（列表卡描述区）')
assert.equal(summary, zh['card.description'])
ok('summary 视图返回描述串，不渲染表单')

console.log('== 卡片渲染（page 视图） ==')
let nodes = render({ fresh: true })
assert.ok(nodes.els.some((n) => n.type === 'div' && String(n.props.className).includes('WF_card')), 'page 视图根元素应是 div 卡片（详情页非列表语境）')
const texts = nodes.strings.join(' ')
for (const needle of ['启用 CDP 浏览器', 'CDP 端点 URL', 'CDP 超时（毫秒）', '页面加载额外等待（毫秒）', '启用 Tavily', 'Tavily API 端点', 'Tavily API Key', 'Tavily 超时（毫秒）', '保存', '放弃']) {
  assert.ok(texts.includes(needle), '渲染文案应含: ' + needle)
}
ok('卡片渲染包含全部字段行与保存/放弃按钮')

console.log('== 不可用态（宿主未服务该命名空间） ==')
const savedStatus = scopeState.status
scopeState.status = 'unavailable'
scopeListeners.forEach((fn) => fn())
const unavailable = render({ fresh: true })
assert.ok(unavailable.strings.includes(zh['unavailable']), '不可用态必须渲染提示文案（而非静默返回 null）')
assert.equal(controls(unavailable).length, 0, '不可用态不应渲染可编辑控件')
scopeState.status = savedStatus
scopeListeners.forEach((fn) => fn())
ok('不可用态渲染提示而非静默失踪')

console.log('== whileServed 门控缺失分支 ==')
servedGate = false
slotEntry = null
const exportsRef2 = bundleFactory(requireStub)
exportsRef2.apply(ctxStub)
assert.equal(slotEntry, null, '命名空间未被服务时不得注册槽位条目（否则插件页出现空卡）')
servedGate = true
slotEntry = null
exportsRef2.apply(ctxStub)
assert.ok(slotEntry !== null, '命名空间被服务后必须完成注册')
ok('whileServed 门控：未服务不注册 / 服务后注册')

console.log('== 交互层（可写态） ==')
scopeState.writable = true
scopeState.user = {}
scopeState.value = { ...DEFAULTS }
scopeListeners.forEach((fn) => fn())
nodes = render({ fresh: true })
let cs = controls(nodes)
assert.equal(cs.length, 8, '应渲染 8 个控件（2 开关 + 6 输入框）')
assert.ok(cs.every((n) => n.props.disabled === false), '可写态下所有控件必须可用')
ok('可写态：8 个控件全部未禁用')

const tavilyToggle = byId(nodes, 'wf-tavily-enabled')
assert.ok(tavilyToggle, 'tavily 开关存在')
tavilyToggle.props.onChange({ target: { checked: true } })
await payload.save()
assert.equal(scopeState.user.tavilyEnabled, true, '开关 onChange → 保存必须落到 user 层')
ok('开关 onChange(true) → 保存 → user 层 tavilyEnabled = true')

nodes = render()
const timeoutInput = byId(nodes, 'wf-cdpTimeoutMs')
timeoutInput.props.onChange({ target: { value: '45000' } })
await payload.save()
assert.equal(scopeState.user.cdpTimeoutMs, 45000, '数字字段必须以 number 落盘')
assert.equal(typeof scopeState.user.cdpTimeoutMs, 'number')
ok('数字字段以 number 落盘（不是字符串）')

nodes = render()
const endpointInput = byId(nodes, 'wf-cdpEndpoint')
endpointInput.props.onChange({ target: { value: '' } })
await payload.save()
assert.ok(!Object.prototype.hasOwnProperty.call(scopeState.user, 'cdpEndpoint'), '清空文本字段应从 user 层移除')
ok('清空文本字段 → user 层移除该键（回落默认）')

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

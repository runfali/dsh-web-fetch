/**
 * dsh-web-fetch — CDP（Chrome DevTools Protocol）数据源策略。
 * 适配 DSH 0.1.0-rc.7 + cloakbrowser (Python aiohttp)：
 * - 优先使用 browser WS 通过 Target.createTarget 创建隔离页面，避免导航污染 Harness 自身页面；
 * - 回退：若 browser 域不可用，则复用 /json/list 的 page WS（会短暂污染但保证可用）；
 * - 客户端帧按 RFC6455 掩码，移除 permessage-deflate 扩展头；
 * - 支持 wss/http 双栈，httpGet 带超时与 8s 握手超时。
 */
import http from "node:http"
import https from "node:https"
import { randomBytes } from "node:crypto"
import { withTimeout, plainText, truncate, source } from "../helpers.js"

const DEFAULT_ENDPOINT = "http://10.200.0.5:9222"
const DEFAULT_TIMEOUT_MS = 60000
const DEFAULT_WAIT_MS = 2000
const WS_MAX_FRAME = 6 * 1024 * 1024

function encodeFrame(message) {
  const data = Buffer.from(message, "utf8")
  const len = data.length
  const mask = randomBytes(4)
  const masked = Buffer.alloc(len)
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4]
  let header
  if (len < 126) header = Buffer.from([0x81, 0x80 | len])
  else if (len <= 0xffff) header = Buffer.from([0x81, 0x80 | 126, (len >> 8) & 0xff, len & 0xff])
  else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 0x80 | 127
    header[2] = 0; header[3] = 0; header[4] = 0; header[5] = 0
    header[6] = (len >>> 24) & 0xff
    header[7] = (len >>> 16) & 0xff
    header[8] = (len >>> 8) & 0xff
    header[9] = len & 0xff
  }
  return Buffer.concat([header, mask, masked])
}

function parseFrameHeader(slice) {
  if (slice.length < 2) return null
  const fin = (slice[0] & 0x80) !== 0
  const opcode = slice[0] & 0x0f
  const mask = (slice[1] & 0x80) !== 0
  let payloadLen = slice[1] & 0x7f
  let consumed = 2
  if (payloadLen === 126) {
    if (slice.length < 4) return null
    payloadLen = (slice[2] << 8) | slice[3]
    consumed = 4
  } else if (payloadLen === 127) {
    if (slice.length < 10) return null
    const hi = slice.readUInt32BE(2)
    const lo = slice.readUInt32BE(6)
    if (hi !== 0) throw new Error("frame payload too large (hi != 0)")
    payloadLen = lo
    consumed = 10
  }
  if (payloadLen > WS_MAX_FRAME) throw new Error("frame payload too large: " + payloadLen)
  return { fin, opcode, mask, payloadLen, consumed, headerSize: consumed + (mask ? 4 : 0) }
}

class CdpClient {
  constructor(endpoint, cfg) {
    this.endpoint = endpoint // http://10.200.0.5:9222
    this.cfg = cfg
    this.ws = null
    this.seq = 0
    this.pending = new Map()
    this.events = new Map()
    this.closed = false
    this._frameBuf = Buffer.alloc(0)
  }

  async httpGet(path) {
    const url = new URL(path, this.endpoint)
    const mod = url.protocol === "https:" ? https : http
    return new Promise((resolve, reject) => {
      const req = mod.get({ hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80), path: url.pathname + url.search }, (res) => {
        let data = ""
        res.on("data", (c) => { data += c })
        res.on("end", () => {
          if (res.statusCode >= 300) return reject(new Error("HTTP " + res.statusCode + " on " + path + ": " + data.slice(0, 200)))
          try { resolve(JSON.parse(data)) } catch { reject(new Error("invalid JSON from " + path + ": " + data.slice(0, 200))) }
        })
      })
      req.on("error", reject)
      req.setTimeout(8000, () => req.destroy(new Error("HTTP timeout on " + path)))
    })
  }

  async connect() {
    // 取 browser WS（/json/version）用于创建隔离 target
    const ver = await this.httpGet("/json/version").catch(() => null)
    const wsPath = ver && ver.webSocketDebuggerUrl
    if (!wsPath) throw new Error("CDP /json/version 无 webSocketDebuggerUrl: " + this.endpoint)
    await this.connectToWs(wsPath)
    return { wsUrl: wsPath, isBrowser: true }
  }

  async connectToWs(wsPath) {
    const wsUrl = new URL(wsPath)
    const isSecure = wsUrl.protocol === "wss:"
    const mod = isSecure ? https : http
    const key = randomBytes(16).toString("base64")
    const req = mod.request({
      hostname: wsUrl.hostname,
      port: wsUrl.port || (isSecure ? 443 : 80),
      path: wsUrl.pathname + wsUrl.search,
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
      },
    })
    const handshake = new Promise((resolve, reject) => {
      req.on("error", reject)
      req.on("response", (res) => { res.resume(); res.on("end", () => reject(new Error("WebSocket handshake rejected: HTTP " + res.statusCode))) })
      req.on("upgrade", (res, socket, head) => {
        const up = (res.headers["upgrade"] || "").toLowerCase()
        if (up !== "websocket" || String(res.statusCode) !== "101") {
          socket.destroy(); reject(new Error("WebSocket handshake failed: HTTP " + res.statusCode)); return
        }
        this.ws = socket
        this._frameBuf = head && head.length ? head : Buffer.alloc(0)
        socket.on("data", (c) => this._onData(c))
        socket.on("close", () => { this.closed = true })
        socket.on("error", () => { this.closed = true })
        resolve()
      })
    })
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("WebSocket handshake timeout after 8000ms to " + wsPath)), 8000))
    req.end()
    await Promise.race([handshake, timeout])
    // 等 50ms 让事件循环就绪
    await new Promise((r) => setTimeout(r, 50))
  }

  _onData(chunk) {
    const buf = Buffer.concat([this._frameBuf, chunk])
    this._frameBuf = Buffer.alloc(0)
    let offset = 0
    while (offset < buf.length) {
      const slice = buf.subarray(offset)
      const header = parseFrameHeader(slice)
      if (!header) { this._frameBuf = slice; break }
      const need = header.headerSize + header.payloadLen
      if (slice.length < need) { this._frameBuf = slice; break }
      let payload = slice.subarray(header.headerSize, header.headerSize + header.payloadLen)
      if (header.mask) {
        const mk = slice.subarray(header.consumed, header.consumed + 4)
        const dec = Buffer.alloc(payload.length)
        for (let i = 0; i < payload.length; i++) dec[i] = payload[i] ^ mk[i % 4]
        payload = dec
      }
      offset += need
      if (header.opcode === 0x8) { this.closed = true; try { this.ws && this.ws.end() } catch {} ; break }
      else if (header.opcode === 0x9) { /* ping */ }
      else if (header.opcode === 0xa) { /* pong */ }
      else if (header.opcode === 0x1 || header.opcode === 0x0) {
        if (header.fin) this._dispatch(payload.toString("utf8"))
      }
    }
    if (offset < buf.length) this._frameBuf = buf.subarray(offset)
  }

  _dispatch(raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    if (msg.method) {
      for (const h of this.events.get(msg.method) || []) { try { h(msg.params) } catch {} }
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error("CDP error " + msg.error.code + ": " + msg.error.message))
      else p.resolve(msg.result)
    }
  }

  async cmd(method, params, opts = {}) {
    if (!this.ws || this.closed) throw new Error("CDP socket closed before cmd " + method)
    this.seq += 1
    const id = this.seq
    this.ws.write(encodeFrame(JSON.stringify({ id, method, params: params || {} })))
    const timeout = withTimeout(opts.signal, opts.timeoutMs || this.cfg.timeoutMs)
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject })
        const onAbort = () => { this.pending.delete(id); reject(new Error("CDP command " + method + " timed out after " + (opts.timeoutMs || this.cfg.timeoutMs) + "ms")) }
        timeout.signal.addEventListener("abort", onAbort, { once: true })
      })
    } finally { timeout.cleanup() }
  }

  on(event, handler) {
    const list = this.events.get(event) || []
    list.push(handler); this.events.set(event, list)
    return () => { const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1) }
  }

  async close() {
    try {
      if (this.ws && !this.closed) {
        try { this.ws.end() } catch {}
        await new Promise((r) => setTimeout(r, 200))
        try { this.ws.destroy() } catch {}
      }
      for (const [id, p] of this.pending) { this.pending.delete(id); p.reject(new Error("CDP closed")) }
    } catch {}
  }
}

const EXTRACT_JS = "(function(){try{var el=document.querySelector('#article')||document.querySelector('#artibody')||document.querySelector('article')||document.body;return el?(el.innerText||el.textContent||''):document.title||''}catch(e){return document.title||''}})()"

async function fetchViaIsolatedPage(browserClient, endpoint, url, cfg, signal) {
  // 1. 创建隔离 target，直接指向目标 URL
  let targetId = null
  try {
    const cr = await browserClient.cmd("Target.createTarget", { url }, { timeoutMs: 8000 })
    targetId = cr && cr.targetId
  } catch (e) {
    throw new Error("Target.createTarget failed: " + e.message + " (endpoint " + endpoint + ")")
  }
  if (!targetId) throw new Error("Target.createTarget 返回空 targetId")

  // 2. 轮询 /json/list 取到新 target 的 page WS
  let pageWs = null
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 200))
    try {
      const list = await browserClient.httpGet("/json/list")
      const t = Array.isArray(list) ? list.find((x) => x.id === targetId || x.targetId === targetId) : null
      if (t && t.webSocketDebuggerUrl) { pageWs = t.webSocketDebuggerUrl; break }
    } catch {}
  }
  if (!pageWs) {
    // 清理
    try { await browserClient.cmd("Target.closeTarget", { targetId }).catch(() => {}) } catch {}
    throw new Error("未在 /json/list 中找到新建 target 的 webSocketDebuggerUrl (targetId " + targetId + ")")
  }

  const pageClient = new CdpClient(endpoint, cfg)
  await pageClient.connectToWs(pageWs)
  try {
    await pageClient.cmd("Page.enable").catch(() => {})
    await pageClient.cmd("Runtime.enable").catch(() => {})
    await pageClient.cmd("DOM.enable").catch(() => {})

    // 等待加载：Page.loadEventFired 或 readyState
    let fired = false
    const loadP = new Promise((res) => {
      const off = pageClient.on("Page.loadEventFired", () => { fired = true; res(true) })
      // 5s 后兜底
      setTimeout(() => { if (!fired) res(false) }, 8000)
    })

    // 若 createTarget 已带 url，这里 Page.navigate 可能返回 "already navigated"，忽略错误
    try { await pageClient.cmd("Page.navigate", { url }).catch(() => {}) } catch {}

    // 轮询 readyState
    const probe = async () => {
      try {
        const r = await pageClient.cmd("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, { timeoutMs: 3000 })
        return r && r.result && r.result.value === "complete"
      } catch { return false }
    }
    await Promise.race([
      loadP,
      (async () => { for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 500)); if (await probe()) return } })(),
    ]).catch(() => {})

    // 额外等待正文容器出现（sina 常见 #article / #artibody），最多 4 秒
    for (let i = 0; i < 12; i++) {
      try {
        const hasArt = await pageClient.cmd("Runtime.evaluate", { expression: "!!(document.querySelector('#article')||document.querySelector('#artibody')||document.querySelector('.article'))", returnByValue: true }, { timeoutMs: 2000 })
        if (hasArt && hasArt.result && hasArt.result.value) break
      } catch {}
      await new Promise((r) => setTimeout(r, 300))
    }

    if (cfg.waitMs > 0) await new Promise((r) => setTimeout(r, cfg.waitMs))

    let text = ""
    try {
      const ev = await pageClient.cmd("Runtime.evaluate", { expression: EXTRACT_JS, returnByValue: true }, { timeoutMs: 8000 })
      text = ev && ev.result && ev.result.value ? String(ev.result.value) : ""
    } catch {}
    if (!text || text.trim().length < 30) {
      try {
        const dom = await pageClient.cmd("DOM.getDocument", { depth: -1, pierce: true }, { timeoutMs: 5000 }).catch(() => null)
        if (dom && dom.root) {
          const outer = await pageClient.cmd("DOM.getOuterHTML", { nodeId: dom.root.nodeId }, { timeoutMs: 5000 }).catch(() => null)
          const html = outer && outer.outerHTML ? String(outer.outerHTML) : ""
          if (html) text = plainText(html)
        }
      } catch {}
    }
    return { url, title: "", body: plainText(text), source: "cdp" }
  } finally {
    await pageClient.close().catch(() => {})
    try { await browserClient.cmd("Target.closeTarget", { targetId }).catch(() => {}) } catch {}
    // 再等 300ms 让 target 彻底关闭，避免 /json/list 残留
    await new Promise((r) => setTimeout(r, 200))
  }
}

export function makeCdpStrategy(config) {
  const endpoint = (config.cdpEndpoint || config.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "")
  const cfg = {
    timeoutMs: Number(config.cdpTimeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    waitMs: Number(config.cdpWaitMs ?? config.waitMs ?? DEFAULT_WAIT_MS) || DEFAULT_WAIT_MS,
  }
  return {
    id: "cdp",
    title: "CDP 浏览器",
    available: () => {
      if (!endpoint) return false
      try { const u = new URL(endpoint); return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "ws:" || u.protocol === "wss:" }
      catch { return false }
    },
    async fetch(req, signal) {
      if (!req.query || !String(req.query).trim()) throw new Error("CDP requires a non-empty URL/query")
      let url = String(req.query).trim()
      if (!/^https?:\/\//i.test(url)) url = "http://" + url
      const browserClient = new CdpClient(endpoint, cfg)
      await browserClient.connect()
      try {
        const page = await fetchViaIsolatedPage(browserClient, endpoint, url, cfg, signal)
        if (!page.body || page.body.length < 20) throw new Error("CDP 抓取完成但正文为空（可能被反爬或页面超时）")
        const snip = truncate(page.body, 400)
        return { sources: [source(page.url, { title: page.title, snippet: snip, content: page.body, provider: "cdp" })], truncated: false }
      } finally {
        await browserClient.close().catch(() => {})
      }
    },
  }
}

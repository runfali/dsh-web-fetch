/**
 * dsh-web-fetch — CDP（Chrome DevTools Protocol）数据源策略。
 */
import http from "node:http"
import { randomBytes } from "node:crypto"
import { withTimeout, plainText, truncate, source } from "../helpers.js"

const DEFAULT_ENDPOINT = "http://10.200.0.5:9222"
const DEFAULT_TIMEOUT_MS = 60000
const DEFAULT_WAIT_MS = 2000
const WS_MAX_FRAME = 6 * 1024 * 1024

function encodeFrame(message) {
  const data = Buffer.from(message, "utf8")
  const len = data.length
  let header
  if (len < 126) header = Buffer.from([0x81, len])
  else if (len <= 0xFFFF) header = Buffer.from([0x81, 126, (len >> 8) & 0xFF, len & 0xFF])
  else header = Buffer.from([0x81, 127, 0, 0, 0, 0, 0, 0, 0, len & 0xFF, (len >>> 8) & 0xFF, (len >>> 16) & 0xFF, (len >>> 24) & 0xFF, (len >>> 32) & 0xFF, (len >>> 40) & 0xFF, (len >>> 48) & 0xFF, (len >>> 56) & 0xFF])
  return Buffer.concat([header, data])
}

function parseFrameHeader(slice) {
  if (slice.length < 2) return null
  const fin = (slice[0] & 0x80) !== 0
  const opcode = slice[0] & 0x0F
  const mask = (slice[1] & 0x80) !== 0
  let payloadLen = slice[1] & 0x7F
  let consumed = 2
  if (payloadLen === 126) {
    if (slice.length < 4) return null
    payloadLen = (slice[2] << 8) | slice[3]
    consumed = 4
  } else if (payloadLen === 127) {
    if (slice.length < 10) return null
    payloadLen = Number(Buffer.from(slice.subarray(2, 10)).readBigUInt64BE(0) & 0x7FFFFFFFFFFFFFFFn)
    consumed = 10
  }
  if (payloadLen > WS_MAX_FRAME) throw new Error("frame payload too large: " + payloadLen)
  return { fin, opcode, mask, payloadLen, consumed, headerSize: consumed + (mask ? 4 : 0) }
}

class CdpClient {
  constructor(endpoint, cfg) {
    this.endpoint = endpoint
    this.cfg = cfg
    this.ws = null
    this.seq = 0
    this.pending = new Map()
    this.events = new Map()
    this.closed = false
    this._frameBuf = Buffer.alloc(0)
  }

  async connect() {
    const url = new URL(this.endpoint)
    const key = randomBytes(16).toString("base64")
    const wsPath = (await this.httpGet("/json/version")).webSocketDebuggerUrl ||
      (await this.httpGet("/json/new")).webSocketDebuggerUrl
    if (!wsPath) throw new Error("CDP /json/version & /json/new returned no webSocketDebuggerUrl")
    const wsUrl = new URL(wsPath)
    const req = http.request({
      hostname: wsUrl.hostname,
      port: wsUrl.port || 80,
      path: wsUrl.pathname + wsUrl.search,
      method: "GET",
      headers: {
        "Connection": "Upgrade",
        "Upgrade": "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Extensions": "permessage-deflate; client_no_context_takeover"
      }
    })
    await new Promise((resolve, reject) => {
      req.on("error", reject)
      req.on("response", (res) => { res.resume(); res.on("end", () => reject(new Error("WebSocket handshake rejected: HTTP " + res.statusCode))) })
      req.on("upgrade", (res, socket, head) => {
        const upgrade = (res.headers["upgrade"] || "").toLowerCase()
        if (upgrade !== "websocket" || String(res.statusCode) !== "101") {
          socket.destroy(); reject(new Error("WebSocket handshake failed: HTTP " + res.statusCode))
        }
        this.ws = socket
        this._frameBuf = head && head.length ? head : Buffer.alloc(0)
        socket.on("data", (chunk) => this._onData(chunk))
        socket.on("close", () => { this.closed = true })
        socket.on("error", () => { this.closed = true })
        resolve()
      })
    })
    req.end()
    return { wsUrl: wsUrl.toString() }
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
      const payload = slice.subarray(header.headerSize, header.headerSize + header.payloadLen)
      offset += need
      if (header.fin && header.opcode === 0x89) { this.ws && this.ws.write(encodeFrame(payload)) }
      else if (header.fin && header.opcode === 0x81) { this._dispatch(payload.toString("utf8")) }
      else if (header.fin && header.opcode === 0x8A) {}
    }
    if (offset < buf.length) this._frameBuf = buf.subarray(offset)
  }

  _dispatch(raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    if (msg.method) {
      for (const handler of this.events.get(msg.method) || []) { try { handler(msg.params) } catch {} }
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error("CDP error " + msg.error.code + ": " + msg.error.message))
      else p.resolve(msg.result)
    }
  }

  async cmd(method, params, opts = {}) {
    this.seq += 1
    const id = this.seq
    this.ws.write(encodeFrame(JSON.stringify({ id, method, params: params || {} })))
    const timeout = withTimeout(opts.signal, opts.timeoutMs || this.cfg.timeoutMs)
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject })
        timeout.signal.addEventListener("abort", () => {
          this.pending.delete(id)
          reject(new Error("CDP command " + method + " timed out"))
        }, { once: true })
      })
    } finally { timeout.cleanup() }
  }

  on(event, handler) {
    const list = this.events.get(event) || []
    list.push(handler)
    this.events.set(event, list)
    return () => {
      const idx = list.indexOf(handler)
      if (idx >= 0) list.splice(idx, 1)
    }
  }

  async httpGet(path) {
    const url = new URL(path, this.endpoint)
    return new Promise((resolve, reject) => {
      http.get({ hostname: url.hostname, port: url.port, path: url.pathname + url.search }, (res) => {
        let data = ""
        res.on("data", (c) => { data += c })
        res.on("end", () => {
          if (res.statusCode >= 300) return reject(new Error("HTTP " + res.statusCode + " on " + path))
          try { resolve(JSON.parse(data)) }
          catch { reject(new Error("invalid JSON from " + path)) }
        })
      }).on("error", reject).end()
    })
  }

  async close() {
    try {
      if (this.ws && !this.closed) this.ws.end()
      for (const [id, p] of this.pending) { this.pending.delete(id); p.reject(new Error("closed")) }
    } catch {}
  }
}

const EXTRACT_JS = (() => {
  const empty = String.fromCharCode(39) + String.fromCharCode(39)
  return "(function(){try{var b=document.body;return(b&&b.innerText)||b?(b&&b.textContent)||" + empty + ":document.title||" + empty + "}catch(e){return document.title||" + empty + "}})()"
})()

async function fetchPage(url, cdp, cfg, signal) {
  const timeout = withTimeout(signal, cfg.timeoutMs)
  const { tabId } = await cdp.httpGet("/json/new")
  try {
    await cdp.cmd("Page.enable")
    let loadResolve
    const loadPromise = new Promise((resolve) => { loadResolve = resolve })
    const offLoad = cdp.on("Page.loadEventFired", () => loadResolve && loadResolve(true))
    await cdp.cmd("Page.navigate", { url })
    const readyStateProbe = async () => {
      try {
        const r = await cdp.cmd("Runtime.evaluate", { expression: "document.readyState" }, { timeoutMs: 3000 })
        return r && r.result && r.result.value === "complete"
      } catch { return false }
    }
    await Promise.race([
      loadPromise.then(() => { offLoad && offLoad() }),
      (async () => { for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 500)); if (await readyStateProbe()) return } })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("load wait timeout")), cfg.waitMs * 3))
    ]).catch(() => {})
    if (cfg.waitMs > 0) await new Promise((r) => setTimeout(r, cfg.waitMs))
    const r = await cdp.cmd("Runtime.evaluate", { expression: EXTRACT_JS }, { timeoutMs: 5000 })
    let text = ""
    try { text = r && r.result && r.result.value ? String(r.result.value) : "" } catch {}
    return { url, title: "", body: plainText(text), source: "cdp" }
  } finally {
    timeout.cleanup()
    try { cdp.httpGet("/json/close/" + tabId).catch(() => {}) } catch {}
  }
}

export function makeCdpStrategy(config) {
  const endpoint = (config.cdpEndpoint || config.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "")
  const cfg = {
    timeoutMs: Number(config.cdpTimeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    waitMs: Number(config.cdpWaitMs ?? config.waitMs ?? DEFAULT_WAIT_MS) || DEFAULT_WAIT_MS,
  }
  let client = null
  return {
    id: "cdp",
    title: "CDP 浏览器",
    available: () => {
      if (!endpoint) return false
      try { const u = new URL(endpoint); return u.protocol === "http:" || u.protocol === "ws:" || u.protocol === "wss:" }
      catch { return false }
    },
    async fetch(req, signal) {
      if (!req.query || !String(req.query).trim()) throw new Error("CDP requires a non-empty URL/query")
      let url = String(req.query).trim()
      if (!/^https?:\/\//i.test(url)) url = "http://" + url
      client = new CdpClient(endpoint, cfg)
      try {
        await client.connect()
        const page = await fetchPage(url, client, cfg, signal)
        const snip = page.body ? truncate(page.body, 400) : ""
        return {
          sources: [source(page.url, { title: page.title, snippet: snip, content: page.body, provider: "cdp" })],
          truncated: false
        }
      } finally { await client.close().catch(() => {}) }
    },
  }
}

/**
 * dsh-web-fetch — Tavily 数据源策略。
*
 * 使用 Tavily Extract API 拉取 URL 的内容（Tavily 会做抓取、清洗、
 * JavaScript 处理），结果映射为 ctx.web 的 WebSource 结构。
*
 * 端点：https://api.tavily.com/extract
 * 请求体：{ urls: string[] | query: string, maxResults, includeRawContent }
 * @module strategies/tavily
 */
import { withTimeout, plainText, truncate, source } from "../helpers.js"

const DEFAULT_ENDPOINT = "https://api.tavily.com/extract"
const DEFAULT_TIMEOUT_MS = 30000

function sendJson(url, body, signal, timeoutMs) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body, signal
  })
}

export function makeTavilyStrategy(config) {
  const endpoint = (config.tavilyEndpoint || config.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "")
  const cfg = {
    apiKey: config.tavilyApiKey ?? config.apiKey ?? "",
    timeoutMs: Number(config.tavilyTimeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  }
  return {
    id: "tavily",
    title: "Tavily",
    available: () => {
      if (!endpoint) return false
      if (!cfg.apiKey) return false
      try { const u = new URL(endpoint); return u.protocol === "https:" || u.protocol === "http:" }
      catch { return false }
    },
    async fetch(req, signal) {
      if (!req.query || !String(req.query).trim()) throw new Error("Tavily requires a non-empty URL/query")
      const query = String(req.query).trim()
      const isUrl = /^https?:\/\//i.test(query)
      const maxResults = Number(req.maxResults) > 0 ? Math.trunc(Number(req.maxResults)) : 5
      const body = isUrl
        ? { urls: [query], maxResults, includeRawContent: true, api_key: cfg.apiKey }
        : { query, maxResults, includeRawContent: true, api_key: cfg.apiKey }
      const timeout = withTimeout(signal, cfg.timeoutMs)
      let res
      try {
        res = await sendJson(endpoint, JSON.stringify(body), timeout.signal, cfg.timeoutMs)
      } catch (err) {
        timeout.cleanup()
        throw new Error("Tavily request failed: " + String(err))
      }
      timeout.cleanup()
      if (!res.ok) {
        let detail = ""
        try { const j = await res.json(); detail = j.error || j.message || "" } catch {}
        throw new Error("Tavily API returned HTTP " + res.status + (detail ? ": " + detail : ""))
      }
      let data
      try { data = await res.json() } catch (err) {
        throw new Error("Tavily returned unparseable JSON (HTTP " + res.status + ")")
      }
      const results = (data && (data.results || data.data)) || []
      const out = []
      for (const item of results) {
        // 上游载荷可能夹带 null / 非对象元素（网关改写、部分失败的结果数组）；
        // 直接取属性会抛 TypeError 让整次抓取失败，故先做非对象守卫再判定可用性。
        if (item === null || typeof item !== "object") continue
        const url = item.url || item.link || ""
        if (!url) continue
        try { const u = new URL(url); if (u.protocol !== "http:" && u.protocol !== "https:") continue } catch { continue }
        const title = item.title || item.name || ""
        // 兼容 Tavily 新旧字段：raw_content (下划线)、rawContent、rawData、content
        // rawData 分支用 null 保持 ?? 链穿透（"" 非 nullish 会截断后续 content/text 回退）
        const raw = item.raw_content ?? item.rawContent ?? item.raw_text ?? (item.rawData ? item.rawData.join("\n\n") : null) ?? item.content ?? item.text ?? item.snippet ?? ""
        const body = plainText(String(raw || ""))
        out.push(source(url, {
          title: plainText(title),
          snippet: body ? truncate(body, 400) : "",
          content: body,
          provider: "tavily"
        }))
      }
      if (out.length === 0) throw new Error("Tavily returned no results")
      return { sources: out, truncated: false }
    },
  }
}

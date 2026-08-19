/**
 * dsh-web-fetch — Tavily 策略单元测试。
*
 * 纯本地运行：通过拦截 globalThis.fetch 模拟 Tavily API 响应，
 * 不发起真实网络请求。
 * 运行：node tests/test-tavily-unit.mjs
 */
import assert from "node:assert/strict"
import { makeTavilyStrategy } from "../src/strategies/tavily.js"

const RAW = "  <p> Hello <b>world</b>,  this is  test content.</p>  **bold**  ";

function stubFetch(body) {
  const real = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => body
  })
  return () => { globalThis.fetch = real }
}

async function run() {
  console.log("[Tavily strategy]")

  {
    const s = makeTavilyStrategy({ apiKey: "k123" })
    assert.equal(s.id, "tavily")
    assert.equal(s.available(), true)
    console.log("  ✓ available 返回 true 当 apiKey 存在")
  }

  {
    const s = makeTavilyStrategy({ apiKey: "" })
    assert.equal(s.available(), false)
    console.log("  ✓ available 返回 false 当 apiKey 为空")
  }

  {
    const s = makeTavilyStrategy({ apiKey: "k123", endpoint: "http://x" })
    assert.equal(s.available(), true)
    console.log("  ✓ http 端点也视为可用")
  }

  {
    const s = makeTavilyStrategy({ apiKey: "k123" })
    const clean = stubFetch({ results: [] })
    let threw = false
    try { await s.fetch({ query: "x" }) } catch { threw = true }
    clean()
    assert.equal(threw, true)
    console.log("  ✓ 空 results 时报错")
  }

  {
    const s = makeTavilyStrategy({ apiKey: "k123" })
    const clean = stubFetch({ results: [ { url: "https://a.com", title: " A ", rawData: [RAW], content: "" } ] })
    const r = await s.fetch({ query: "https://a.com" })
    clean()
    assert.equal(r.sources.length, 1)
    assert.equal(r.sources[0].url, "https://a.com")
    assert.equal(r.sources[0].title, "A")
    assert.equal(r.sources[0].provider, "tavily")
    assert.ok(r.sources[0].content.length > 0)
    assert.ok(r.sources[0].content.includes("Hello world"))
    assert.ok(r.sources[0].snippet.length > 0 && r.sources[0].snippet.length <= 401)
    assert.equal(r.truncated, false)
    console.log("  ✓ URL 查询 + raw 字段解析 + 纯文本清洗")
  }

  {
    const s = makeTavilyStrategy({ apiKey: "k123" })
    const clean = stubFetch({ results: [ { url: "https://b.com", title: "B", content: "content only" } ] })
    const r = await s.fetch({ query: "some topic" })
    clean()
    assert.equal(r.sources[0].url, "https://b.com")
    assert.equal(r.sources[0].title, "B")
    assert.ok(r.sources[0].content.includes("content only"))
    console.log("  ✓ 自然语言 query + content 字段回退")
  }

  {
    const s = makeTavilyStrategy({ apiKey: "k123" })
    const clean = stubFetch({ results: [ { url: "not-a-url", title: "bad" } ] })
    let threw = false
    try { await s.fetch({ query: "x" }) } catch { threw = true }
    clean()
    assert.equal(threw, true)
    console.log("  ✓ 缺少合法 url 的条目被跳过，最终报错")
  }

  {
    const real = globalThis.fetch
    globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ message: "forbidden" }) })
    const s = makeTavilyStrategy({ apiKey: "bad" })
    let msg
    try { await s.fetch({ query: "x" }) } catch (e) { msg = String(e.message) }
    globalThis.fetch = real
    assert.ok(msg.includes("HTTP 403"))
    assert.ok(msg.includes("forbidden"))
    console.log("  ✓ HTTP 403 时抛出包含状态的错误")
  }

  {
    const s = makeTavilyStrategy({ apiKey: "k123" })
    try { await s.fetch({ query: "" }); assert.fail("should throw") } catch {}
    console.log("  ✓ 空 query 时报错")
  }

  console.log("========================================")
  console.log("  all 7 tavily tests passed")
}
run().catch(e => { console.error(e); process.exit(1) })

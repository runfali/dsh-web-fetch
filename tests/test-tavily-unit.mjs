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
  globalThis.fetch = async (url, opts) => {
    lastBody = opts && opts.body ? JSON.parse(opts.body) : null
    return {
      ok: true,
      status: 200,
      json: async () => body
    }
  }
  return () => { globalThis.fetch = real }
}

/** 最近一次请求体（maxResults 透传断言用） */
let lastBody = null

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
    try { await s.fetch({ url: "x" }) } catch { threw = true }
    clean()
    assert.equal(threw, true)
    console.log("  ✓ 空 results 时报错")
  }

  {
    const s = makeTavilyStrategy({ apiKey: "k123" })
    const clean = stubFetch({ results: [ { url: "https://a.com", title: " A ", rawData: [RAW], content: "" } ] })
    const r = await s.fetch({ url: "https://a.com" })
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
    const clean = stubFetch({ results: [ { url: "https://a.com", title: "A", content: "c" } ] })
    lastBody = null
    await s.fetch({ url: "https://a.com", maxResults: 12 })
    clean()
    assert.equal(lastBody.maxResults, 12, "maxResults 应透传请求体")
    console.log("  ✓ maxResults 透传")
    const clean2 = stubFetch({ results: [ { url: "https://a.com", title: "A", content: "c" } ] })
    lastBody = null
    await s.fetch({ url: "https://a.com" })
    clean2()
    assert.equal(lastBody.maxResults, 5, "缺省 maxResults 回退 5")
    console.log("  ✓ maxResults 缺省 5")
  }

  {
    const s = makeTavilyStrategy({ apiKey: "k123" })
    const clean = stubFetch({ results: [ { url: "https://b.com", title: "B", content: "content only" } ] })
    const r = await s.fetch({ url: "some topic" })
    clean()
    assert.equal(r.sources[0].url, "https://b.com")
    assert.equal(r.sources[0].title, "B")
    assert.ok(r.sources[0].content.includes("content only"))
    console.log("  ✓ 非 URL 入参（Tavily 回退出 query 字段）+ content 字段回退")
  }

  {
    const s = makeTavilyStrategy({ apiKey: "k123" })
    const clean = stubFetch({ results: [ { url: "not-a-url", title: "bad" } ] })
    let threw = false
    try { await s.fetch({ url: "x" }) } catch { threw = true }
    clean()
    assert.equal(threw, true)
    console.log("  ✓ 缺少合法 url 的条目被跳过，最终报错")
  }

  {
    const real = globalThis.fetch
    globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ message: "forbidden" }) })
    const s = makeTavilyStrategy({ apiKey: "bad" })
    let msg
    try { await s.fetch({ url: "x" }) } catch (e) { msg = String(e.message) }
    globalThis.fetch = real
    assert.ok(msg.includes("HTTP 403"))
    assert.ok(msg.includes("forbidden"))
    console.log("  ✓ HTTP 403 时抛出包含状态的错误")
  }

  {
    // 回归：上游载荷的 results 里夹带 null / 非对象元素时不得让整次抓取炸掉。
    // 旧实现直接 item.url → TypeError: Cannot read properties of null，可用结果被一起葬送。
    const s = makeTavilyStrategy({ apiKey: "k123" })
    const clean = stubFetch({ results: [ null, "junk", 42, { url: "https://ok.com", content: "good" } ] })
    const r = await s.fetch({ url: "https://ok.com" })
    clean()
    assert.equal(r.sources.length, 1, "非对象元素应被跳过，合法条目照常返回")
    assert.equal(r.sources[0].url, "https://ok.com")
    assert.ok(r.sources[0].content.includes("good"))
    console.log("  ✓ 病态载荷（null/字符串/数字元素）被跳过而非抛出")
  }

  {
    // 回归：data 本身缺失/null 时回退空数组，走「无结果」的明确错误而非 TypeError
    const s = makeTavilyStrategy({ apiKey: "k123" })
    const clean = stubFetch({ results: null })
    let msg
    try { await s.fetch({ url: "x" }); assert.fail("should throw") } catch (e) { msg = String(e.message) }
    clean()
    assert.ok(msg.includes("no results"), "应为明确的无结果错误，实际: " + msg)
    console.log("  ✓ results 为 null 时报「无结果」而非崩溃")
  }

  {
    const s = makeTavilyStrategy({ apiKey: "k123" })
    try { await s.fetch({ url: "" }); assert.fail("should throw") } catch {}
    console.log("  ✓ 空 url 时报错")
  }

  console.log("========================================")
  console.log("  all tavily tests passed")
}
run().catch(e => { console.error(e); process.exit(1) })

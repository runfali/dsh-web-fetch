/** dsh-web-fetch — CDP 策略与辅助函数单元测试。 */
import assert from "node:assert/strict"
import { withTimeout, plainText, truncate, source } from "../src/helpers.js"
import { makeCdpStrategy } from "../src/strategies/cdp.js"
import * as Router from "../src/router.js"

let passed = 0, failed = 0
async function ok(name, fn) {
  try { await fn(); passed += 1; console.log("  ✓ " + name) }
  catch (err) { failed += 1; console.log("  ✗ " + name); console.log("    " + (err && err.message ? err.message : String(err))) }
}

async function run() {
  console.log("[helpers]")
  await ok("plainText 去掉 HTML 标签并折叠空白", () => { assert.equal(plainText("<p>  hello <b>world</b>  </p>"), "hello world") })
  await ok("plainText 剥离 Markdown 粗体", () => { assert.equal(plainText("**bold**"), "bold") })
  await ok("plainText 处理空/非字符串", () => { assert.equal(plainText(""), ""); assert.equal(plainText(null), ""); assert.equal(plainText(undefined), ""); assert.equal(plainText(123), "") })
  await ok("truncate 在边界内不裁剪", () => { assert.equal(truncate("hi", 5), "hi") })
  await ok("truncate 在边界处裁剪并加省略号", () => { assert.equal(truncate("abcdefgh", 5), "abcd…") })
  await ok("source 构造 WebSource", () => { assert.deepEqual(source("http://x.com", { title:"X", snippet:"s", content:"c", provider:"cdp" }), { url:"http://x.com", title:"X", snippet:"s", content:"c", provider:"cdp" }) })
  await ok("withTimeout 在超时会中止并清理", async () => { const w = withTimeout(undefined, 5); await new Promise(r => setTimeout(r, 20)); assert.equal(w.signal.aborted, true); w.cleanup() })
  await ok("withTimeout 传播上游 signal", async () => { const outer = new AbortController(); const w = withTimeout(outer.signal, 5000); outer.abort(new Error("upstream")); assert.equal(w.signal.aborted, true); w.cleanup() })

  console.log("[CDP strategy factory]")
  await ok("默认配置下 endpoint 回退到默认值", () => { const s = makeCdpStrategy({}); assert.equal(s.id, "cdp"); assert.equal(s.available(), true) })
  await ok("available 返回 true 当 endpoint 合法", () => { assert.equal(makeCdpStrategy({ endpoint:"http://10.200.0.5:9222" }).available(), true) })
  await ok("available 拒绝非法协议", () => { assert.equal(makeCdpStrategy({ endpoint:"gopher://x" }).available(), false) })
  await ok("fetch 拒绝空 query", async () => { const s = makeCdpStrategy({ endpoint:"http://10.200.0.5:9222" }); try { await s.fetch({ query:"" }); assert.fail("should throw") } catch {} })
  await ok("fetch 对缺少协议的 URL 自动补 http", async () => { const s = makeCdpStrategy({ endpoint:"http://127.0.0.1:1" }); try { await s.fetch({ query:"example.com" }); assert.fail("should throw") } catch {} })

  console.log("[Router]")
  await ok("无可用策略时报错", async () => { Router.register([]); try { await Router.fetch({ query:"x" }); assert.fail("should throw") } catch {} })
  await ok("hint 指定不可用策略时报错", async () => { Router.register([{ id:"cdp", available: () => true }]); try { await Router.fetch({ query:"x", provider:"tavily" }); assert.fail("should throw") } catch {} })
  await ok("hint 指定可用策略时直接使用", async () => { let called = null; Router.register([{ id:"cdp", available:()=>true, fetch:()=>{ called="cdp"; return { sources:[], truncated:false } } }, { id:"tavily", available:()=>true, fetch:()=>{ called="tavily"; return { sources:[], truncated:false } } }]); await Router.fetch({ query:"x", provider:"tavily" }); assert.equal(called, "tavily") })
  await ok("恰好一个可用时选择它", async () => { let called = null; Router.register([{ id:"cdp", available:()=>false, fetch:()=>{ called="cdp"; return { sources:[], truncated:false } } }, { id:"tavily", available:()=>true, fetch:()=>{ called="tavily"; return { sources:[], truncated:false } } }]); await Router.fetch({ query:"x" }); assert.equal(called, "tavily") })
  await ok("多可用 + preferred 时选择首选", async () => { let called = null; Router.register([{ id:"cdp", available:()=>true, fetch:()=>{ called="cdp"; return { sources:[], truncated:false } } }, { id:"tavily", available:()=>true, fetch:()=>{ called="tavily"; return { sources:[], truncated:false } } }]); Router.setPreferred("tavily"); await Router.fetch({ query:"x" }); assert.equal(called, "tavily") })
  await ok("多可用 + preferred 为空（auto）时选择第一个", async () => { let called = null; Router.register([{ id:"cdp", available:()=>true, fetch:()=>{ called="cdp"; return { sources:[], truncated:false } } }, { id:"tavily", available:()=>true, fetch:()=>{ called="tavily"; return { sources:[], truncated:false } } }]); Router.setPreferred(""); await Router.fetch({ query:"x" }); assert.equal(called, "cdp") })
  await ok("策略抛错时包装错误消息", async () => { Router.register([{ id:"bad", available:()=>true, fetch:()=>{ throw new Error("boom") } }]); let msg; try { await Router.fetch({ query:"x" }) } catch (e) { msg = String(e.message) }; assert.ok(msg.includes("web-fetch (bad) failed: boom")) })
  await ok("describe 返回策略元信息", () => { Router.register([{ id:"a", title:"A", available:()=>true }, { id:"b", title:"B", available:()=>false }]); const d = Router.describe(); assert.equal(d.length, 2); assert.equal(d[0].available, true); assert.equal(d[1].available, false) })

  console.log("========================================")
  console.log("  passed: " + passed + ", failed: " + failed)
  if (failed > 0) process.exit(1)
}
run().catch(e => { console.error(e); process.exit(1) })

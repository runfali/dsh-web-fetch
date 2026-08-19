/**
 * dsh-web-fetch — 智能路由层（Router）。
*
 * 维护一份已注册的策略列表，根据请求上下文的 provider 提示与
 * 策略可用性，决定由哪一个策略执行本次获取。
*
 * 路由规则：
 *   1. 调用方显式给出 provider 且存在 → 直接使用该策略；
 *   2. 恰好一个策略 available → 使用该策略；
 *   3. 多个策略 available，且首选策略（preferred）available → 使用首选；
 *   4. 多个策略 available，但首选不可用 → 退回第一个 available 的策略；
 *   5. 无可用策略 → 抛出错误。
*
 * 扩展点：新增策略只需在 index.js 的 register 列表追加一条，Router 无改动。
 * @module router
 */

/** @type {import("./types.js").FetchStrategy[]} */
let strategies = []

/** @type {string} */
let preferred = ""

/** 注册/重设策略列表。 */
export function register(list) { strategies = list.slice() }

/** 设置首选策略 id。 */
export function setPreferred(id) { preferred = String(id || "") }

/** 取当前所有 available 的策略。 */
export function available() {
  return strategies.filter((s) => s.available && s.available())
}

/**
 * 执行一次获取请求：路由到合适的策略并转发。
 * @param {import("./types.js").FetchRequest} req
 * @param {AbortSignal} [signal]
 * @returns {Promise<import("./types.js").FetchResult>}
 */
export async function fetch(req, signal) {
  const av = available()
  if (av.length === 0) throw new Error("web-fetch: no available data source (configure CDP endpoint and/or Tavily API key)")
  const hint = String(req.provider || "")
  let chosen
  if (hint && hint !== "auto") {
    chosen = av.find((s) => s.id === hint)
    if (!chosen) throw new Error("web-fetch: requested provider " + hint + " is not registered or not available")
  } else if (av.length === 1) {
    chosen = av[0]
  } else {
    chosen = av.find((s) => s.id === preferred) || av[0]
  }
  try {
    return await chosen.fetch(req, signal)
  } catch (err) {
    if (err.name === "AbortError" || (err && err.cause && err.cause.name === "AbortError")) {
      throw new Error("web-fetch (" + chosen.id + ") aborted", { cause: err })
    }
    throw new Error("web-fetch (" + chosen.id + ") failed: " + (err && err.message ? err.message : String(err)))
  }
}

/** 列出所有已注册策略的元信息（用于诊断与设置页回显）。 */
export function describe() {
  return strategies.map((s) => ({
    id: s.id,
    title: s.title,
    available: s.available && s.available(),
  }))
}

/**
 * dsh-web-fetch — 通用型 Web 内容获取插件（DSH Cordis 插件）。
 *
 * 设计要点：
 *   - 零依赖：除 DSH 平台自带包（@deepseek-ai/schemastery、
 *     @deepseek-ai/dsh-settings）外不引入任何第三方库；
 *   - 零侵入：不改 dsh 核心源码；所有逻辑、路由、设置页卡片
 *     均通过 Cordis 插件 API（导出的 volatile Config + ctx.tools.register）实现；
 *   - 可扩展：每个数据源是一个独立的策略实现（src/strategies/*.js），
 *     且各自注册为**独立工具**——LLM 根据工具描述自主决策用哪一个，
 *     而不是由死规则决定。
 *
 * 关键架构决定：DSH 的 web seam 在同一能力下注册多个 provider 时会抛
 * WEB_PROVIDER_AMBIGUOUS，模型无法在它们之间选择。因此本插件不通过
 * ctx.web.registerSearchProvider 注册，而是为每个策略注册一个独立的
 * 工具（web_fetch_cdp / web_fetch_tavily）；未被启用或不可用的策略
 * 对应的工具不会呈现给 LLM，因此模型只会看到它实际能用的选项。
 *
 * 当前内置数据源：
 *   1. cdp    — CDP 浏览器（默认 http://10.200.0.5:9222）
 *   2. tavily — Tavily Extract API
 */
import z from "@deepseek-ai/schemastery"
import { defineTool } from "@deepseek-ai/dsh-tools"
// dsh 0.1.7-rc.1：installSettingsSection / installSection / settingsNamespace 均已从
// dsh-settings 移除。命名空间改为「cordis 行 id + 导出的 Config schema」，可热编辑
// 字段必须 .volatile()（volatile-only 变更经 configEditor 原地提交，不重启 fiber）。
import { makeCdpStrategy } from "./strategies/cdp.js"
import { makeTavilyStrategy } from "./strategies/tavily.js"

export const name = "web-fetch"
/** 设置命名空间 = 本插件在 cordis 组合树里的行 id（dsh 0.1.7 起宿主按行 id 命名，
 * 插件侧不再有 brand 辅助声明）；也是设置卡与 profile patch 引用的键名。 */
export const SETTINGS_NS = "web-fetch"

/**
 * 设置命名空间的字段模式。每个策略一段独立字段，可视化界面按策略分组。
 *
 * 0.1.7 契约（对照 dsh-settings/lib/index.js 源码）：
 *   - Config 必须从模块导出（cordis fiber.runtime.Config）；未导出 = describe() 枚举
 *     不到本命名空间 = 插件页无配置入口（只见启用/停用行）；
 *   - describe() 只收录 volatileForm(schema) 非空的入口，write() 逐路径校验
 *     isVolatilePath —— 可热编辑字段必须 .volatile()，否则设置页写不进去；
 *   - volatile 字段经 apply 收到 cosmokit 活引用 {get()}，非 volatile 是裸值。
 */
export const Config = z.object({
  cdpEnabled: z.boolean().default(true).volatile(),
  cdpEndpoint: z.string().default("http://10.200.0.5:9222").volatile(),
  cdpTimeoutMs: z.number().min(1000).default(60000).volatile(),
  cdpWaitMs: z.number().min(0).default(2000).volatile(),
  tavilyEnabled: z.boolean().default(false).volatile(),
  tavilyEndpoint: z.string().default("https://api.tavily.com/extract").volatile(),
  tavilyApiKey: z.string().default("").volatile(),
  tavilyTimeoutMs: z.number().min(1000).default(30000).volatile(),
})

/** 读取单个配置字段：0.1.7 起 volatile 字段是 {get()} 活引用，普通字段是裸值。
 * 两种宿主形状都兼容（旧宿主传裸值 → 原样透传）。 */
export function readField(value) {
  if (value !== null && typeof value === "object" && typeof value.get === "function" && !Array.isArray(value)) {
    return value.get()
  }
  return value
}

/** 把一行配置物化为普通值对象：策略工厂与启用判定只该看到裸值。
 * 键集合沿用配置行自身（schema 之外的残留键一并透传，策略工厂自会忽略）。 */
function materializeConfig(row) {
  const out = {}
  const source = row === null || row === undefined ? {} : row
  for (const key of Object.keys(source)) {
    if (key === "__jsExpr") continue
    out[key] = readField(source[key])
  }
  return out
}

/** 从策略 fetch 的返回（{sources, truncated}）投影为工具输出。 */
function projectResult(result) {
  const sources = (result.sources || []).map((s) => {
    const out = { url: s.url }
    if (s.title) out.title = s.title
    if (s.snippet) out.snippet = s.snippet
    if (s.content) out.content = s.content
    if (s.provider) out.provider = s.provider
    return out
  })
  return { sources, truncated: result.truncated || false }
}

function renderResult(result) {
  const lines = []
  if (result.sources.length === 0) {
    lines.push("[web-fetch] 未获取到任何结果。")
  } else {
    result.sources.forEach((s, i) => {
      lines.push("### " + (i + 1) + ". " + (s.title || s.url))
      if (s.provider) lines.push("来源：" + s.provider)
      lines.push(s.url)
      if (s.snippet) lines.push(s.snippet)
      if (s.content && s.content !== s.snippet) lines.push(s.content)
      if (i < result.sources.length - 1) lines.push("")
    })
  }
  if (result.truncated) lines.push("[web-fetch] 结果被截断。")
  return [{ type: "text", text: lines.join("\n") }]
}

/**
 * 为给定策略 id 构建一个 defineTool 描述。策略本身在 execute 时才实例化，
 * 因此每次调用都读取最新的 current() 配置。
 */
function makeToolDef(strategyId, factory, enabledField, configReader) {
  return defineTool({
    name: "web_fetch_" + strategyId,
    description: strategyId === "cdp"
      ? "Fetch the rendered content of a URL via the CDP browser (cloakbrowser). Best for pages requiring JavaScript rendering, interactive apps, or direct browser-based scraping. Provide a URL (scheme optional)."
      : "Fetch page content of a specific URL via Tavily Extract API. Fast, no browser needed. URLs only — it cannot search: use web_search to find pages, then extract a result URL here. Requires a Tavily API key to be configured.",
    parameters: {
      url: {
        type: "string",
        required: true,
        description: strategyId === "cdp"
          ? "The URL to fetch (e.g. https://example.com/page or example.com)."
          : "The URL to extract (e.g. https://example.com/page). Not a search box — pass a URL found via web_search."
      },
      maxResults: {
        type: "number",
        description: "Maximum number of results to return (default 5, Tavily only)."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          sources: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                url: { type: "string", required: true },
                title: { type: "string" },
                snippet: { type: "string" },
                content: { type: "string" },
                provider: { type: "string" }
              }
            }
          },
          truncated: { type: "boolean", required: true }
        }
      },
      render: (_args, value) => renderResult(value)
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      // configReader 每次现取并解引用 volatile 活引用：设置页一保存即生效
      let cfg = configReader()
      let enabled = cfg[enabledField] === true
      if (!enabled && cfg[enabledField] !== false) {
        // 字段缺失或类型异常时，按 truthy 判断（兼容旧存储 string "true"）
        enabled = !!cfg[enabledField]
      }
      if (!enabled) {
        const cur = (() => { try { return JSON.stringify({ [enabledField]: cfg[enabledField], cdpEnabled: cfg.cdpEnabled, tavilyEnabled: cfg.tavilyEnabled }) } catch { return String(cfg[enabledField]) } })()
        throw new Error(
          "web-fetch (" + strategyId + "): data source disabled (current " + cur + "). Enable it on the Plugins page → 通用 Web 内容获取（" + name + "）, or set " + SETTINGS_NS + "." + enabledField + ": true in the profile cordis patch; the form applies live, the patch needs a restart."
        )
      }
      const strategy = factory(cfg)
      if (!strategy.available()) {
        // 区分“未启用”与“配置不完整”：给出更具体的提示
        const hint = strategyId === "tavily" && !cfg.tavilyApiKey
          ? " (tavilyApiKey is empty — paste one from https://app.tavily.com)"
          : strategyId === "cdp" && !cfg.cdpEndpoint
          ? " (cdpEndpoint is empty)"
          : ""
        throw new Error("web-fetch (" + strategyId + "): data source unavailable — strategy.available() returned false" + hint + ". Check the configuration on the Plugins page → 通用 Web 内容获取（" + name + ").")
      }
      try {
        const result = await strategy.fetch({
          url: String(args.url),
          ...(strategyId === "tavily" && args.maxResults !== undefined ? { maxResults: args.maxResults } : {})
        }, exec && exec.signal)
        return projectResult(result)
      } catch (err) {
        throw new Error("web-fetch (" + strategyId + "): " + (err && err.message ? err.message : String(err)))
      }
    }
  })
}

/**
 * Cordis apply：注册展示策略，并为每个策略注册一个独立工具。
 * @param {object} ctx - cordis 上下文。
 * @param {object} config - web-fetch 行配置；0.1.7 起 volatile 字段是 {get()} 活引用。
 */
export function apply(ctx, config = {}) {
  // 0.1.7 不再有 installSection：Config 声明本身就是设置命名空间（ns = 行 id）。
  // 这里只注册 {auto:false} 展示策略，关掉宿主按 schema 自动生成的默认页——
  // 配置卡由 client 半注册进插件页 plugins.item 槽位（与官方插件一致）。
  // 等待式注入：settings 服务晚于本插件到达时回调才执行；加载期无副作用（幂等）。
  ctx.inject(["settings"], (sctx) => {
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber))
  })

  // 每次 execute 现取配置行并解引用 volatile 活引用（设置页保存即时生效）。
  const readConfig = () => materializeConfig(config)

  // 为每个策略注册独立工具；只有 enabled 的策略在 execute 中才真正可用。
  // 传 thunk 而非值：快照会在设置页保存后过期，thunk 每次现读。
  ctx.tools.register(makeToolDef("cdp", makeCdpStrategy, "cdpEnabled", readConfig))
  ctx.tools.register(makeToolDef("tavily", makeTavilyStrategy, "tavilyEnabled", readConfig))
}

/** Cordis 注入项：tools 是硬依赖（注册工具）；settings 走 apply 内等待式注入。 */
export const inject = ["tools"]
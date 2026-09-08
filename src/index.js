/**
 * dsh-web-fetch — 通用型 Web 内容获取插件（DSH Cordis 插件）。
 *
 * 设计要点：
 *   - 零依赖：除 DSH 平台自带包（@deepseek-ai/schemastery、
 *     @deepseek-ai/dsh-settings）外不引入任何第三方库；
 *   - 零侵入：不改 dsh 核心源码；所有逻辑、路由、设置页卡片
 *     均通过 Cordis 插件 API（installSettingsSection、
 *     ctx.tools.register）实现；
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
// dsh 0.1.2-alpha.3：installSettingsSection/settingsNamespace 已从 dsh-settings 移除，
// 设置接线改用 provider 方法 settings.installSection(owner, ns, schema, entry, hooks)。
import { makeCdpStrategy } from "./strategies/cdp.js"
import { makeTavilyStrategy } from "./strategies/tavily.js"

export const name = "web-fetch"
/** dsh 0.1.2-alpha 起 settingsNamespace() brand 辅助已移除；
 * 命名空间在 settings.register/installSection 处校验（小写连字符标识符）。 */
export const SETTINGS_NS = "web-fetch"

/**
 * 设置命名空间的字段模式。每个策略一段独立字段，可视化界面按策略分组。
 */
export const Config = z.object({
  cdpEnabled: z.boolean().default(true),
  cdpEndpoint: z.string().default("http://10.200.0.5:9222"),
  cdpTimeoutMs: z.number().min(1000).default(60000),
  cdpWaitMs: z.number().min(0).default(2000),
  tavilyEnabled: z.boolean().default(false),
  tavilyEndpoint: z.string().default("https://api.tavily.com/extract"),
  tavilyApiKey: z.string().default(""),
  tavilyTimeoutMs: z.number().min(1000).default(30000),
})

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
      query: {
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
      let cfg = configReader()
      let enabled = cfg[enabledField] === true
      if (!enabled && cfg[enabledField] !== false) {
        // 字段缺失或类型异常时，按 truthy 判断（兼容旧存储 string "true"）
        enabled = !!cfg[enabledField]
      }
      if (!enabled) {
        const cur = (() => { try { return JSON.stringify({ [enabledField]: cfg[enabledField], cdpEnabled: cfg.cdpEnabled, tavilyEnabled: cfg.tavilyEnabled }) } catch { return String(cfg[enabledField]) } })()
        throw new Error(
          "web-fetch (" + strategyId + "): data source disabled in settings (current " + cur + "). Enable it in Settings → Plugin Config → " + name + " (or set web-fetch." + enabledField + ": true in ~/.dsh/settings.yaml) and wait 1s for hot-reload."
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
        throw new Error("web-fetch (" + strategyId + "): data source unavailable — strategy.available() returned false" + hint + ". Check configuration in Settings → Plugin Config → " + name + ".")
      }
      try {
        const result = await strategy.fetch({
          query: String(args.query),
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
 * Cordis apply：注册设置命名空间，并为每个策略注册一个独立工具。
 * @param {object} ctx - cordis 上下文。
 * @param {object} config - web-fetch 行配置（作为设置的 composition base）。
 */
export function apply(ctx, config = {}) {
  let current = () => config
  // dsh 0.1.2-alpha.3：独立 installSettingsSection 帮助函数已从 dsh-settings 移除，
  // 同样的接线改为 provider 上的 settings.installSection(owner, ns, schema, entry, hooks)
  // （宿主源码级核对：register(base=entry) → setSource(scope.get) → 卸载回落 effect →
  // onChange() 同步首发 → scope.watch 持续通知）。settings 晚于本插件 apply 时到达，
  // 工具 execute 里的 current() 闭包天然兼容晚接线。
  ctx.inject(["settings"], (sctx) => {
    sctx.settings.installSection(ctx, SETTINGS_NS, Config, config, {
      setSource: (source) => { current = source },
      onChange: () => {}
    })
  })

  // 为每个策略注册独立工具；只有 enabled 的策略在 execute 中才真正可用
  // 注意：不能直接传 current（参数传值是快照，setSource 之后的更新到不了 execute 端）；
  // 须传包装 thunk 每次现取 current()，保持对变量的活引用。
  ctx.tools.register(makeToolDef("cdp", makeCdpStrategy, "cdpEnabled", () => current()))
  ctx.tools.register(makeToolDef("tavily", makeTavilyStrategy, "tavilyEnabled", () => current()))
}

/** Cordis 注入项。 */
export const inject = ["tools", "settings"]
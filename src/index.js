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
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings"
import { makeCdpStrategy } from "./strategies/cdp.js"
import { makeTavilyStrategy } from "./strategies/tavily.js"

export const name = "web-fetch"
export const SETTINGS_NS = settingsNamespace("web-fetch")

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
      : "Fetch page content via Tavily Extract API. Fast, no browser needed. Provide a URL or a natural-language topic. Requires a Tavily API key to be configured.",
    parameters: {
      query: {
        type: "string",
        required: true,
        description: strategyId === "cdp"
          ? "The URL to fetch (e.g. https://example.com/page or example.com)."
          : "A URL to extract, or a natural-language topic to search and extract."
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
      const cfg = configReader()
      const enabled = cfg[enabledField] !== false
      if (!enabled) {
        throw new Error("web-fetch (" + strategyId + "): data source disabled in settings. Enable it in Settings → Plugin Config → " + name + ".")
      }
      const strategy = factory(cfg)
      if (!strategy.available()) {
        throw new Error("web-fetch (" + strategyId + "): data source unavailable. Check configuration in Settings → Plugin Config → " + name + ".")
      }
      try {
        const result = await strategy.fetch({ query: String(args.query) }, exec && exec.signal)
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
  installSettingsSection(ctx, SETTINGS_NS, Config, config, {
    setSource: (source) => { current = source },
    onChange: () => {}
  })

  // 为每个策略注册独立工具；只有 enabled 的策略在 execute 中才真正可用
  ctx.tools.register(makeToolDef("cdp", makeCdpStrategy, "cdpEnabled", current))
  ctx.tools.register(makeToolDef("tavily", makeTavilyStrategy, "tavilyEnabled", current))
}

/** Cordis 注入项。 */
export const inject = ["tools", "settings"]
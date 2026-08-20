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
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

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
      let cfg = configReader()
      // 兼容 DSH 升级后 settings 异步加载的竞态：若首次读取为禁用，等待 800ms 再取一次
      let enabled = cfg[enabledField] === true
      if (!enabled && cfg[enabledField] !== false) {
        // 字段缺失或类型异常时，按 truthy 判断（兼容旧存储 string "true"）
        enabled = !!cfg[enabledField]
      }
      if (!enabled) {
        // 再给一次机会：等待 settings publish（文件监听或 API 同步）
        await new Promise((r) => setTimeout(r, 800))
        try {
          cfg = configReader()
          enabled = cfg[enabledField] === true || !!cfg[enabledField]
        } catch {}
      }
      // 兜底：若内存态仍为 false，但磁盘文件已为 true（经由 gateway 的 loopback 补丁时序或 file watcher 延迟），直接读文件
      if (!enabled) {
        try {
          const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh")
          const candidates = [join(dshHome, "settings.yaml"), join(dshHome, "settings.yml"), join(dshHome, "settings.json")]
          let text = null
          for (const p of candidates) {
            if (existsSync(p)) { try { text = readFileSync(p, "utf8"); break } catch {} }
          }
          if (text && text.includes("tavilyEnabled: true") && strategyId === "tavily") {
            // 从文件粗略提取 tavilyApiKey（避免引入 yaml 依赖，用正则）
            const m = text.match(/tavilyApiKey:\s*([^\n#]+)/)
            const fileKey = m ? m[1].trim().replace(/^['"]|['"]$/g, "") : ""
            cfg = { ...cfg, tavilyEnabled: true, tavilyApiKey: fileKey || cfg.tavilyApiKey }
            enabled = true
          }
          if (text && text.includes("cdpEnabled: true") && strategyId === "cdp") {
            cfg = { ...cfg, cdpEnabled: true }
            enabled = true
          }
        } catch {}
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
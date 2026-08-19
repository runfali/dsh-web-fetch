# dsh-web-fetch

> Dual-source web content fetcher for DeepSeek Harness — CDP browser rendering + Tavily Extract, each as a standalone LLM tool.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)
[![DSH Plugin](https://img.shields.io/badge/DSH-Web%20Profile-7c3aed)](https://github.com/deepseek-ai/dsh)
[![Version](https://img.shields.io/badge/version-0.2.0-orange)](package.json)

**English** | [中文](README.zh-CN.md)

## Why dsh-web-fetch?

DeepSeek Harness's `ctx.web.registerSearchProvider` throws `WEB_PROVIDER_AMBIGUOUS` when multiple providers are registered for the same capability — the model can't choose.

`dsh-web-fetch` takes a different path: **each data source is a standalone DSH tool** (`web_fetch_cdp` / `web_fetch_tavily`) with its own `description` + schema. The LLM picks the right tool based on context, not hard-coded rules.

| Tool | When the LLM should use it | What it does |
|------|-----------------------------|--------------|
| `web_fetch_cdp` | JS-heavy pages, SPAs, sites requiring real rendering | Connects to a remote Chrome via CDP (`cloakbrowser`) and returns rendered content |
| `web_fetch_tavily` | Fast extraction, no browser needed, natural-language topics | Calls Tavily Extract API |

Both can be **independently enabled/disabled** — disabled tools are hidden from the LLM entirely.

## Features

- **Dual pluggable strategies** — CDP + Tavily out of the box, add a new one with 1 file + 1 line
- **Zero-intrusion** — Cordis bundle plugin, no DSH core patch. All via `ctx.tools.register` / `ctx.settings.register` / `installSettingsSection`
- **Zero extra deps** — only `@deepseek-ai/dsh-settings`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`
- **Live config** — settings UI card + `~/.dsh/settings.yaml` hot-reload, no restart needed
- **Concurrency-safe** — `isConcurrencySafe: true`, supports `AbortSignal`

## Architecture

```
dsh-web-fetch/
├── cordis.patch.yml        # bundle patch (install/uninstall)
├── package.json            # dsh.client injection
├── src/
│   ├── index.js            # Cordis apply() + 2 tool registrations
│   ├── types.js            # FetchStrategy契约 (JSDoc)
│   ├── helpers.js          # withTimeout / plainText / truncate
│   └── strategies/
│       ├── cdp.js          # CDP: raw http + manual WS frames, no `ws` dep
│       └── tavily.js       # Tavily Extract API
├── lib/client.js           # Settings card (React + locale zh/en)
└── tests/
    ├── test-cdp-unit.mjs   # 21 tests (helpers 8 + factory 5 + router 8)
    └── test-tavily-unit.mjs # 9 tests
```

**Strategy contract** (`src/types.js`):

```js
// New source = implement this, then register once in src/index.js
export function makeMyStrategy(config) {
  return {
    id: "my",
    title: "My Fetcher",
    available() { return Boolean(config.apiKey) }, // cheap check, no I/O
    async fetch(req, signal) {
      return { sources: [{ url, title, snippet, content, provider: "my" }], truncated: false }
    },
  }
}
```

## Quick Start

### 1. Install

```bash
# from source
cd /data/dsh-workspace/dsh-web-fetch
pnpm install          # DSH loader resolves deps from plugin dir, not host

dsh plugin --profile web add /data/dsh-workspace/dsh-web-fetch
# or after publishing:
# dsh plugin --profile web add dsh-web-fetch

# restart DSH
# systemd: sudo systemctl restart dsh
```

> **Why `pnpm install`?** Cordis plugin loader resolves imports from the plugin directory only. Without it you'll get `ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery`.

### 2. Configure (UI recommended)

Open **Settings → Plugin Config → 通用 Web 内容获取（web-fetch）**

- **Enable toggles** — `CDP` / `Tavily` checkboxes at the top
- **CDP group** — `CDP Endpoint` (default `http://10.200.0.5:9222`), `Timeout ms` (60000), `Extra wait after load ms` (2000)
- **Tavily group** — `Endpoint` (`https://api.tavily.com/extract`), `API Key` (leave empty to disable), `Timeout ms` (30000)

Saved to `~/.dsh/settings.yaml` under `web-fetch:` and hot-reloaded.

<details>
<summary>YAML (profile override) — click to expand</summary>

Edit `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: web-fetch
  config:
    cdpEnabled: true
    cdpEndpoint: 'http://10.200.0.5:9222'
    cdpTimeoutMs: 60000
    cdpWaitMs: 2000
    tavilyEnabled: false
    tavilyEndpoint: 'https://api.tavily.com/extract'
    tavilyApiKey: ''
    tavilyTimeoutMs: 30000
```

> Note: overriding `config` replaces the whole block — include all keys.

</details>

### 3. Use

The LLM will see the tools automatically. Manual test:

```
User: 用 web_fetch_tavily 提取 https://example.com 的正文
User: 用 web_fetch_cdp 抓取 https://example.com 这个需要渲染的页面
```

Tool output shape:

```json
{
  "sources": [{ "url": "...", "title": "...", "snippet": "...", "content": "...", "provider": "cdp|tavily" }],
  "truncated": false
}
```

## Adding a New Data Source

1. Create `src/strategies/my.js` implementing `FetchStrategy`
2. Register in `src/index.js`:

```js
import { makeMyStrategy } from "./strategies/my.js"
ctx.tools.register(makeToolDef("my", makeMyStrategy, "myEnabled", current))
```

3. (Optional) Add fields to `Config` + `FIELD_VIEWS` in `lib/client.js`

No changes to router or core logic needed.

## Development

```bash
node tests/test-cdp-unit.mjs
node tests/test-tavily-unit.mjs
# All tests are offline (no real browser / no real Tavily call)
```

**Requirements:** Node.js >= 22, DSH `>=0.1.0-rc.7`

## Limitations & Notes

- `tavilyApiKey` is stored as plain text in `~/.dsh/settings.yaml` (settings system, not credential vault). For sensitive envs, override via profile `cordis.patch.yml`.
- CDP uses Node's native `http` + hand-rolled WebSocket frames (no `ws` dep). `permessage-deflate` is not used — compatible with `cloakbrowser` default (compression off).
- Version compatibility follows `@deepseek-ai/dsh-settings` / `dsh-tools` / `schemastery`.

## Contributing

PRs welcome! Please:

1. Keep zero extra deps
2. Add a strategy under `src/strategies/` with unit tests
3. Update both `zh`/`en` locales in `lib/client.js` if adding settings

## License

[MIT](LICENSE) © 2025 dsh-web-fetch

---

### 中文说明

完整中文文档请见 **[README.zh-CN.md](README.zh-CN.md)**。

**dsh-web-fetch** 是 DeepSeek Harness 的通用网页内容获取插件，提供 **双数据源、可插拔策略** 能力。核心设计是规避 `registerSearchProvider` 的 `WEB_PROVIDER_AMBIGUOUS` 限制，将每个数据源注册为独立工具，由 LLM 自主决策。`lib/client.js` 内置完整中英文界面。


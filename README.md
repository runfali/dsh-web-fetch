# dsh-web-fetch

> Dual-source web content fetcher for DeepSeek Harness — CDP browser rendering + Tavily Extract, each as a standalone LLM tool.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)
[![DSH Plugin](https://img.shields.io/badge/DSH-Web%20Profile-7c3aed)](https://github.com/deepseek-ai/dsh)
[![Version](https://img.shields.io/badge/version-0.1.7--rc.1-orange)](package.json)

**English** | [中文](README.zh-CN.md)

## Why dsh-web-fetch?

DeepSeek Harness's `ctx.web.registerSearchProvider` throws `WEB_PROVIDER_AMBIGUOUS` when multiple providers are registered for the same capability — the model can't choose.

`dsh-web-fetch` takes a different path: **each data source is a standalone DSH tool** (`web_fetch_cdp` / `web_fetch_tavily`) with its own `description` + schema. The LLM picks the right tool based on context, not hard-coded rules.

| Tool | When the LLM should use it | What it does |
|------|-----------------------------|--------------|
| `web_fetch_cdp` | JS-heavy pages, SPAs, sites requiring real rendering | Connects to a remote Chrome via CDP (`cloakbrowser`) and returns rendered content |
| `web_fetch_tavily` | Fast extraction of a known URL, no browser needed | Calls Tavily Extract API (URLs only — use `web_search` to find pages first) |

Both can be **independently enabled/disabled** — disabled tools are hidden from the LLM entirely.

**Parameters (identical for both tools):**

| Parameter | Required | Type | Meaning |
|---|---|---|---|
| `url` | yes | string | The page URL to fetch (scheme optional, e.g. `https://example.com/page` or `example.com`) |
| `maxResults` | no | number | Max results to return — Tavily only, default 5 |

> **Renamed in `v0.1.5-rc.1`:** this parameter used to be named `query`.
> That name collided with Tavily's own `/extract` request field `query` (a *search term*), and it
> invited callers to pass a search topic where a URL was required. It is now `url`.
> The old name is deliberately **not** accepted as an alias — it fails loudly with
> `invalid arguments: missing required property "url"`, which is itself the migration hint.

## Features

- **Dual pluggable strategies** — CDP + Tavily out of the box, add a new one with 1 file + 1 line
- **Zero-intrusion** — Cordis bundle plugin, no DSH core patch. All via `ctx.tools.register` plus an exported **volatile** `Config` schema (dsh ≥ 0.1.7: the settings namespace *is* the cordis row id, and edits apply live — `installSection`/`settingsScope` no longer exist)
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
├── lib/client.js           # Plugins-page settings card (React + locale zh/en)
└── tests/
    ├── entry.test.mjs           # host entry + manifest + engines table + key parity
    ├── host-integration.test.mjs # real Cordis + ToolRuntime + file settings provider
    ├── test-cdp-unit.mjs        # 21 tests (helpers 8 + factory 5 + router 8)
    ├── test-cdp-frames.mjs      # 5 tests (RFC6455 frame encode/decode)
    ├── test-tavily-unit.mjs     # 13 tests (availability, parsing, error paths, malformed payloads)
    └── client-smoke.mjs         # 15 checks (browser half: render + interaction + read-only)
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
git clone https://github.com/runfali/dsh-web-fetch.git && cd dsh-web-fetch
pnpm install          # DSH loader resolves deps from plugin dir, not host

dsh plugin --profile web add ./dsh-web-fetch
# or after publishing:
# dsh plugin --profile web add dsh-web-fetch

# restart DSH
# systemd: sudo systemctl restart dsh
```

> **Why `pnpm install`?** Cordis plugin loader resolves imports from the plugin directory only. Without it you'll get `ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery`.

### 2. Configure (UI recommended)

Open the Web UI's **Plugins → 通用 Web 内容获取（web-fetch）**

- **Enable toggles** — `CDP` / `Tavily` checkboxes at the top
- **CDP group** — `CDP Endpoint` (default `http://10.200.0.5:9222`), `Timeout ms` (60000), `Extra wait after load ms` (2000)
- **Tavily group** — `Endpoint` (`https://api.tavily.com/extract`), `API Key` (leave empty to disable), `Timeout ms` (30000)

Saving writes the `web-fetch` entry of the profile patch and applies **live** (the fields are declared `volatile`, so no restart and no fiber remount).

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
pnpm test          # full suite
pnpm test:host     # real-host contract tests only
```

All tests are offline (no real browser, no real Tavily call). `tests/host-integration.test.mjs`
drives the plugin on the **real** dsh objects (`@deepseek-ai/cordis`, `dsh-tools`,
`dsh-system-prompt`, `dsh-settings-file`) rather than hand-rolled stubs, and skips loudly
when those packages are unresolvable.

## Requirements

| Item | Value |
|---|---|
| DeepSeek Harness | `>=0.1.2-alpha.3 <0.1.8 \|\| >=0.1.5-alpha.1 <0.1.6 \|\| >=0.1.7-alpha.0 <0.1.8 \|\| >=0.2.0-alpha.0 <0.3.0 \|\| >=0.2.1-alpha.0 <0.3.0 \|\| >=0.2.2-alpha.0 <0.3.0` (contract-verified on 0.1.2-rc.1, 0.1.5-rc.1, 0.1.7-rc.1, 0.2.0-rc.1, 0.2.1-rc.2 and 0.2.2-rc.1) |
| Node.js | `>=22` |
| Runtime dependencies | **none** — the three deps come from the dsh host install |

> **Why the disjunction?** npm semver satisfies a prerelease only from a range group that
> itself carries a prerelease with the same `[major, minor, patch]` tuple. The previous
> single `>=0.1.2-alpha.3 <0.2.0` group therefore did **not** cover `0.1.5-rc.1` —
> "claims 0.1.5 support but fails its own claim". The same trap applies to every
> dependency range on a dsh package. `tests/entry.test.mjs` pins this with a 27-row
> decision table (both strict and host-gate mode), a counter-proof per adaptation round,
> and a line-by-line cross-check against the host's real `semver.satisfies`.

## Limitations & Notes

- `tavilyApiKey` is stored as plain text in the settings document (settings system, not credential vault). For sensitive envs, override via profile `cordis.patch.yml`.
- CDP uses Node's native `http` + hand-rolled WebSocket frames (no `ws` dep). `permessage-deflate` is not used — compatible with `cloakbrowser` default (compression off).
- Version compatibility: see the Requirements table above (machine-readable in `package.json` under `dsh.engines.dsh`).

## Contributing

PRs welcome! Please:

1. Keep zero extra deps
2. Add a strategy under `src/strategies/` with unit tests
3. Update both `zh`/`en` locales in `lib/client.js` if adding settings

## dsh 0.2.2-rc.1 adaptation notes

Verified against the desktop install at `D:\DeepSeek Harness\` (`dsh` `0.2.2-rc.1` from
`resources/app.asar/dsh/package.json`) by unpacking the host sources and running the host's
**real** compatibility gate — not by reading version strings.

- **The only mandatory change is the compatibility range.** Measured with the host's own
  `evaluatePluginCompatibility`: the previous five-clause range returned `undefined` (PASS)
  on `0.2.2-rc.1`, so the plugin was **not** being rejected at load time. What rejected it was
  **strict semver mode** (`semver.satisfies` without `includePrerelease`, i.e. pnpm install time).
  Added `|| >=0.2.2-alpha.0 <0.3.0` to all four strings (three peers + `dsh.engines.dsh`) and
  verified a **real negative case**: the gate returns requirements for `0.3.0`.
- **Contract surface unchanged.** Checked at source level on 0.2.2-rc.1:
  `dsh-tools/lib/index.js:433` `register(definition, options = {})` (still requires
  `output.schema` + `output.render`, `:436`), `dsh-tools/lib/index.js:417` `super(ctx, "tools")`,
  `dsh-settings/lib/index.js:370` `configure(presentation, owner = this.ctx.fiber)` with `auto`
  defaulting to `true`, `cordis/lib/index.js:1672` `inject(inject, callback)`, and the client
  side `configForms.whileServed` / `slots.inject` / `locale.register`. **`src/` and
  `lib/client.js` were not touched.**
- **One real drift, in the test fixture, not the plugin.** `dsh-settings` `describe()` now reads
  the live value from `entry.fiber.effectiveConfig` (`dsh-settings/lib/index.js:436`; the getter is
  `cordis/lib/index.js:653` `get effectiveConfig()`), where 0.2.1 used `fiber.config`. The
  settings harness in `tests/host-integration.test.mjs` faked only `config`, so `describe()` returned
  `value: undefined`. Both keys are now provided on the fake fiber, so the fixture satisfies old
  and new hosts without pretending to know which one is running.
- **`@deepseek-ai/schemastery`:** the host ships `3.19.0` and `dsh-settings@0.2.2-rc.1` requires
  `~3.19.0`. Peer widened to `~3.18.4 || ~3.19.0` and `3.19.0` pinned explicitly in
  `devDependencies` — otherwise peer auto-install resolves `3.18.4` and the tests run against the
  old fixture. `pnpm peers check`: no issues.
- **Two semver modes stay side by side** in the decision table (strict / host gate with
  `includePrerelease: true`). `0.2.2-rc.1` moved from a fork row (`false / true`) to a consistent
  row (`true / true`) now that the clause exists; `0.3.0-alpha.0` deliberately stays a fork row,
  because `<0.3.0` under `includePrerelease` lets its own prerelease through.
- Verification: `npm test` → entry **18 groups**, host-integration **7 groups**, cdp-unit **21**,
  tavily-unit all green, cdp-frames **5 tests**, client-smoke **19 checks**, **0 skipped**;
  `pnpm peers check` clean; stripping the new clause turns the guard red (mutation test).
- Full evidence, change list and honest gaps: `docs/DSH-0.2.2-ADAPTATION.md`.

## dsh 0.2.1-rc.2 adaptation notes

Unpacked host comparison + a live run of the host's real gate against the desktop install
(`0.2.1-rc.2`):

- **Zero drift on the contract surface**: `dsh-tools` `defineTool`, `dsh-settings`
  `configure()`/`volatileForm`, `dsh-web` `registerSearchProvider`, and the client-side
  `configForms.whileServed` / `slots.inject` all kept their shape in 0.2.1 (the official
  `dsh-client-ui-settings-web-search` still requires
  `@deepseek-ai/dsh-client-ui-primitives` itself). **`src/` and `lib/client.js` unchanged.**
- **That round repaired pnpm install time, not the load gate**: under the real gate the old
  four-clause range returned `evaluatePluginCompatibility(...) → undefined` (PASS), so 0.2.1 could
  already load it. What rejected it was strict mode (`semver.satisfies` defaults, pnpm install
  time). A real negative case (`>=0.1.7-alpha.0 <0.1.8`) was judged REJECT, proving the gate
  actually evaluates.
- **The gate semantics changed in 0.2.1**: `unmetRequirements` now says "if a top-level
  `engines.dsh` exists it decides alone and peers are ignored". This repo writes its range in the
  nested `dsh.engines.dsh` (not top-level), so peers still decide — confirmed by the real gate.
- **Two semver modes coexist**: the table gained a second column (strict / host gate with
  `includePrerelease: true`), and fork rows were pinned explicitly so `<0.3.0` is never misread
  as "0.3 is fully blocked".
- Verification: `npm test` 17 + 7 groups plus cdp/tavily/frames/client all green, **0 skipped**;
  host-integration runs against the real `dsh-tools`/`dsh-settings`/`dsh-system-prompt@0.2.1-rc.2`.

## dsh 0.2.0-rc.1 adaptation notes

Unpacked host comparison + a live run of the real gate against `0.2.0-rc.1`:

- **The only mandatory change was the compatibility range**: the old range was rejected by the
  startup gate (`dsh: skipping profile bundle ...`) and the **whole bundle never loaded** (web and
  desktop both dead). Adding `|| >=0.2.0-alpha.0 <0.3.0` fixed it.
- **The gate reads only `peerDependencies`**: `evaluatePluginCompatibility` in `dsh-app-boot`
  iterates the `@deepseek-ai/dsh*` entries of `peerDependencies` and **never reads
  `dsh.engines.dsh`** (zero consumers in the tree). The two must stay byte-identical — a test
  guards it.
- **Two semver modes**: the host gate uses `includePrerelease: true`, which bypasses prerelease
  visibility, so **the upper bound's own prerelease is admitted too** (`<0.1.8` admits
  `0.1.8-rc.1`, `<0.3.0` admits `0.3.0-alpha.0`); strict mode rejects them. The upper bound blocks
  the **release**, not the prereleases. To block prereleases as well the bound must be written
  `<0.3.0-0`.
- **Evidence**: see `docs/DSH-0.2.0-ADAPTATION.md` for the full trace, change list, test results
  and honest gaps.


## License

[MIT](LICENSE) © 2025 dsh-web-fetch

---

### 中文说明

完整中文文档请见 **[README.zh-CN.md](README.zh-CN.md)**。

**dsh-web-fetch** 是 DeepSeek Harness 的通用网页内容获取插件，提供 **双数据源、可插拔策略** 能力。核心设计是规避 `registerSearchProvider` 的 `WEB_PROVIDER_AMBIGUOUS` 限制，将每个数据源注册为独立工具，由 LLM 自主决策。`lib/client.js` 内置完整中英文界面。

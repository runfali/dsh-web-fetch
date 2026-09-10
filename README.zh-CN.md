# dsh-web-fetch

[English](README.md) | **中文**

**通用型 Web 内容获取插件（DeepSeek Harness / Cordis bundle）**

为 DSH Web UI（`dsh --profile web`）提供**双数据源、可扩展策略**的通用网页内容获取能力。两个数据源**各自注册为独立的 DSH 工具**（`web_fetch_cdp` / `web_fetch_tavily`），**由 DSH 的 LLM 模型根据工具描述自主决策调用哪一个**，而不是由死规则决定。

## 数据源

- **CDP 浏览器**（`web_fetch_cdp`）— 通过 Chrome DevTools Protocol HTTP 端点（默认 `http://10.200.0.5:9222`）连接本地部署的远程浏览器（如 `cloakbrowser`），用真实渲染获取动态页面内容；适合需要 JavaScript 渲染的页面；
- **Tavily**（`web_fetch_tavily`）— 通过 Tavily Extract API 获取页面内容，只需在设置页填写 `API Key`；速度快，不需要浏览器。

**工具参数（两个工具完全一致）：**

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `url` | 是 | string | 要抓取的页面 URL（可省略协议，如 `https://example.com/page` 或 `example.com`） |
| `maxResults` | 否 | number | 最多返回条数——仅 Tavily 生效，默认 5 |

> **`v0.1.5-rc.1` 起改名：** 该参数原名为 `query`。旧名与 Tavily `/extract` 请求体里真正的
> `query` 字段（语义是**搜索词**）同名，误导调用方把搜索主题词当 URL 传进来。现已更名为 `url`。
> 旧名**刻意不做兼容别名**——它会以 `invalid arguments: missing required property "url"`
> 响亮失败，这条报错本身就是迁移提示。

两个数据源**可独立启用/禁用**；未被启用的数据源对应的工具不会呈现给 LLM。

## 设计目标

- **零依赖**：除 DSH 平台自带包（`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`）外无任何第三方库；
- **零侵入**：不改 DSH 核心源码；所有逻辑、路由、配置界面均通过 Cordis 插件 API（`settings.installSection`（dsh ≥ 0.1.2-alpha）、`ctx.tools.register`）实现；
- **可扩展**：每个数据源是一个**独立的策略实现**（`src/strategies/*.js`），遵循统一的 `FetchStrategy` 契约；新增数据源只需添加一个新策略文件并在入口 `src/index.js` 追加一行 `ctx.tools.register(makeToolDef(...))`——核心路由与入口无需改动。

## 为什么不用 ctx.web.registerSearchProvider

DSH 的 web seam 在同一能力（search / fetch）下注册**多个 provider** 时会抛 `WEB_PROVIDER_AMBIGUOUS` 错误，无法自动选择。唯一的模型级选择入口是 DSH 的**工具层**——每个工具携带 `name` + `description` + `parameters` schema，LLM 根据上下文自主决定调用哪一个。

因此本插件注册两个独立工具：

| 工具 | 何时使用 |
| --- | --- |
| `web_fetch_cdp` | 需要 JavaScript 渲染、动态交互页面、直接 URL 抓取 |
| `web_fetch_tavily` | 快速提取已知 URL 的内容，不需要浏览器（不搜索，先用 web_search 找页面） |

## 架构概览

```
dsh-web-fetch/
|-- cordis.patch.yml              # DSH 标准 bundle patch（安装/卸载用）
|-- package.json                  # 元信息与 dsh.client 注入声明
|-- README.md
|-- LICENSE
|-- .gitignore
|-- src/
|   |-- index.js                  # Cordis apply() + 策略注册 + 两个工具
|   |-- types.js                  # FetchStrategy / WebSource 类型契约（JSDoc）
|   |-- router.js                 # 保留作为未来扩展点（当前未使用）
|   |-- helpers.js                # withTimeout / plainText / truncate / source
|   `-- strategies/
|       |-- cdp.js                # CDP 浏览器策略（HTTP + 手工 WS + 页面抓取）
|       `-- tavily.js             # Tavily Extract API 策略
|-- lib/
|   `-- client.js                 # 浏览器端 Settings 配置卡片（React + locale）
`-- tests/
|   |-- entry.test.mjs           # 入口/声明/engines/键集合一致性守护
|   |-- host-integration.test.mjs # 真宿主对象契约测试
|   |-- test-cdp-unit.mjs         # CDP 策略单元测试（纯本地）
|   |-- test-cdp-frames.mjs       # WebSocket 帧编解码测试
|   `-- client-smoke.mjs          # client half：渲染 + 交互 + 只读态
`-- test-tavily-unit.mjs      # Tavily 策略单元测试（纯本地）
```

## 安装 / 卸载

### 首次安装（从源码）

```bash
# 1. 拉取代码后，先安装依赖（DSH loader 只在插件本地目录解析依赖）
git clone https://github.com/runfali/dsh-web-fetch.git && cd dsh-web-fetch
pnpm install

# 2. 注册插件到 DSH web profile
dsh plugin --profile web add ./dsh-web-fetch

# 3. 重启 DSH 生效
# （systemd 服务下执行：sudo systemctl restart dsh）
```

> **为什么需要 pnpm install**：DSH 的 cordis-plugin-loader 从插件所在目录解析 import，
> 它不会从宿主 DSH 的 node_modules 回退。如果不提前安装依赖，启动时会报
> `ERR_MODULE_NOT_FOUND`（例如 `Cannot find package @deepseek-ai/schemastery`）。

### 安装 / 卸载

```bash
# 从本地路径安装
dsh plugin --profile web add ./dsh-web-fetch

# 已发布包名时只需包名
dsh plugin --profile web add dsh-web-fetch

# 卸载
dsh plugin --profile web remove dsh-web-fetch
```

安装或卸载后重启 DSH 生效。

## 配置

### 可视化配置（推荐）

安装后打开 Web UI 的 **设置 → 插件配置**，会看到「通用 Web 内容获取（web-fetch）」卡片，展开后可按组填写：

- **数据源启用开关**：顶部两个 checkbox 分别控制 CDP 与 Tavily 是否可用；
- **CDP 浏览器组**
  - `CDP 端点 URL`（默认 `http://10.200.0.5:9222`）
  - `CDP 超时（毫秒）`（默认 60000）
  - `页面加载额外等待（毫秒）`（默认 2000）
- **Tavily 组**
  - `Tavily API 端点`（默认 `https://api.tavily.com/extract`）
  - `Tavily API Key`（留空则禁用 Tavily，对应工具不会呈现给 LLM）
  - `Tavily 超时（毫秒）`（默认 30000）

保存后写回 `~/.dsh/settings.yaml` 的 `web-fetch:` 段并热生效。

### profile 用户补丁层

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，追加如下段落（整段替换 `config`，覆盖时需写全所有项）：

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

## 策略模式（如何新增数据源）

1. 在 `src/strategies/<name>.js` 中实现 `FetchStrategy` 接口：

```js
// src/strategies/my.js
export function makeMyStrategy(config) {
  return {
    id: "my",
    title: "My Fetcher",
    available() { /* 廉价可用性检查，不发网络请求 */ return Boolean(config.apiKey) },
    async fetch(req, signal) {
      return { sources: [{ url, title, snippet, content, provider: "my" }], truncated: false }
    },
  }
}
```

2. 在 `src/index.js` 中导入并注册为工具：

```js
import { makeMyStrategy } from "./strategies/my.js"
// 在 apply() 中：
// 必须传 thunk：传 current 本身是「快照」，setSource 之后的更新到不了 execute 端
ctx.tools.register(makeToolDef("my", makeMyStrategy, "myEnabled", () => current()))
```

3. （可选）在 `Config` 添加对应字段，在 `lib/client.js` 的 `FIELD_VIEWS` 添加对应视图行。

## 测试

```bash
pnpm test          # 全套
pnpm test:host     # 只跑真宿主契约测试
```

测试全部离线（不连接真实浏览器、不发真实 API 请求）：

- **entry.test.mjs** — 11 项：真实入口加载 + 声明面 + engines 判定表（含反证与宿主真实 `semver.satisfies` 交叉验证）+ 四处配置键集合一致性 + 依赖卫生；
- **host-integration.test.mjs** — 5 项：用**真宿主对象**（`@deepseek-ai/cordis` + `dsh-tools` 真 `ToolRuntime` + `dsh-system-prompt` + `dsh-settings-file`）驱动插件，覆盖真实注册表、真 schema 校验、端到端 execute、设置热更新活引用；依赖不可解析时显式 skip（不假绿）；
- **test-cdp-unit.mjs** — 21 项：helpers（8）+ CDP 策略工厂（5）+ Router（8）；
- **test-cdp-frames.mjs** — 5 项：RFC6455 帧编解码与边界；
- **test-tavily-unit.mjs** — 13 项：Tavily 策略的可用性、解析、错误路径、病态载荷。
- **client-smoke.mjs** — 15 项：浏览器半结构加载 + locale 键集合 + slot 注册契约 + **交互层盲区**（可写态控件不禁用 / 只读态全禁用含保存按钮 / 开关落 user 层 / 数字字段以 number 落盘 / 清空文本回落默认 / 非法输入置 invalid）。

## 限制

- `tavilyApiKey` 作为普通设置字段保存到 `~/.dsh/settings.yaml`，不经过凭据系统；敏感环境建议在 profile 用户层显式覆盖；
- CDP 依赖节点原生 `http` 模块手工实现 WebSocket，未使用第三方的 `ws` 库；未启用 `permessage-deflate` 压缩（仅发送协商头，服务端如回传压缩帧则本插件会忽略 continuation 帧，当前 cloakbrowser 默认不启用压缩因此兼容）；
- DSH 版本兼容：`>=0.1.2-alpha.3 <0.2.0 || >=0.1.5-alpha.1 <0.1.6`（已在 0.1.2-rc.1 与 0.1.5-rc.1 实测）；为什么必须加析取区间：npm semver 的预发布同元组规则使旧单区间覆盖不了 `0.1.5-rc.1`。机器可读声明在 `package.json` 的 `dsh.engines.dsh`。

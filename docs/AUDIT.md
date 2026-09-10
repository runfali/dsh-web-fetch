# dsh-web-fetch 审计报告

> 审计时间：2026-09-01 · 审计对象：v0.3.0（commit d386e9c，dsh 0.1.2-alpha.3 适配后）
> 方法：代码级逐文件通读 + 契约级源码对照（dsh-tools / dsh-settings / dsh-llm）+ 测试执行（21/21 全绿）+ 行为模拟

## 一、总体结论

**无 P0/P1**；发现 1 个 P2（长等待竞态兜底逻辑）与若干 P3。测试 21 项全绿（cdp 14 + tavily 7），typecheck 干净。契约对照真实宿主源码全部一致。

## 二、契约级核实（通过 ✅）

| 契约点 | 核实结果 |
|---|---|
| `defineTool` 四参契约 | dsh-tools `lib/index.js:852` 真实实现：`parameters` 经 `parameterSchemaSpecToJsonSchema` 编译、`output.schema` 经 `valueSchemaSpecToJsonSchema`、`execute(args, exec)` 先 validate 再执行、`isConcurrencySafe` 先 validate 再调——插件用法一致 |
| `ctx.tools.register` | dsh-tools `super(ctx, 'tools')`（2606 行）确认服务名 |
| `settings.installSection` | 同 web-search-custom 核实，接线一致 ✅ |
| `llm.attributionHeaders` | dsh-llm 导出确认（`lib/index.js:732`）——tavily 直连 fetch 无需 attribution，但 CDP 策略不涉及 LLM 链路 |
| web seam 决策 | 双策略各自独立注册工具而非 `registerSearchProvider`——规避 `WEB_PROVIDER_AMBIGUOUS` 的架构决定，与 dsh-web `resolveProvider` 源码（单 provider 无歧义才可用）吻合 |

## 三、发现的问题

### 🟠 P2-1 execute 内 800ms 等待 + 磁盘文件兜底（竞态 workaround 层）

- **事实**（`src/index.js:135-170`）：工具 execute 首次读到未启用时，`await 800ms` 重读，再不行**直接读 `~/.dsh/settings.yaml` 文件**（正则匹配 `tavilyEnabled: true` / `cdpEnabled: true` / `tavilyApiKey`）决定启用。
- **风险**：
  1. **硬编码路径假设**：`DSH_HOME || ~/.dsh`，与 dsh-settings-file 的 `resolveDshHome` 一致 ✅，但 profile 形态未验证。
  2. **正则解析 YAML 脆弱**：会把注释行/多行值/引号值解析错。
  3. **时序根因未消**：settings 经 `installSection` 同步接线，`onChange` 首发在 apply 时已同步。
- **修复建议**：核实后删除磁盘兜底分支，仅保留 settings 层判断。

### 🟠 P2-2 CDP 策略测试盲区：WebSocket 帧解析无真机/仿真覆盖

- **事实**：`tests/test-cdp-unit.mjs` 只测 helpers/策略工厂/Router 逻辑，**未覆盖 `CdpClient` 的帧编码/解码/分片重组/掩码**。
- **处置**：已补 `tests/test-cdp-frames.mjs`（5 项 round-trip 与边界）。

### 🟡 P3 杂项

| # | 问题 | 说明 |
|---|---|---|
| P3-1 | `router.js` 未被 src 引用 | `index.js` 只注册两个独立工具，Router 仅在测试中被 import |
| P3-2 | `tavily` 的 `maxResults` 曾未从 args 读取 | 已修（c8875c1 起透传） |
| P3-3 | `projectResult` 不保留 `publishedAt` | web-fetch 是 fetch 非 search，可接受 |

---

# 第二轮：dsh 0.1.5-rc.1 适配（2026-09-10）

> 触发：宿主升级到 0.1.5-rc.1，要求插件跟进。
> 方法：先证明改动面，再动代码——逐条对照新版宿主真实源码（不是 d.ts），
> 全部结论以装在本机的 0.1.5-rc.1 包为证据。

## 一、总体结论

**API 层零破坏**：插件依赖的每个契约在 0.1.5-rc.1 上均未变，`src/` 业务逻辑无需适配性修改。
改动面 = **声明面 + 测试面 + 文档面**，外加审计中发现并修复的 **1 个真缺陷（P2）**。

测试从 33 项扩到 **55 项全绿**（entry 11 + host-integration 5 + cdp-frames 5 + cdp-unit 21 + tavily 13）。

## 二、契约级对照（0.1.5-rc.1 实测，全部通过 ✅）

| 契约点 | 判据 | 0.1.5-rc.1 实测 |
|---|---|---|
| `settings.installSection(owner, ns, schema, entry, hooks)` | 与插件开发依赖副本 `diff` | **逐字节相同**（整个 lib/index.js，非仅函数体） |
| `defineTool(options)` | `dsh-tools/lib/index.js:837` 函数体 | 与 0.1.2-alpha.3 副本逐字节相同；无 Symbol/brand 身份校验 → 跨副本调用安全 |
| `ctx.tools.register(definition)` | `register()` 校验分支 | 仍强制 `output.{schema,render}`、仍拒 `run_code` 重名；插件两工具都满足 |
| `hooks.setSource / onChange` | `installSection` 内 `setSource(() => scope.get())` | 未变；活引用接线（thunk）依旧成立 |
| web seam 歧义规则 | `dsh-web/lib/index.js:130` `WEB_PROVIDER_AMBIGUOUS` | 未变——「每数据源注册独立工具」的架构决定仍然正确 |
| DSH 依赖包版本 | `node_modules/@deepseek-ai/dsh-{settings,tools}` | 升到 0.1.5-rc.1 后与宿主副本 `diff -rq` 只剩空的 `node_modules` 目录差异 |

## 三、本轮修复

### 🟠 P2-3（真缺陷）上游载荷含非对象元素时整次抓取崩溃

- **事实**（`src/strategies/tavily.js`）：`for (const item of results) { const url = item.url ... }`。
  `results` 或 `data` 为 `null`、或数组里夹带 `null` / 字符串 / 数字元素时直接抛
  `TypeError: Cannot read properties of null (reading 'url')`。
- **影响**：一次成功的抓取请求里有 1 个病态元素 → **整次工具调用失败**，可用结果被一起葬送
  （用户看到的是模型报错，而不是「少了一条结果」）。
- **复现**：`results: [null, {url:'https://example.com', content:'hi'}]` → `TypeError`（修复前）。
- **修法**：两处守卫——`data` 解引用前判定对象、循环内跳过非对象元素。
  与同批适配的 dsh-web-search-custom（commit f073396）同源缺陷，两仓已同时收口。
- **守护**：`tests/test-tavily-unit.mjs` 新增 2 项（病态元素被跳过 / `results:null` 报明确的无结果错误），
  对修复前的代码反证变红。

## 四、声明面变更

| 项 | 变更 | 理由 |
|---|---|---|
| `version` | `0.1.2-rc.1` → `0.1.5-rc.1` | 家族惯例：跟宿主发布 tag |
| `dsh.engines.dsh` | **新增**（原先整个字段缺失） | 原先零声明 = 「声称兼容一切」；补齐并写清区间 |
| 三个依赖区间 | `^0.1.2-alpha.3` → 析取区间 | semver 预发布同元组规则（见下） |
| `scripts.test` / `test:host` | 新增 | `pnpm test` 一条命令跑全套 |
| `pnpm-workspace.yaml` | release-age 白名单刷新到 0.1.5-rc.1 系 | 不刷新时 pnpm 会静默解析成 0.1.5-alpha.1 |
| `files` | 增补 `README.zh-CN.md` | 发布面含中文文档 |

**engines 陷阱（本轮最值得记）**：npm semver 只让「区间内**含同一 [major,minor,patch] 元组的预发布**」
去满足一个预发布版本。旧的单区间 `>=0.1.2-alpha.3 <0.2.0` 里的预发布只有 `0.1.2-alpha.3`，
因此**覆盖不了 `0.1.5-rc.1`**（`0.1.5-alpha.1` 也不行）。这正是「声明适配 0.1.5，却不被自己的声明覆盖」。
修法是**加析取**（不动上界语义）。同一陷阱适用于**每一处** dsh 版本区间——本轮改了 4 处。

## 五、测试面（33 → 55）

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `tests/entry.test.mjs` | 11 | 真实入口加载、apply 同步、defineTool 强制声明、**热更新活引用（闭包快照陷阱）**、manifest、engines 判定表 10 行 + 反证 + 宿主真 semver 交叉验证、**四处配置键集合一致性**、依赖卫生 |
| `tests/host-integration.test.mjs` | 5 | **真宿主对象**（真 cordis Context + 真 ToolRuntime + 真 SystemPrompt + 真 FileSettingsProvider）：真注册表、真 schema 校验拒绝缺参、端到端 execute + render、**文档提交后工具立刻读到新值**、schema default 落成 resolved 值 |
| `tests/test-cdp-frames.mjs` | 5 | RFC6455 帧编解码（已有，本轮纳入 `pnpm test`） |
| `tests/test-cdp-unit.mjs` | 21 | helpers / 策略工厂 / Router（已有） |
| `tests/test-tavily-unit.mjs` | 13 | 原有 11 + **病态载荷 2 项回归** |

**每条守护都跑了反证变红**（守则：绿的测试不证明有牙齿）：
1. 把 `dsh.engines.dsh` 改回旧单区间 → engines 3 项全红；
2. 把 client `FIELD_KEYS` 改一个键名 → 键集合一致性测试红（「静默调不到开关」那类缺陷）；
3. 把 `() => current()` 改回传 `current`（快照）→ entry 1 项 + host-integration 2 项红。

## 六、本轮审计角度的诚实缺口

- **未做真机 E2E**：CDP 需要活的远程浏览器、Tavily 需要真实 API Key，本轮全部离线。
  「安装 → 挂载 → 下发」三段由发哥在真机验收。
- **WebSocket 长连接未打真服务器**：帧层只做 round-trip，未验证真实 cloakbrowser 的分片行为。
- `docs/` 属内部审计资料，未进 `package.json` 的 `files`，不随包发布。


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

测试从 33 项扩到 **55 项全绿 + client 15 项交互断言**（entry 11 + host-integration 5 + cdp-frames 5 + cdp-unit 21 + tavily 13；client-smoke 另外 15 项）。

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

## 五、测试面（33 → 55 + client 15）

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `tests/entry.test.mjs` | 11 | 真实入口加载、apply 同步、defineTool 强制声明、**热更新活引用（闭包快照陷阱）**、manifest、engines 判定表 10 行 + 反证 + 宿主真 semver 交叉验证、**四处配置键集合一致性**、依赖卫生 |
| `tests/host-integration.test.mjs` | 5 | **真宿主对象**（真 cordis Context + 真 ToolRuntime + 真 SystemPrompt + 真 FileSettingsProvider）：真注册表、真 schema 校验拒绝缺参、端到端 execute + render、**文档提交后工具立刻读到新值**、schema default 落成 resolved 值 |
| `tests/test-cdp-frames.mjs` | 5 | RFC6455 帧编解码（已有，本轮纳入 `pnpm test`） |
| `tests/test-cdp-unit.mjs` | 21 | helpers / 策略工厂 / Router（已有） |
| `tests/test-tavily-unit.mjs` | 13 | 原有 11 + **病态载荷 2 项回归** |
| `tests/client-smoke.mjs` | 15 | 浏览器半：结构加载 / locale / slot 契约 / **交互层盲区**（dsh-plugin-audit 反复强调的「本地全绿、真机翻车」区）：可写态 8 控件不禁用、只读态全禁用（含保存按钮）、开关落 user 层、数字以 number 落盘、清空回落默认、非法输入置 invalid |

**每条守护都跑了反证变红**（守则：绿的测试不证明有牙齿）：
1. 把 `dsh.engines.dsh` 改回旧单区间 → engines 3 项全红；
2. 把 client `FIELD_KEYS` 改一个键名 → 键集合一致性测试红（「静默调不到开关」那类缺陷）；
3. 把 `() => current()` 改回传 `current`（快照）→ entry 1 项 + host-integration 2 项红。
4. 把只读态绑定的 `disabled: props.disabled` 写成 `disabled: false` → client smoke 红（「控件永远禁用/永不禁用」正是真机翻车形态）；
5. 数字字段改写成 `String(n)` 落盘 → client smoke 红。

## 六、本轮审计角度的诚实缺口

- **未做真机 E2E**：CDP 需要活的远程浏览器、Tavily 需要真实 API Key，本轮全部离线。
  「安装 → 挂载 → 下发」三段由发哥在真机验收。
- **WebSocket 长连接未打真服务器**：帧层只做 round-trip，未验证真实 cloakbrowser 的分片行为。
- `docs/` 属内部审计资料，未进 `package.json` 的 `files`，不随包发布。

---

# 第三轮：dsh 0.1.7-rc.1 适配（2026-09-26）

> 触发：宿主升级到 0.1.7-rc.1，web-fetch 仍停在 0.1.5 契约。
> 方法：先证改动面再动代码；结论全部来自本机安装副本的源码级对照，见 [DSH-0.1.7-ADAPTATION.md](DSH-0.1.7-ADAPTATION.md)。

## 一、总体结论

**业务逻辑零改动**；破坏面全在设置接线——0.1.5 的四条老契约在 0.1.7 全部被移除或改形。
不修的后果是标准三连静默：host 侧 `installSection` 不存在 → 崩；client 侧 `settingsScope` 不存在 → 崩；
槽位 key 不存在 → 卡片不出现。按 dsh-plugin-audit 分级属 P0（装不生效/必崩）。

## 二、修复清单（P0 × 5）

| # | 缺陷 | 修法 |
|---|---|---|
| P0-1 | host 调已删除的 `settings.installSection` | 删接线；命名空间改由导出 Config + 行 id 成立 |
| P0-2 | Config 八字段非 volatile → 设置页写入被 `isVolatilePath` 拒 | 全部 `.volatile()` + `readField()` 解引用 |
| P0-3 | client 用已删除的 `ctx.settingsScope` | 改 `configForms.get(ns)` |
| P0-4 | 卡注册在已删除的 `settings.plugin.item` / generator 形态回调 | 迁 `plugins.item`（list）+ 返回 disposer 的普通函数 + `whileServed` 门控 |
| P0-5 | 未注册展示策略 → 宿主自动页与自研卡并存 | `settings.configure({auto:false})` |

## 三、次级问题（P1/P2）

| 级别 | 问题 | 处置 |
|---|---|---|
| P1 | 组件 `if (!state.available) return null`：命名空间未被服务时详情页一片空白（无任何解释） | 改渲染 `unavailable` 提示；hooks 调用前置到所有早退之前 |
| P1 | 列表卡把整张表单渲进描述区（官方卡 summary 只返回一行字符串） | 加 `view === "summary"` 分支；根元素 `<li>` → `<div>` |
| P2 | 客户端仅为取一个 chevron 图标依赖 `@deepseek-ai/dsh-client-ui-primitives` | 改文字 `▾`，bundle 的 require 面收窄到 react |
| P2 | 禁用态报错指向 0.1.7 已不存在的「Settings → Plugin Config」入口 | 改插件页指引，并写明「表单即时生效 / patch 需重启」 |
| P2 | `pnpm test` 用 `node --test`，本机沙箱下 `spawn EPERM` 整批假死 | 逐文件 `node <file>`（语义等价，不 spawn 并发子进程） |

## 四、测试面（上轮 55+15 → 本轮 entry 14 + host 7 + cdp 21 + tavily 13 + frames 5 + client 19）

- `host-integration` 的真宿主对象从「假 settings provider」升级为**真 `SettingsForms` 服务**（真 cordis `Context` + `provide` 出的 loader/profileContext/configEditor），直接验命名空间可见性与 volatile 写入面；并补两条反证：未导出 Config、无 volatile 字段的入口必须被 `describe()` 排除（证明判据非恒真）。
- 六条反证逐条实跑变红（清单见适配说明第三节），每条留下报错原文。

## 五、本轮审计角度的诚实缺口

- 未做真机 E2E（未把插件装进 profile、未重启 dsh）——见适配说明第四节。
- 未联网验证 Tavily / CDP 真实端点。
- `tavilyApiKey` 是否升级为宿主 secret role，属行为变更，未在本轮决定。
## 六、环境侧收尾（2026-09-26，发哥执行 `pnpm install` 后复盘）

现象：安装成功，但装出来的是 `dsh-settings@0.1.5-rc.1` / `dsh-tools@0.1.5-rc.1`，
导致 host-integration 里读**真 `SettingsForms`** 的那条守护变红：

```
AssertionError: describe() 必须枚举到 web-fetch（否则插件页没有配置入口）: []
```

这也是本轮守护的价值证明——0.1.5 的 `dsh-settings` 里 `installSection` 尚在、没有 0.1.7 的
`volatileForm`/`describe` 语义，命名空间在真宿主上根本不可见（=「插件页没有配置项」那条 P1 的形态）。

根因（两次修正后落定）：**peerDependencies 被 `autoInstallPeers` 自动安装**，宽区间解析到了 0.1.5-rc.1。
首次归因写成「release-age 白名单没刷新」是**错的**：本机 `pnpm config list` 显示 `minimumReleaseAge` 并未设置，
该闸门当前不生效（已更正 `pnpm-workspace.yaml` 里的注释，保留更正痕迹）。

处置：

1. `package.json` 的 `devDependencies` 精确钉版 `@deepseek-ai/dsh-settings` / `dsh-tools` /
   `dsh-system-prompt` = 0.1.7-rc.1、schemastery = 3.18.4`（直接依赖优先于自动安装的 peer，避开区间解析）；
   `peerDependencies` 保留宽区间——运行时装进 profile 的宿主仍按自己的版本判定兼容。
2. `pnpm-workspace.yaml` 的 `allowBuilds` 占位字符串（pnpm 自动写入的
   `set this to true or false`）落定为 `false`，消除每次 install 的 `ERR_PNPM_IGNORED_BUILDS` 收尾；
   `minimumReleaseAgeExclude` 同步刷新到 0.1.7-rc.1 系（惯例动作，与本次根因无关）。

纪律沉淀：**「本地测试全绿」必须先确认测试树与被测版本一致**。本次红/绿的分界不是代码行，而是 `node_modules` 里
那个包的版本——同一份源码、同一套断言，装 0.1.5 就红、装 0.1.7 才绿。凡守护「宿主契约」的测试，
其被测依赖版本必须显式钉在 `devDependencies` 里，不能靠区间 + 全局策略去碰运气。

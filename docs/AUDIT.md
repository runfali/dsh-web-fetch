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
  1. **硬编码路径假设**：`DSH_HOME || ~/.dsh`，与 dsh-settings-file 的 `resolveDshHome` 一致 ✅，但 profile 形态（settings.yaml 在 profiles/<n>/ 下？）未验证——dsh-settings-file 默认 `<harness home>/settings.yaml`，profile 场景 settings 仍在该路径，✅。
  2. **正则解析 YAML 脆弱**：`tavilyApiKey:\s*([^\n#]+)` 会把注释行/多行值/引号值解析错；`text.includes('tavilyEnabled: true')` 会误匹配注释里的字样。
  3. **时序根因未消**：settings 经 `installSection` 同步接线，`onChange` 首发在 apply 时已同步——理论上前 800ms 等待是多余的（settings 一定已就绪）。此兜底疑似 rc 时代遗留。
- **修复建议**：确认 alpha.3 下 `current()` 必已指向 scope.get() 后，删除磁盘兜底分支，仅保留 settings 层判断；若确需保留，改用 dsh-settings 提供的能力（或至少用 yaml 库解析 + 路径经 resolveDshHome）。

### 🟠 P2-2 CDP 策略测试盲区：WebSocket 帧解析无真机/仿真覆盖

- **事实**：`tests/test-cdp-unit.mjs` 只测 helpers/策略工厂/Router 逻辑，**未覆盖 `CdpClient` 的帧编码/解码/分片重组/掩码**（`src/strategies/cdp.js:19-215` 核心）。
- **风险**：RFC6455 手工实现（mask、127 长帧、分片、ping/pong、UTF-8 边界）是最大正确性风险点，无测试兜底。
- **修复**：补一个本地 WS 回声服务器测试（node http upgrade + 手工帧）验证 encode/decode round-trip、分片、超时。

### 🟡 P3 杂项

| # | 问题 | 说明 |
|---|---|---|
| P3-1 | `router.js` 未被 src 引用（死代码？） | `index.js` 只注册两个独立工具，Router 仅在测试中被 import——README 未说明其「历史保留」地位，建议标注或删除 |
| P3-2 | `tavily` 策略 `maxResults` 参数声明但未从 args 读取 | 工具参数 `maxResults`（默认 5）声明了，`makeToolDef` execute 未把 `args.maxResults` 传给策略（策略内硬编码 5）——参数是**装饰性**的，LLM 传了也无效。P3→P2 边界 |
| P3-3 | `projectResult` 不保留 `publishedAt` | `source()` 支持 title/snippet/content/provider，web seam 的 `publishedAt` 字段未透出——web-fetch 是 fetch 非 search，可接受 |

## 四、行为模拟

- `withTimeout`：上游 abort / 超时 / cleanup 三路 ✅（helpers 单测覆盖）
- tavily：URL 与自然语言双模式、rawData/raw_content 新旧字段兼容、HTTP 403 错误透出、空结果报错 ✅（7 项单测覆盖）
- CDP 失败路径：createTarget 失败、找不到 page WS、正文空 → 均抛明确错误并清理 target ✅（代码走查）

## 五、处置

无 P0/P1。P2-1（磁盘兜底）建议在 alpha.3 下核实后清理；P2-2（WS 帧测试）补测试；P3 顺手。修复后开新一轮复核。

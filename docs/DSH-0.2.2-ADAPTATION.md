# dsh 0.2.2-rc.1 适配调研（本仓 0.2.2 适配轮）

日期：2026-11-06
对象：本机桌面端 `D:\DeepSeek Harness\`（`resources/app.asar/dsh/package.json` → `@deepseek-ai/dsh-desktop-runtime` **0.2.2-rc.1**）
本仓适配基线：dsh 0.2.1-rc.2

> 调研方式：0.2.2-rc.1 是二进制安装版，没有源码 diff 可读。本轮走
> 「解包 `resources/app.asar` → 读宿主真实源码 → 调用宿主真实判定函数」三步取证，结论均可复现。
> 解包树落在 `D:\DSH\_host-022rc1\<pkg>`，真闸脚本 `D:\DSH\_tools\gate-manifest-022.mjs`。

## 一、结论速览

| 面 | 结论 |
|---|---|
| 兼容区间 | **必须新增 0.2.2 clause**（唯一必改项）⚠️ |
| 闸判定顺序 | 顶层 `engines.dsh` 优先，否则逐条 peer（0.2.1 起）✅ 语义已订正 |
| 两工具注册面（`output.schema` + `render`） | 未变 ✅ |
| `settings.configure({auto:false})` 接线 | 未变 ✅ |
| volatile 活引用 | 未变 ✅ |
| 设置表单 `describe()` 的取值来源 | **变了**：`fiber.config` → `fiber.effectiveConfig`（只影响测试夹具）⚠️ |
| `src/` / `lib/client.js` | **零改动** ✅ |

## 二、为什么必须补 clause（以及为什么不是"加载被拒"）

用宿主自带的 `evaluatePluginCompatibility` 直接判**旧 manifest**：

```
evaluatePluginCompatibility(旧 manifest, {}, '0.2.2-rc.1')  → undefined   （PASS）
evaluatePluginCompatibility(旧 manifest, {}, '0.3.0')       → { requirements: ... }（REJECT，真负例）
```

即：0.2.2-rc.1 下插件**本来就能被加载**。拒绝它的是**严格模式**
（`semver.satisfies(rt, range)` 不带 `includePrerelease`，即 pnpm 安装期）：

```
semver.satisfies('0.2.2-rc.1', 旧五段区间)                                → false
semver.satisfies('0.2.2-rc.1', 旧五段区间, { includePrerelease: true })   → true
```

补 `|| >=0.2.2-alpha.0 <0.3.0` 后两列都为 true。四条串（3 个 peer + `dsh.engines.dsh`）逐字一致，
由 `tests/entry.test.mjs` 守护；删掉新段会让判定表立刻变红（变异测试已验证）。

## 三、闸的真实形状（0.2.2-rc.1）

- `dsh-app-boot/lib/index.js:1097-1116` `unmetRequirements()`：**顶层** `engines.dsh` 存在则它独自判定、
  peers 被忽略；否则逐条遍历 peer 里 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`。
- `:1094` `satisfies(runtimeVersion, range)` = `semver.satisfies(rt, range, { includePrerelease: true })`。
- `:1129` `evaluatePluginCompatibility(manifest, exemptions = {}, runtimeVersion = getDshRuntimeVersion())`，
  返回 `undefined` = PASS。
- `:1089` `getDshRuntimeVersion()` 读宿主自己的 package.json。

本仓区间写在**嵌套**的 `dsh.engines.dsh`（不是顶层 `engines`），所以闸看不到它，实际仍由 peers 判定。
**"闸只认 peer" 这句话因此在本仓成立，但理由是嵌套位置，不是闸不读 engines** —— 旧注释已订正。

## 四、契约面取证（逐条源码级核对，全部未漂移）

| 契约 | 0.2.2-rc.1 位置 | 结论 |
|---|---|---|
| `tools.register(definition, options = {})` | `dsh-tools/lib/index.js:433` | 未变；`:436` 仍强制 `output { schema, render }`，`:439` 校验 timeoutMs |
| `super(ctx, "tools")` | `dsh-tools/lib/index.js:417` | 未变 |
| `settings.configure(presentation, owner = this.ctx.fiber)` | `dsh-settings/lib/index.js:370` | 未变；`auto` 仍默认 `true`（`:426`） |
| 等待式注入 `inject(inject, callback)` | `cordis/lib/index.js:1672` | 未变 |
| `describe()` 行结构（`ns/schema/revision/applies/value/base/user`） | `dsh-settings/lib/index.js:441-451` | 未变 |
| client `configForms.whileServed` / `slots.inject` / `locale.register` | 见 0.2.1 文档同位置族 | 未变 |

## 五、本轮唯一真实漂移：`describe()` 读 `effectiveConfig`

`dsh-settings/lib/index.js:436`：

```js
const value = projectForm(form, plainConfig(entry.fiber.effectiveConfig));
```

0.2.1 时代这里读的是 `entry.fiber.config`。`effectiveConfig` 是 cordis 的 getter
（`cordis/lib/index.js:653`，背后是 `:360` `this._effectiveConfig = config`）。

**影响面只在测试夹具**：`tests/host-integration.test.mjs` 的假 fiber 原先只给了 `config`，
于是 `describe()` 返回 `value: undefined`，断言 `row.value 必须等于八个默认值` 直接红。

处置：假 fiber **同时给 `config` 与 `effectiveConfig` 两个键**，并注明"夹具同时满足新旧宿主，
不替宿主做选择"。这比只改成新键更好——旧宿主上测试同样成立。

## 六、schemastery

宿主自带 `@deepseek-ai/schemastery` **3.19.0**，`dsh-settings@0.2.2-rc.1` 的 peer 要求 `~3.19.0`。
若本仓 peer 仍是 `~3.18.4`：`pnpm peers check` 报 unmet，且 peer 自动安装会落 3.18.4 —— 测试跑在旧夹具上。

处置：peer → `~3.18.4 || ~3.19.0`，devDependencies 显式 pin `3.19.0`。升级后 `.volatile()` 契约仍成立。

## 七、验证

```
pnpm install                  → dsh/dsh-settings/dsh-tools/dsh-system-prompt 0.2.2-rc.1，schemastery 3.19.0
pnpm peers check              → No peer dependency issues found
node tests/entry.test.mjs     → 全部通过: 18 组（判定表 27 行 × 2 模式 × 4 个区间）
node tests/host-integration   → 全部通过: 7 组（跑在真 0.2.2-rc.1 包上）
node tests/test-cdp-unit.mjs  → passed: 21, failed: 0
node tests/test-tavily-unit.mjs → all tavily tests passed
node tests/test-cdp-frames.mjs  → tests 5 / pass 5 / fail 0 / skipped 0
node tests/client-smoke.mjs     → client smoke: 19 checks passed
====> 0 skipped / 0 failed

真闸（宿主自带函数）:
  0.2.2-rc.1 → PASS
  0.3.0      → REJECT {"requirements":{...}}   ← 真负例

变异测试:
  删掉四条区间串里的 " || >=0.2.2-alpha.0 <0.3.0"
  → AssertionError: 严格模式对 0.2.2-alpha.0 的判定应为 true（守护生效）
  恢复 → 18 组全绿
```

## 八、诚实缺口

- **没有做重启验收**。本插件虽在 desktop profile 的 bundles 里，但重启 DSH 属于红线动作，
  需发哥明确授权后单独执行。当前证据止于"宿主真闸 PASS + 真包契约测试全绿"。
- **没有在 profile 里跑真闸**。profile 里该插件是 link 指向本仓，manifest 即本仓 manifest，
  真闸结论可直接迁移；但未逐条扫码。
- 判定表覆盖到 0.2.2-rc.1 与 0.2.3，未覆盖 0.2.2 之后的预发布序列（无宿主可验，不猜）。

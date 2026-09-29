# dsh 0.2.0-rc.1 适配调研（本仓 0.2.0 适配轮）

日期：2026-09-29
对象：本机桌面端 `D:\DeepSeek Harness\`（`DeepSeek Harness.exe` `FileVersion 0.2.0-rc.1`）
本仓适配基线：dsh 0.1.7-rc.1

> 调研方式：0.2.0-rc.1 是二进制安装版，没有源码 diff 可读。本轮走
> 「解包 `resources/app.asar` → 调用宿主真实判定函数 → 真机闸实测」三步取证，结论均可复现。

## 一、结论速览

| 面 | 结论 |
|---|---|
| 兼容闸判定口径 | **未变**（仍只认 peerDependencies） ⚠️ |
| 兼容区间 | **必须新增 0.2.0 clause**（唯一必改项） ⚠️ |
| `settings` 的 `configure({auto:false})` 接线 | 未变 ✅ |
| 两工具注册面（`output.schema` + `render`） | 未变 ✅ |
| volatile 活引用（设置页保存即时生效） | 未变 ✅ |

## 二、失效证据（真机启动闸 stderr，修复前）

```
dsh: skipping profile bundle "dsh-web-fetch": Error: Plugin dsh-web-fetch@0.1.7-rc.1
is incompatible with dsh 0.2.0-rc.1: peerDependencies {"@deepseek-ai/dsh":">=0.1.2-alpha.3
<0.1.8 || ...", "@deepseek-ai/dsh-settings":..., "@deepseek-ai/dsh-tools":...}.
```

## 三、重要订正：`dsh.engines.dsh` 是死声明

全树 grep 确认 0.2.0-rc.1 里**没有任何 `dsh.engines` 的消费者**。判定函数
（`dsh-app-boot/lib/index.js:286-313` 的 `evaluatePluginCompatibility`）**只遍历
`peerDependencies` 里 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的条目**（`:294`），
判据是 `semver.satisfies(runtime, range, { includePrerelease: true })`（`:300`）。

→ **peer 决定插件生死；`engines` 只影响 pnpm 安装期。** 两者必须逐字一致。
本仓 3 个 dsh-* peer 与 `engines` 现已由测试守护逐字一致。

## 四、两种 semver 模式（本轮实测订正）

| | 规则 | 谁在用 |
|---|---|---|
| 严格模式（默认） | 纯比较器 **AND** 预发布可见性规则 | `pnpm install` |
| 宿主闸模式 | **纯比较器**，可见性规则被绕过 | `dsh-app-boot:300`（决定加载） |

预发布可见性 = 「预发布只被区间内含同 `[major,minor,patch]` 元组的预发布所满足」。
`includePrerelease: true` 绕过它，于是**上界自身的预发布也被放行**：

| 运行时 | 严格（pnpm） | 宿主闸（加载） |
|---|---|---|
| `0.1.8-rc.1` | ❌ | **✅** |
| `0.3.0-alpha.0` | ❌ | **✅** |
| `0.2.0`（正式版） | ✅ | ✅ |
| `0.3.0`（正式版） | ❌ | ❌ |

**推论**：上界 `<0.3.0` 拦的是 `0.3.0` **正式版**，**不拦** `0.3.0-*` 预发布。
若要连预发布一起拒，上界须写成 `<0.3.0-0`。本轮保持 `<0.3.0`（与家族其余插件一致）。

> 本仓的 `DECISION_TABLE` 建模的是**严格模式**，因此 `0.1.8-rc.1` / `0.1.9-alpha.1`
> 在此列为 `false`——这与宿主闸不同，是刻意的（两列语义已在测试注释里写明）。

## 五、改动清单

1. `package.json`：版本 `0.1.7-rc.1` → `0.2.0-rc.1`；`dsh.engines.dsh` 与 3 个 dsh-* peer
   各追加 `|| >=0.2.0-alpha.0 <0.3.0`；devDeps 4 个包从 `0.1.7-rc.1` 升到 `0.2.0-rc.1`。
2. `tests/entry.test.mjs`：
   - 判定表扩到 18 行，把原先「0.2.0 = false」翻转为覆盖（未验证→已验证，有意翻转）；
   - 新增旧三段区间的 0.2.0 反证；
   - 新增「3 个 peer 区间必须与 `dsh.engines.dsh` 逐字一致」断言；
   - semver 交叉验证的解析路径补上 pnpm 的 `.pnpm/semver@<ver>/` 落点。
3. `pnpm-workspace.yaml` / `README.md` / `README.zh-CN.md`：区间与白名单更新。

**未改**：`src/*`（CDP / Tavily 两条取数链、设置卡、注入逻辑）、`lib/client.js`、
`cordis.patch.yml` —— 运行期契约无漂移。

## 六、测试与验证

- `tests/entry.test.mjs`：**16 组通过**（判定表 18 行 × 4 个区间与真实 semver 交叉验证一致）。
- `tests/host-integration.test.mjs`：**7 组通过**——用**真实 dsh 0.2.0-rc.1 包**
  驱动 `ToolRuntime` 注册、端到端 execute、`SettingsForms.describe()`/`update()`
  与 volatile 写入面收敛，含「缺 Config / 无 volatile 字段被排除」的反证。
- `test-cdp-unit` 21 例、`test-tavily-unit` 全通过、`test-cdp-frames` 通过、
  `client-smoke` 19 项通过。
- 测试现运行在 **0.2.0-rc.1 真实开发依赖**下（devDeps 真升级）。
- 宿主真实判定函数：`evaluatePluginCompatibility(<本仓 manifest>, {}, '0.2.0-rc.1')` → `undefined`。

## 七、诚实缺口

1. **CDP / Tavily 两条取数链未做真实外网端到端**（需要目标浏览器与可用的 Tavily key）。
   单元与宿主集成测试覆盖了形状与降级路径，未覆盖真实远端响应。
2. 判定表中「上界预发布」的行为是推导 + 宿主真实 semver 实测得出，未安装历史宿主真机验证。

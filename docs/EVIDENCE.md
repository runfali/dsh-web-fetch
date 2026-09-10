# 适配证据 — dsh 0.1.5-rc.1

> 本文件是**内部**审计证据，不随 npm 包发布（不在 `package.json` 的 `files` 内）。
> 记录 2026-09-10 本轮适配的实测环境、契约对照、测试结果与反证记录。

## 环境

| 项 | 值 |
|---|---|
| dsh 宿主 | `/usr/lib/node_modules/@deepseek-ai/dsh` **0.1.5-rc.1** |
| Node.js | v24.19.0 |
| pnpm | 11.22.0 |
| 插件开发依赖 | `node_modules/@deepseek-ai/dsh-{settings,tools}` = **0.1.5-rc.1**（与宿主副本逐字节相同） |
| 代理 | `http://10.220.0.35:10808`（pnpm install 走它） |
| 线上 dsh 实例 | **未触碰**（本轮全部离线；未执行 `dsh plugin add`，未重启服务） |

## 契约对照（对宿主真实源码，不是 d.ts）

| 契约 | 判据命令 | 结果 |
|---|---|---|
| `settings.installSection` | `diff` 插件副本 vs 宿主 `dsh-settings/lib/index.js` | **整文件逐字节相同** |
| `defineTool` | `diff` 插件副本 vs 宿主 `dsh-tools/lib/index.js` | **整文件逐字节相同** |
| `ctx.tools.register` 校验分支 | 读宿主 `register()` | 强制 `output.{schema,render}`、拒 `run_code`；插件满足 |
| `installSection` 活引用 | 读 `hooks.setSource(() => scope.get())` | 与原实现一致 |
| web seam 歧义规则 | 读 `dsh-web/lib/index.js:130` | `WEB_PROVIDER_AMBIGUOUS` 仍存在，架构决定仍正确 |
| host 服务名 | 宿主 `super(ctx, "tools")` | 未变 |

## 测试结果（55 项 + client 15 项交互断言，全绿）

```
tests/entry.test.mjs             11 pass
tests/host-integration.test.mjs   5 pass
tests/test-cdp-frames.mjs         5 pass
tests/test-cdp-unit.mjs          21 pass
tests/test-tavily-unit.mjs       13 pass
tests/client-smoke.mjs           15 checks pass
```

## 反证记录（证明守护有牙齿）

| 反证动作 | 期望变红 | 实测 |
|---|---|---|
| `dsh.engines.dsh` 改回 `>=0.1.2-alpha.3 <0.2.0` | engines 判定表 / 反证 / 交叉验证 3 项 | ✅ 3 项全红 |
| client `FIELD_KEYS` 改一个键名 | 键集合一致性 | ✅ 红（"host schema and client form must agree"） |
| `() => current()` 改回传 `current`（快照） | entry 1 项 + host-integration 2 项 | ✅ 3 项全红 |
| 只读态 disabled 绑定写成恒 false | client smoke | ✅ 红（「只读态下所有控件必须禁用」） |
| 数字字段落盘改写成 String(n) | client smoke | ✅ 红（「数字字段必须以 number 落盘」） |
| 恢复全部改动 | 全绿 | ✅ 55 项 + client 15 项全绿 |

## 未覆盖的缺口（诚实记录）

- **真机 E2E 未跑**：CDP 需活浏览器、Tavily 需真实 Key。宿主的安装 → 挂载 → client 下发三段
  由发哥在真机验收。本插件**当前不在** web profile 的 `dsh.profile.bundles` 中，
  需要重新 `dsh plugin add` 才会挂载（profile 在 2026-09-10 的某次 reconcile 中被改写）。
- WebSocket 长连接未打真实服务器（只做帧层 round-trip）。

## 复现命令

```bash
cd <checkout>
export http_proxy=http://10.220.0.35:10808 https_proxy=http://10.220.0.35:10808
pnpm install          # 断言 node_modules 里的 dsh-* 版本 = 0.1.5-rc.1
pnpm test             # 55 项 + client 15 项，全绿
pnpm test:host        # 只跑真宿主契约测试
```


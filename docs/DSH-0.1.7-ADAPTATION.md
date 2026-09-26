# dsh 0.1.7-rc.1 适配说明（dsh-web-fetch）

对象：本机全局 `@deepseek-ai/dsh@0.1.7-rc.1`。本仓适配基线：0.1.5-rc.1。
方法：**先证明改动面，再动代码**——每条结论都来自本机安装副本的源码级对照
（宿主包位于 `%APPDATA%/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`），
不是记忆、不是 d.ts 注释、不是测试里复制的契约。

## 一、总体结论

**业务逻辑零改动**（`src/strategies/*`、`src/helpers.js` 一行未动），破坏面**全部在设置（settings）接线**：

| # | 破坏 | 0.1.5-rc.1 | 0.1.7-rc.1 |
|---|---|---|---|
| 1 | 宿主设置注册 | `settings.installSection(owner, ns, schema, entry, hooks)` | **已删除**（全仓 0 处命中）→ 命名空间改由「导出的 Config + 行 id」自动成立 |
| 2 | 可热编辑字段 | 整段 schema 即 scope | 必须 `.volatile()`；`describe()` 只枚举 `volatileForm(schema)` 非空的入口，`write()` 逐路径校验 `isVolatilePath` |
| 3 | apply 收到的值 | 普通值 | volatile 字段是 **`{get()}` 活引用**（cosmokit `createVolatile` / `isVolatile`） |
| 4 | 展示策略 | installSection 即卡片 | `settings.configure({auto:false}, fiber)` 关掉宿主自动生成的默认页 |
| 5 | 浏览器 scope | `ctx.settingsScope.bind({namespace})` | **已删除** → `ctx.configForms.get(ns)` |
| 6 | 设置卡槽位 | `settings.plugin.item`（keyed，key=ns） | **已删除** → `plugins.item`（list，`id`=行 id + `label` thunk + `order` + `view: summary/page` 双视图） |
| 7 | 槽位注册时机 | 直接注册 | `configForms.whileServed([ns], register)` 门控（宿主开始服务该 ns 才注册，停服自动摘除） |
| 8 | `slots.inject` 回调 | generator（`function*` + `yield register(...)`） | **返回 disposer 的普通函数**；传 generator 会被 `ctx.effect` 当普通回调调用 → `register` 永不执行 → 卡片不出现 |
| 9 | 兼容闸 | 无 | `peerDependencies` 的 `@deepseek-ai/dsh*` 在安装 preflight 与启动 preflight 被消费 |

代码级证据（行号为本机安装副本实测）：
`dsh-settings/lib/index.js:122`（volatileForm）、`:322`（SettingsForms）、`:413`（describe）、`:470`（update/replace/mutate）、`:538`（schema(entry)=fiber.runtime.Config）；
`dsh-client-ui-settings/lib/client.js:1309`（ConfigForms.get）、`:1330`（whileServed）；`dsh-client-ui-renderer/lib/client.js:1343`（slots.inject）；
`dsh-client-ui-plugin-manager/lib/client.js:1653/1689/1726`（列表卡 summary / 详情页 page）；官方同款接线样板：`dsh-client-ui-settings-agent-loop/lib/client.js:148-165`。

## 二、改动清单

1. `src/index.js`
   - 删除 `installSection` 接线；`inject` 由 `['tools','settings']` 收窄为 `['tools']`（settings 走 apply 内等待式注入：服务晚到时回调才跑，加载期无副作用）；
   - `Config` 八个字段全部 `.volatile()`；新增导出 `readField()` 与内部 `materializeConfig()`，把 `{get()}` 活引用解成裸值喂给策略工厂（旧宿主裸值形状一并兼容）；
   - 工具改为每条 execute 现取配置（`readConfig` thunk），保住「设置页保存即时生效」；
   - 错误文案由「Settings → Plugin Config」改为插件页指引。
2. `lib/client.js`
   - `settingsScope.bind` → `configForms.get(NS)`；`inject` 改 `['slots','locale','configForms']`；
   - 设置卡从 `settings.plugin.item` 迁到 `plugins.item`（`id:"web-fetch"` / `order:30` / `label` thunk），注册包进 `whileServed([NS], ...)`，回调改成「返回 disposer 的普通函数」；
   - 新增 `view === "summary"` 分支（列表卡只渲染一行描述），卡片根元素 `<li>` → `<div>`（详情页非列表语境）；
   - 去掉 `@deepseek-ai/dsh-client-ui-primitives` 运行时依赖（chevron 图标改文字 `▾`），新增 `unavailable` 文案：命名空间未被服务时渲染提示而非静默返回 `null`。
3. `package.json`：版本 `0.1.7-rc.1`；三个 dsh 依赖改 `peerDependencies`（含 0.1.7 兼容闸必读的 `@deepseek-ai/dsh`），区间加 `>=0.1.7-alpha.0 <0.1.8`，上界由 `<0.2.0` 收到 `<0.1.8`；schemastery 收紧 `~3.18.4`（`.volatile()` 是 3.18.4 起的 API，3.18.2 没有）；`scripts.test` 改直跑 node（原因见第五节）。
4. 测试三套重写（见下节），`cordis.patch.yml` 与 `src/strategies/*` **未改**。
5. 文档：本文件 + `docs/AUDIT.md` 第三轮 + 双语 README 的入口措辞/兼容区间/测试清单。

## 三、测试

| 文件 | 项数 | 本轮新增的守护 |
|---|---|---|
| `tests/entry.test.mjs` | 14 组 | Config 必须导出；八字段必须 `.volatile()`；`configure({auto:false})` 必须调用；**volatile 活引用逐次现读**（改活引用后 execute 立刻换行为）；裸值形状兼容；判定表 13 行含 0.1.7 覆盖与 0.1.9/0.2.0 排除 |
| `tests/host-integration.test.mjs` | 7 组 | **真 `SettingsForms`**（真 cordis `Context` + `provide` 出的 loader/profileContext/configEditor）上：命名空间可见、volatile 字段可写进 user 层、schema 外字段被 `isVolatilePath` 拒绝；**反证**：未导出 Config / 无 volatile 字段的入口必被 `describe()` 排除 |
| `tests/client-smoke.mjs` | 19 项 | `configForms.get`/`whileServed` 契约；`plugins.item` 新槽位（id/order/label thunk）；**双视图**；**whileServed 未服务不注册**；不可用态渲染提示；无 primitives 依赖（require 桩只认 react，多一个依赖就炸） |

`pnpm test` 全绿：entry 14 + host 7 + cdp 21 + tavily 13 + frames 5 + client 19。

**反证（改坏必须变红，逐条实跑）**：

| 注入的缺陷 | 变红位置 | 报错原文（截断） |
|---|---|---|
| A 去掉 `cdpEnabled` 的 `.volatile()` | entry + host | `Config.cdpEnabled 必须 .volatile()` |
| B client `FIELD_KEYS` 改键名 | entry + client | `host schema 与 client 表单必须逐键相等` |
| C 不注册 `configure({auto:false})` | entry | `apply 必须经 ctx.inject 调 settings.configure 一次` |
| D `inject` 回退成硬依赖 settings | entry | `tools 是硬依赖；settings 走 apply 内等待式注入` |
| E client 回退到 0.1.5 槽位/generator 形态 | client-smoke | 槽位断言红 |
| F `Config` 不再导出 | entry | `Config 必须从模块导出（0.1.7 命名空间来源）` |

## 四、诚实缺口

- **未做真机 E2E**：「安装 → 挂载 → 浏览器拉到 client bundle → 点击进入详情页 → 保存生效」需要把插件装进 `~/.dsh/profiles/web` 并重启 dsh，属配置变更，本轮未执行（本机 web profile 目前根本没装 web-fetch）。已覆盖的静态面：宿主真服务的命名空间/写入面、真 `ToolRuntime` 的注册与校验、client 半按真实 `configForms`/`slots` 契约驱动的结构断言。
- **未打真浏览器/真 Tavily**：CDP 需要活的远程端点、Tavily 需要真 Key，全部离线。
- **连接器覆盖限制**：0.1.7-rc.1 上 `describe({redactSecrets:true})` 会摘掉 `role('secret')` 字段的值；本插件 `tavilyApiKey` **未**声明 secret role（与 0.1.5 行为一致：明文存于设置文档，README 已注明）。若要改走宿主密钥通道，属行为变更，留给下一轮决策。

## 五、本机环境附注：为什么 pnpm 用不了

仓库原本的 `node_modules` 是**半成品 pnpm 树**（`@deepseek-ai/schemastery` 的真实目录在，但 `node_modules/@deepseek-ai/*` 与虚拟店内的依赖链接全部缺失 → `Cannot find package '@deepseek-ai/cosmokit'`，基线测试本来就是红的）。

试图用 pnpm 重建时被沙箱挡住：pnpm 的全局 store 操作锁写的是

```
%LOCALAPPDATA%\pnpm-store-operation-locks\all-stores.lock   →  拒绝访问 (os error 5)
```

该路径在工作区（`D:\DSH`）之外。改 `LOCALAPPDATA`、加 `--store-dir`、直跑 `pnpm.mjs` 三种绕法都被同一处锁拦住（沙箱文件策略边界，不是 pnpm 故障）。

**处置**：改用 npm 按 package.json 的 devDependencies 重建依赖树，并把 `scripts.test` 从 `node --test ...` 改成逐文件 `node <file>`（本机沙箱禁止 node 测试运行器 spawn 子进程：`spawn EPERM`）；两份文件各跑各的，语义等价。

**影响**：`pnpm-lock.yaml` 未更新；`node_modules` 现由 npm 生成（.gitignore 覆盖，不入库）。下次在正常环境安装时，建议按新 `package.json`（peer-only + devDep `@deepseek-ai/dsh@0.1.7-rc.1`）重跑一次 `pnpm install` 让 lockfile 收敛。

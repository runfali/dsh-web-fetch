window.__ModuleLoader__.load({
  id: "dsh-web-fetch",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");
    let jsxRuntime = require("react/jsx-runtime");
    let jsx = jsxRuntime.jsx;
    let jsxs = jsxRuntime.jsxs;
    let useState = react.useState;
    let useSyncExternalStore = react.useSyncExternalStore;

    function createStore(init) {
      let state = init; const listeners = new Set();
      return { getSnapshot(){return state}, subscribe(fn){listeners.add(fn);return ()=>{listeners.delete(fn)}}, set(next){state=next;listeners.forEach(fn=>fn())} }
    }
    function useStore(store, selector){ return useSyncExternalStore(store.subscribe, ()=>selector(store.getSnapshot())) }

    function boolField(f){ return { field:f, format:(v)=>v===true?"true":"", parse:(t)=>{ const s=t.trim(); if(s==="true") return {kind:"set",value:true}; if(s==="") return {kind:"set",value:false}; return undefined } } }
    function textField(f){ return { field:f, format:(v)=>typeof v==="string"?v:"", parse:(t)=>{ const s=t.trim(); return s===""?{kind:"clear"}:{kind:"set",value:s} } } }
    function numberField(f){ return { field:f, format:(v)=>typeof v==="number"?String(v):"", parse:(t)=>{ const s=t.trim(); if(s==="") return {kind:"clear"}; const n=Number(s); return Number.isFinite(n)?{kind:"set",value:n}:undefined } } }
    function selectField(f, opts){ return { field:f, options:opts, format:(v)=>typeof v==="string"?v:"", parse:(t)=>{ const s=t.trim(); return opts.indexOf(s)>=0?{kind:"set",value:s}:undefined } } }

    function CardForm(scope, specs){
      this.scope=scope; this.specs=new Map(); specs.forEach((s)=>this.specs.set(s.field,s))
      this.staged=new Map(); this.listeners=new Set(); this.saving=false; this.failed=false
      const self=this; this._unsubscribe=scope.subscribe(()=>self.publish())
    }
    CardForm.prototype.bind=function(project){const self=this;const store=createStore(project());this.listeners.add(()=>store.set(project()));return store}
    CardForm.prototype.shell=function(){const snap=this.scope.getSnapshot();const plan=this.plan();return{available:snap.status==="ready",writable:snap.writable===true,dirty:plan.length>0,invalid:plan.some((i)=>i.run===undefined),saving:this.saving,failed:this.failed}}
    CardForm.prototype.field=function(field){const staged=this.staged.get(field);const spec=this.spec(field);if(staged===undefined) return{text:spec.format(this.sectionValue(field)),overridden:this.stored(field),invalid:false};const write=staged.clear?{kind:"clear"}:spec.parse(staged.text);return{text:staged.text,overridden:write!==undefined&&write.kind==="set",invalid:write===undefined}}
    CardForm.prototype.actions=function(){const self=this;return{edit:(f,t)=>self.stage(f,{text:t,clear:false}),resetField:(f)=>self.stage(f,{text:self.spec(f).format(self.baseValue(f)),clear:true}),save:()=>self.save(),discard:()=>{if(self.staged.size===0&&!self.failed) return;self.staged.clear();self.failed=false;self.publish()}}}
    CardForm.prototype.save=async function(){const plan=this.plan();const writes=[];plan.forEach((i)=>{if(i.run!==undefined) writes.push(i.run)});if(plan.length===0||this.saving||writes.length!==plan.length) return;this.saving=true;this.failed=false;this.publish();let ok=true;for(let i=0;i<writes.length;i++){if(!await writes[i]()) ok=false};if(ok) this.staged.clear();this.saving=false;this.failed=!ok;this.publish()}
    CardForm.prototype.plan=function(){const self=this;const plan=[];this.staged.forEach((staged,field)=>{const spec=self.spec(field);if(staged.clear){if(self.stored(field)) plan.push({field,run:()=>self.clear(field)});return};if(staged.text===spec.format(self.sectionValue(field))) return;const write=spec.parse(staged.text);if(write===undefined) plan.push({field,run:undefined});else if(write.kind==="clear") plan.push({field,run:()=>self.clear(field)});else plan.push({field,run:()=>self.store(field,write.value)})});return plan}
    CardForm.prototype.clear=async function(field){await this.scope.unset(field);return !this.stored(field)}
    CardForm.prototype.store=async function(field,value){await this.scope.set(field,value);const u=this.userLayer();return u!==undefined?u[field]===value:false}
    CardForm.prototype.stage=function(field,edit){this.staged.set(field,edit);this.failed=false;this.publish()}
    CardForm.prototype.spec=function(field){const s=this.specs.get(field);if(s===undefined) throw new Error("no such field: "+field);return s}
    CardForm.prototype.sectionValue=function(f){const v=this.snapshotOf().value;return v===undefined?undefined:v[f]}
    CardForm.prototype.baseValue=function(f){const b=this.snapshotOf().base;return b===undefined?undefined:b[f]}
    CardForm.prototype.userLayer=function(){return this.snapshotOf().user}
    CardForm.prototype.stored=function(f){const u=this.userLayer();return u!==undefined&&Object.prototype.hasOwnProperty.call(u,f)}
    CardForm.prototype.publish=function(){this.listeners.forEach(fn=>fn())}
    CardForm.prototype.snapshotOf=function(){return this.scope.getSnapshot()}

    const FIELD_KEYS=["cdpEnabled","cdpEndpoint","cdpTimeoutMs","cdpWaitMs","tavilyEnabled","tavilyEndpoint","tavilyApiKey","tavilyTimeoutMs"]
    function WebFetchController(scope){const self=this;this.form=new CardForm(scope,[boolField("cdpEnabled"),textField("cdpEndpoint"),numberField("cdpTimeoutMs"),numberField("cdpWaitMs"),boolField("tavilyEnabled"),textField("tavilyEndpoint"),textField("tavilyApiKey"),numberField("tavilyTimeoutMs"),]);this.store=this.form.bind(()=>self.projection())}
    WebFetchController.prototype.projection=function(){const shell=this.form.shell();const r={};Object.keys(shell).forEach(k=>r[k]=shell[k]);FIELD_KEYS.forEach(k=>r[k]=this.form.field(k));return r}
    WebFetchController.prototype.inject=function(){const a=this.form.actions();const r={hooks:{webFetch:this.store}};Object.keys(a).forEach(k=>r[k]=a[k]);return r}

    let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const css$2 = ".WF_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}.WF_field+.WF_field{border-top:1px solid var(--dsw-alias-border-l2)}.WF_head{align-items:center;gap:8px;display:flex}.WF_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}.WF_badges{align-items:center;gap:8px;display:inline-flex}.WF_badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}.WF_reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}.WF_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}.WF_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}.WF_input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.WF_input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}.WF_inputInvalid{border-color:var(--dsw-alias-label-error)}.WF_invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}.WF_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}.WF_select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font:inherit;height:34px;font-size:13px}.WF_select:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.WF_group{margin:0;padding:12px 16px 0;border-top:1px solid var(--dsw-alias-border-l2)}.WF_group:last-child{padding-bottom:8px}.WF_groupTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;margin:8px 0 4px}";
    const tagId$2 = "dsh-web-fetch/fields.module.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css="+JSON.stringify(tagId$2)+"]") === null) { const tag=document.createElement("style");tag.dataset.plugin="dsh-web-fetch";tag.dataset.pluginCss=tagId$2;tag.textContent=css$2;document.head.appendChild(tag) }
    var fields_css = {"field":"WF_field","head":"WF_head","label":"WF_label","badges":"WF_badges","badge":"WF_badge","reset":"WF_reset","input":"WF_input","inputInvalid":"WF_inputInvalid","invalid":"WF_invalid","hint":"WF_hint","select":"WF_select","group":"WF_group","groupTitle":"WF_groupTitle"}

    const css$1 = ".WF_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}.WF_card:hover{border-color:var(--dsw-alias-label-dimmed)}.WF_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}.WF_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}.WF_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}.WF_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}.WF_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}.WF_desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}.WF_chev{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}.WF_chevOpen{transform:rotate(180deg)}.WF_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}.WF_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}.WF_pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}.WF_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}.WF_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}.WF_discard,.WF_save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}.WF_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}.WF_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}.WF_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}.WF_discard:disabled,.WF_save:disabled{opacity:.4;cursor:default}.WF_discard:focus-visible,.WF_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}";
    const tagId$1 = "dsh-web-fetch/PluginCard.module.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css="+JSON.stringify(tagId$1)+"]") === null) { const tag=document.createElement("style");tag.dataset.plugin="dsh-web-fetch";tag.dataset.pluginCss=tagId$1;tag.textContent=css$1;document.head.appendChild(tag) }
    var card_css = {"card":"WF_card","cardOpen":"WF_cardOpen","header":"WF_header","headText":"WF_headText","name":"WF_name","desc":"WF_desc","chev":"WF_chev","chevOpen":"WF_chevOpen","body":"WF_body","readOnly":"WF_readOnly","pending":"WF_pending","footer":"WF_footer","failed":"WF_failed","discard":"WF_discard","save":"WF_save"}

    function r(e){var t,f,n="";if(typeof e==="string"||typeof e==="number") n+=e;else if(typeof e==="object") if(Array.isArray(e)){var o=e.length;for(t=0;t<o;t++) e[t]&&(f=r(e[t]))&&(n&&(n+=" "),n+=f)} else for(f in e) e[f]&&(n&&(n+=" "),n+=f);return n}
    function clsx(){for(var e,t,f=0,n="",o=arguments.length;f<o;f++) (e=arguments[f])&&(t=r(e))&&(n&&(n+=" "),n+=t);return n}

    function ValueField(props){
      const el = props.isSelect === true ?
        jsx("select", { id: props.id, className: props.invalid ? fields_css.inputInvalid : fields_css.select, value: props.text, disabled: props.disabled, onChange:(e)=>props.onEdit(e.target.value) })
        :
        jsx("input", { id: props.id, className: props.invalid ? fields_css.inputInvalid : fields_css.input, type:"text", value: props.text, placeholder: props.placeholder||"", disabled: props.disabled, inputMode: props.numeric===true?"numeric":undefined, onChange:(e)=>props.onEdit(e.target.value) })
      return jsxs("div", { className: fields_css.field, children: [
        jsxs("div", { className: fields_css.head, children: [
          jsx("label", { className: fields_css.label, htmlFor: props.id, children: props.label }),
          props.overridden ? jsxs("span", { className: fields_css.badges, children: [
            jsx("span", { className: fields_css.badge, children: props.overriddenLabel }),
            jsx("button", { type:"button", className: fields_css.reset, disabled: props.disabled, onClick: props.onReset, children: props.resetLabel })
          ] }) : null
        ] }),
        el,
        jsx("p", { className: props.invalid ? fields_css.invalid : fields_css.hint, children: props.invalid ? props.invalidLabel : props.hint })
      ] })
    }

    function ToggleField(props){
      return jsxs("div", { className: fields_css.field, children: [
        jsxs("div", { className: fields_css.head, children: [
          jsx("label", { className: fields_css.label, htmlFor: props.id, children: props.label }),
          jsx("span", { className: fields_css.badge, children: props.checked ? props.onLabel : props.offLabel })
        ] }),
        jsx("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: props.disabled ? "default" : "pointer", color: props.disabled ? "var(--dsw-alias-label-tertiary)" : undefined }, children: [
          jsx("input", { type:"checkbox", id: props.id, checked: props.checked, disabled: props.disabled, onChange:(e)=>props.onChange(e.target.checked) }),
          jsx("span", { style: { fontSize: 13, lineHeight: 1.5 }, children: props.checked ? props.onLabel : props.offLabel })
        ] }),
        jsx("p", { className: fields_css.hint, children: props.hint })
      ] })
    }

    function PluginCard(props){
      const pair = useState(false); const open = pair[0]; const setOpen = pair[1]
      const state = props.state
      if (!state.available) return null
      const title = props.t(props.titleKey)
      const blocked = !state.dirty || state.invalid || state.saving
      return jsxs("li", { className: clsx(card_css.card, open && card_css.cardOpen), children: [
        jsxs("button", { type:"button", className: card_css.header, "aria-expanded": open, "aria-label": props.t(open?"collapse":"expand")+": "+title, onClick:()=>setOpen(!open), children: [
          jsxs("span", { className: card_css.headText, children: [ jsx("span",{className:card_css.name,children:title}), jsx("span",{className:card_css.desc,children:props.t(props.descriptionKey)}) ] }),
          state.dirty ? jsx("span", { className: card_css.pending, children: props.t("unsaved") }) : null,
          jsx(primitives.IconChevronDownOutline14, { className: clsx(card_css.chev, open && card_css.chevOpen) })
        ] }),
        open ? jsxs("div", { className: card_css.body, children: [
          !state.writable ? jsx("p", { className: card_css.readOnly, role:"status", children: props.t("readOnly") }) : null,
          props.children,
          jsxs("div", { className: card_css.footer, children: [
            state.failed ? jsx("p", { className: card_css.failed, role:"status", children: props.t("saveFailed") }) : null,
            jsx("button", { type:"button", className: card_css.discard, disabled: !state.dirty || state.saving, onClick: props.onDiscard, children: props.t("discard") }),
            jsx("button", { type:"button", className: card_css.save, disabled: blocked, onClick: props.onSave, children: props.t(state.saving ? "saving" : "save") })
          ] })
        ] }) : null
      ] })
    }

    const FIELD_VIEWS = [
      { key:"cdpEndpoint", labelKey:"field.cdpEndpoint", hintKey:"hint.cdpEndpoint", section:"cdp" },
      { key:"cdpTimeoutMs", labelKey:"field.cdpTimeoutMs", hintKey:"hint.cdpTimeoutMs", section:"cdp", numeric:true },
      { key:"cdpWaitMs", labelKey:"field.cdpWaitMs", hintKey:"hint.cdpWaitMs", section:"cdp", numeric:true },
      { key:"tavilyEndpoint", labelKey:"field.tavilyEndpoint", hintKey:"hint.tavilyEndpoint", section:"tavily" },
      { key:"tavilyApiKey", labelKey:"field.tavilyApiKey", hintKey:"hint.tavilyApiKey", section:"tavily" },
      { key:"tavilyTimeoutMs", labelKey:"field.tavilyTimeoutMs", hintKey:"hint.tavilyTimeoutMs", section:"tavily", numeric:true },
    ]
    function WebFetchCard(props){
      const state = props.useWebFetch((s)=>s); const t = props.t
      if (!state.available) return null
      const disabled = !state.writable
      const onToggle = (field, checked) => props.edit(field, checked ? "true" : "")
      return jsx(PluginCard, { t, titleKey:"card.title", descriptionKey:"card.description", state, onSave:props.save, onDiscard:props.discard, children: [
        jsx("div", { className: fields_css.groupTitle, children: t("group.overview") }),
        jsx(ToggleField, { id:"wf-cdp-enabled", label:t("field.cdpEnabled"), hint:t("hint.cdpEnabled"), checked:state.cdpEnabled.text==="true", onLabel:t("dataSrc.cdp.on"), offLabel:t("dataSrc.cdp.off"), disabled, onChange:(c)=>onToggle("cdpEnabled",c) }),
        jsx(ToggleField, { id:"wf-tavily-enabled", label:t("field.tavilyEnabled"), hint:t("hint.tavilyEnabled"), checked:state.tavilyEnabled.text==="true", onLabel:t("dataSrc.tavily.on"), offLabel:t("dataSrc.tavily.off"), disabled, onChange:(c)=>onToggle("tavilyEnabled",c) }),
        jsx("div", { className: fields_css.group, children: [
          jsx("div", { className: fields_css.groupTitle, children: t("group.cdp") }),
          FIELD_VIEWS.filter(v=>v.section==="cdp").map((view)=>{ const f=state[view.key]; return jsx(ValueField, { key:view.key, id:"wf-"+view.key, label:t(view.labelKey), hint:t(view.hintKey), overriddenLabel:t("overridden"), resetLabel:t("reset"), invalidLabel:t("invalid"), numeric:view.numeric===true, isSelect:view.isSelect===true, disabled, ...f, onEdit:(text)=>props.edit(view.key,text), onReset:()=>props.resetField(view.key) }) })
        ] }),
        jsx("div", { className: fields_css.group, children: [
          jsx("div", { className: fields_css.groupTitle, children: t("group.tavily") }),
          FIELD_VIEWS.filter(v=>v.section==="tavily").map((view)=>{ const f=state[view.key]; return jsx(ValueField, { key:view.key, id:"wf-"+view.key, label:t(view.labelKey), hint:t(view.hintKey), overriddenLabel:t("overridden"), resetLabel:t("reset"), invalidLabel:t("invalid"), numeric:view.numeric===true, isSelect:view.isSelect===true, disabled, ...f, onEdit:(text)=>props.edit(view.key,text), onReset:()=>props.resetField(view.key) }) })
        ] }),
      ] })
    }

    const NS = "web-fetch"
    const zh = {
      "card.title":"通用 Web 内容获取（web-fetch）",
      "card.description":"双数据源策略：CDP 浏览器抓取 + Tavily 抓取，按需启用，由 LLM 自主决策调用哪个工具。",
      "unsaved":"未保存", "expand":"展开", "collapse":"收起",
      "save":"保存", "saving":"保存中…", "discard":"放弃",
      "saveFailed":"保存未生效，请检查填写内容",
      "readOnly":"该设置为只读（当前连接不可写）",
      "overridden":"已覆盖", "reset":"重置", "invalid":"请输入有效值",
      "group.overview":"数据源启用开关",
      "group.cdp":"CDP 浏览器",
      "group.tavily":"Tavily",
      "field.cdpEnabled":"启用 CDP 浏览器",
      "hint.cdpEnabled":"开启后，通过 CDP 端点连接远程浏览器抓取页面内容",
      "field.cdpEndpoint":"CDP 端点 URL",
      "hint.cdpEndpoint":"Chrome DevTools Protocol HTTP 端点，默认 10.200.0.5:9222",
      "field.cdpTimeoutMs":"CDP 超时（毫秒）",
      "hint.cdpTimeoutMs":"页面导航超时，默认 60000",
      "field.cdpWaitMs":"页面加载额外等待（毫秒）",
      "hint.cdpWaitMs":"Page.loadEventFired 后再等待的毫秒数，默认 2000",
      "field.tavilyEnabled":"启用 Tavily",
      "hint.tavilyEnabled":"开启后通过 Tavily Extract API 抓取页面内容（需要 API Key）",
      "field.tavilyEndpoint":"Tavily API 端点",
      "hint.tavilyEndpoint":"Tavily Extract API URL",
      "field.tavilyApiKey":"Tavily API Key",
      "hint.tavilyApiKey":"从 https://app.tavily.com 获取；留空则禁用 Tavily",
      "field.tavilyTimeoutMs":"Tavily 超时（毫秒）",
      "hint.tavilyTimeoutMs":"请求超时，默认 30000",
      "dataSrc.cdp.title":"CDP 浏览器",
      "dataSrc.cdp.desc":"远程浏览器（cloakbrowser）抓取",
      "dataSrc.cdp.on":"已启用", "dataSrc.cdp.off":"未启用",
      "dataSrc.tavily.title":"Tavily",
      "dataSrc.tavily.desc":"Tavily Extract API 抓取",
      "dataSrc.tavily.on":"已启用", "dataSrc.tavily.off":"未启用"
    }
    const en = {
      "card.title":"Web Fetch (web-fetch)",
      "card.description":"Dual data sources: CDP browser + Tavily. Each is a standalone tool the LLM picks context-appropriately.",
      "unsaved":"Unsaved", "expand":"Expand", "collapse":"Collapse",
      "save":"Save", "saving":"Saving…", "discard":"Discard",
      "saveFailed":"Save did not land; check your input",
      "readOnly":"Read-only (not writable over the current connection)",
      "overridden":"Overridden", "reset":"Reset", "invalid":"Enter a valid value",
      "group.overview":"Enable data sources",
      "group.cdp":"CDP Browser",
      "group.tavily":"Tavily",
      "field.cdpEnabled":"Enable CDP browser",
      "hint.cdpEnabled":"Connect to a remote browser via the CDP endpoint to scrape rendered pages",
      "field.cdpEndpoint":"CDP endpoint URL",
      "hint.cdpEndpoint":"Chrome DevTools Protocol HTTP endpoint, default 10.200.0.5:9222",
      "field.cdpTimeoutMs":"CDP timeout (ms)",
      "hint.cdpTimeoutMs":"Page-navigation timeout, default 60000",
      "field.cdpWaitMs":"Extra wait after load (ms)",
      "hint.cdpWaitMs":"Milliseconds to wait after Page.loadEventFired, default 2000",
      "field.tavilyEnabled":"Enable Tavily",
      "hint.tavilyEnabled":"Use Tavily Extract API (requires an API key)",
      "field.tavilyEndpoint":"Tavily API endpoint",
      "hint.tavilyEndpoint":"Tavily Extract API URL",
      "field.tavilyApiKey":"Tavily API Key",
      "hint.tavilyApiKey":"Get one from https://app.tavily.com; leave blank to disable Tavily",
      "field.tavilyTimeoutMs":"Tavily timeout (ms)",
      "hint.tavilyTimeoutMs":"Per-request timeout, default 30000",
      "dataSrc.cdp.title":"CDP Browser",
      "dataSrc.cdp.desc":"Remote browser (cloakbrowser) scrape",
      "dataSrc.cdp.on":"Enabled", "dataSrc.cdp.off":"Disabled",
      "dataSrc.tavily.title":"Tavily",
      "dataSrc.tavily.desc":"Tavily Extract API scrape",
      "dataSrc.tavily.on":"Enabled", "dataSrc.tavily.off":"Disabled"
    }

    const inject = ["slots","locale","settingsScope","connection","remote"]
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "web-fetch: dictionaries")
      const scope = ctx.settingsScope.bind({ namespace: NS })
      const controller = new WebFetchController(scope)
      ctx.slots.inject("settings.plugin.item", function* () {
        yield ctx.slots.register({ name:"settings.plugin.item", key: NS, locale: NS, inject: () => controller.inject() }, WebFetchCard)
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
});

//# sourceMappingURL=client.js.map

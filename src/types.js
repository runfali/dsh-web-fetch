/**
 * dsh-web-fetch — 共享类型定义。
 *
 * 所有策略实现（Strategy）以 FetchStrategy 为契约；核心路由、
 * 入口 apply() 均通过类型边界调用，不直接依赖具体策略实现。
 */

/**
 * 一次内容获取请求。
 * @typedef {Object} FetchRequest
 * @property {string} query - URL（CDP 模式）或自然语言问题（Tavily 模式）。
 * @property {string} [provider] - 调用方显式要求的 provider id，例如 'cdp' / 'tavily'。
 * @property {object} [metadata] - 可选元信息（保留给未来扩展）。
 */

/**
 * 返回给 ctx.web 的单个搜索结果条目。
 * @typedef {Object} WebSource
 * @property {string} url
 * @property {string} [title]
 * @property {string} [snippet]
 * @property {string} [content]
 * @property {string} [provider]
 */

/** @typedef {{ sources: WebSource[], truncated: boolean }} FetchResult */

/**
 * 策略实现必须遵守的接口。
 * @typedef {Object} FetchStrategy
 * @property {string} id
 * @property {string} title
 * @property {function(): boolean} available
 * @property {function(FetchRequest, AbortSignal): Promise<FetchResult>} fetch
 */

export {}

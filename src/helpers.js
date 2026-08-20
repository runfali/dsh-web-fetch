/**
 * dsh-web-fetch — 通用辅助函数。
 */

/** 合并调用方取消信号与本地超时，返回 signal + cleanup。 */
export function withTimeout(signal, timeoutMs) {
  const controller = new AbortController()
  const onAbort = () => {
    const reason = signal && signal.reason !== undefined ? signal.reason : new Error("aborted")
    controller.abort(reason)
  }
  if (signal && signal.aborted === true) { onAbort() }
  else { signal && signal.addEventListener("abort", onAbort, { once: true }) }
  const timer = setTimeout(
    () => controller.abort(new Error("request timed out after " + timeoutMs + " ms")),
    timeoutMs
  )
  timer.unref && timer.unref()
  return {
    signal: controller.signal,
    cleanup: () => { clearTimeout(timer); if (signal) signal.removeEventListener("abort", onAbort) }
  }
}

/** 剥离 HTML 标签与 Markdown 标记，折叠空白，返回纯文本。 */
export function plainText(raw) {
  if (!raw || typeof raw !== "string") return ""
  const html = raw.replace(/<[^>]+>/g, " ")
  const md = html
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*?)`/g, "$1")
    .replace(/!\[.*?\]\(.*?\)/g, " ")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/\*\*([^*]*?)\*\*/g, "$1")
    .replace(/__([^_]*?)__/g, "$1")
    .replace(/\*([^*]*?)\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
  return md.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim()
}

/** 截断字符串，保留省略号。 */
export function truncate(text, limit) {
  const n = Math.max(1, Math.trunc(limit))
  return text.length <= n ? text : text.slice(0, n - 1) + "\u2026"
}

/** 构造单个 WebSource。 */
export function source(url, opts = {}) {
  const out = { url }
  if (opts.title) out.title = opts.title
  if (opts.snippet) out.snippet = opts.snippet
  if (opts.content) out.content = opts.content
  if (opts.provider) out.provider = opts.provider
  return out
}

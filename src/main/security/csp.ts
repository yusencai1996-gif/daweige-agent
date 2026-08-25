import { session } from 'electron'

/**
 * CSP(M2-01)。
 * dev(http://localhost)经 onHeadersReceived 注入;
 * 生产构建(file://)不走网络栈钩子,由 M7-01 在 index.html 落 meta 标签时
 * 复用本文件导出的 buildContentSecurityPolicy()。
 */

export function buildContentSecurityPolicy(devServer: boolean): string {
  const directives = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // React 内联样式
    "img-src 'self' data: blob: https: http:", // Markdown 消息里的外链图片
    "font-src 'self' data:",
    devServer ? "connect-src 'self' ws://localhost:* http://localhost:*" : "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
  ]
  return directives.join('; ')
}

/** 仅对 http(s) 响应生效(dev server);file:// 场景见文件头注释。 */
export function installCspHeader(devServerUrl: string | undefined): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [buildContentSecurityPolicy(Boolean(devServerUrl))],
      },
    })
  })
}

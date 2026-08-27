import { session } from 'electron'

/**
 * 更新流量代理分流(用户 2026-08-23 需求:更新走系统代理,如同 GPT 直连)。
 * 背景:跨境直连更新源域名的 TLS 常被链路干扰;本机挂了代理时浏览器通畅,
 * 但 Electron 更新请求不可靠继承系统代理 → 更新失败。
 * 方案:先把 session 恢复"系统代理"模式,用 Chromium 内置的系统代理解析
 * (拿一个必然走代理的探测 URL),再把"仅更新域名走该代理、其余直连"的 PAC 显式化。
 * 系统代理未开时自动全程直连;代理失败 PAC 内置 DIRECT 回退。
 * 全程 Electron 官方 API,不在主进程执行任何外部命令(安全红线)。
 */

/** 解析系统代理地址(Chromium 读系统设置;未开代理返回 null)。 */
async function readSystemProxy(): Promise<string | null> {
  try {
    // 先恢复系统模式,保证 resolveProxy 反映的是系统代理而非我们上次的 PAC
    await session.defaultSession.setProxy({ mode: 'system' })
    // 探测一个规则上必然走代理的站点拿代理地址;若系统没开代理会得到 DIRECT
    const chain = await session.defaultSession.resolveProxy('https://www.google.com/generate_204')
    const m = /PROXY\s+([0-9a-zA-Z.]+:\d+)/.exec(chain)
    return m?.[1] ?? null
  } catch {
    return null
  }
}

/** 生成 PAC:仅更新域名走代理(失败回退直连),其他 DIRECT。纯函数便于测试。 */
export function buildUpdatePac(proxy: string, host = 'agent.daweige.host'): string {
  return `function FindProxyForURL(url, host){ if (dnsDomainIs(host, '${host}')) return 'PROXY ${proxy}; DIRECT'; return 'DIRECT'; }`
}

/** 应用代理分流。关键:electron-updater 用独立 session 分区 "electron-updater"
 * (见其 electronHttpExecutor.getNetSession),代理必须设进那个分区才生效;
 * defaultSession 一并设置保持一致。幂等,可反复调用。 */
export async function applyUpdateProxy(): Promise<void> {
  const proxy = await readSystemProxy()
  const targets = [
    session.defaultSession,
    session.fromPartition('electron-updater', { cache: false }),
  ]
  if (!proxy) {
    await Promise.all(targets.map((s) => s.setProxy({ mode: 'direct' })))
    return
  }
  const pac = `data:application/x-ns-proxy-autoconfig,${encodeURIComponent(buildUpdatePac(proxy))}`
  await Promise.all(targets.map((s) => s.setProxy({ pacScript: pac })))
}

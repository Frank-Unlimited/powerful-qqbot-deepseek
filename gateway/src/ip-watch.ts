import { Context } from 'koishi'
import type { Config } from './config.js'

/**
 * 优先用国内查询站点：开着代理时它们和 QQ 接口一样按规则直连，查到的才是 QQ 看到的 IP；
 * 用国外站点（如 ipify）会查到代理出口，和白名单需要的不一致。
 */
async function exitIp() {
  for (const url of ['https://ip.3322.net', 'https://ddns.oray.com/checkip', 'https://api.ipify.org']) {
    try {
      const text = await (await fetch(url, { signal: AbortSignal.timeout(10_000) })).text()
      const ip = text.match(/\d{1,3}(\.\d{1,3}){3}/)?.[0]
      if (ip) return ip
    } catch {}
  }
  throw new Error('所有查询站点都失败')
}

/** 家宽出口 IP 变化后需要去 QQ 开放平台更新白名单，否则接口报 11298。 */
export function ipWatch(ctx: Context, config: Config['ipWatch']) {
  if (!config.enabled) return
  const logger = ctx.logger('ip-watch')
  let current: string | undefined

  async function check() {
    try {
      const ip = await exitIp()
      if (current && ip !== current) {
        logger.warn('出口 IP 变化：%s -> %s，请到 QQ 开放平台更新 IP 白名单', current, ip)
        if (config.notifyUrl) await fetch(config.notifyUrl.replace('{ip}', encodeURIComponent(ip)))
      } else if (!current) {
        logger.info('当前出口 IP：%s（需在 QQ 开放平台白名单中）', ip)
      }
      current = ip
    } catch (e) {
      logger.warn('查询出口 IP 失败：%s', (e as Error).message)
    }
  }

  ctx.on('ready', check)
  ctx.setInterval(check, config.intervalMin * 60 * 1000)
}

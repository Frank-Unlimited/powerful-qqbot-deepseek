import { Context } from 'koishi'

const WINDOW_MS = 10 * 60 * 1000
const MAX_DROPS = 5
/** 停下后第一次自动重试的等待时间，之后每次翻倍，最多 1 小时；连续 2 小时没再触发就回到 5 分钟 */
const COOLDOWN_MIN_MS = 5 * 60 * 1000
const COOLDOWN_MAX_MS = 60 * 60 * 1000
const COOLDOWN_RESET_MS = 2 * 60 * 60 * 1000

/**
 * QQ 适配器心跳的 bug：心跳发出后把 _acked 置 false，等到 ACK 才置回 true，但换新连接时不重置。
 * 网络一断，旧连接停在 _acked = false，之后每条新连接的第一次心跳都会被当成"僵尸连接"直接关掉，
 * 永远恢复不了（2026-10-26 凌晨 Wi-Fi 断了 80 秒就是这样一直掉到早上）。这里在每条新连接开始时重置它。
 */
export function patchQQHeartbeat(qqModule: any) {
  const proto = (qqModule?.WsClient ?? qqModule?.default?.WsClient)?.prototype
  if (!proto?.accept) throw new Error('找不到 QQ 适配器的 WsClient，心跳补丁没打上')
  const accept = proto.accept
  proto.accept = function (this: any, ...args: unknown[]) {
    this._acked = true
    return accept.apply(this, args)
  }
}

/**
 * Koishi 的 QQ 适配器断线会无限重连。凭据错误、IP 不在白名单、机器人被封禁、
 * 沙箱机器人未配置测试对象等情况下重连没有意义，反复重连还可能触发平台限制。
 * 10 分钟内掉线 5 次就先停下并提示原因，过一阵再自动重试（5 分钟起，每次翻倍，最多 1 小时），
 * 这样断网之类的临时问题也能自己恢复。
 */
export function connectionGuard(ctx: Context) {
  const logger = ctx.logger('connection')
  const drops: number[] = []
  let cooldown = COOLDOWN_MIN_MS
  let lastStop = 0

  ctx.on('login-updated', ({ bot }) => {
    if (bot.platform !== 'qq') return
    if (bot.status === 1 /* ONLINE */) return logger.info('QQ 已连接：%s', bot.user?.name ?? bot.selfId)
    if (bot.status !== 0 /* OFFLINE */ && bot.status !== 4 /* RECONNECT */) return
    // 下面 bot.stop() 自己也会触发一次 OFFLINE，不算掉线
    if (Date.now() - lastStop < 1000) return

    const now = Date.now()
    drops.push(now)
    while (drops.length && now - drops[0] > WINDOW_MS) drops.shift()
    logger.warn('QQ 连接断开（10 分钟内第 %d 次）', drops.length)
    if (drops.length >= MAX_DROPS) {
      cooldown = now - lastStop > COOLDOWN_RESET_MS ? COOLDOWN_MIN_MS : Math.min(cooldown * 2, COOLDOWN_MAX_MS)
      lastStop = now
      logger.error([
        `短时间内反复掉线，先停止重连，${cooldown / 60_000} 分钟后自动再试。如果一直这样，常见原因：`,
        '1. AppID / AppSecret 错误（重新 npm run bind）',
        '2. 出口 IP 不在白名单（看 ip-watch 日志里的 IP，到开放平台更新）',
        '3. 另一个程序在用同一个机器人登录（关掉其他实例或其他框架）',
        '4. 机器人未上线且沙箱里没有配置测试群/测试成员',
        '5. 机器人被平台限制（去 q.qq.com 的通知里看）',
        '6. 网络断了（等网络恢复会自动连上）',
        '处理后重启网关可以立刻重连。',
      ].join('\n'))
      drops.length = 0
      bot.stop()
      ctx.setTimeout(() => {
        logger.info('冷却结束，重新连接 QQ')
        bot.start()
      }, cooldown)
    }
  })
}

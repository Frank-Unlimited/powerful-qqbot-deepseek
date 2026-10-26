import { Context, h, Session } from 'koishi'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { profilePath, type Config } from '../config.js'
import type { Store } from '../../../shared/store.mjs'
import { ImageStash } from './images.js'
import { Quota, QuotaSubject } from './quota.js'
import { Trigger } from './trigger.js'
import { idleTask } from './idle.js'
import { ownerSender, scheduler } from './scheduler.js'
import { builtinCommand, customCommands } from './commands.js'
import { VideoService } from '../video/index.js'
import { JobStore } from './jobs.js'
import { logReply, newTurnId } from '../short-term.js'
import type { AgentClient, AgentReply, AgentRequest, Mention } from './types.js'

/** 被动回复：同一条消息最多回复约 5 次，留 1 次余量（与腾讯官方插件一致取 4）；群聊窗口约 5 分钟。 */
const MAX_REPLIES = 4
const MAX_PENDING = 3
const VIDEO_HINT = '[这条消息里有视频链接：用 send_video 把视频发出来，可以顺口说一句，也可以只发视频]'

export function bridge(ctx: Context, config: Config, agent: AgentClient, store: Store, hooks: { onMessage?: (chat: string) => void, onConfigChange?: (fn: () => void) => void, afterTurn?: () => Promise<void> } = {}) {
  const logger = ctx.logger('bridge')
  const quota = new Quota(store, config.quota, config.admins)
  const trigger = new Trigger(config.group)
  const images = new ImageStash(ctx, store)
  const seen = new Set<string>()
  const fullSeen = new Set<string>()
  const queues = new Map<string, { tail: Promise<void>, pending: number }>()
  /** 同一条消息已经用掉的被动回复次数（补发早安会占用） */
  const used = new Map<string, number>()
  // 定时任务：早安、日记这些系统任务和她用 schedule 工具帮人设的，统一存在 data/jobs.json
  const jobs = new JobStore(config, store, ctx.logger('jobs'))
  // 调度：定时任务 + 冷场寒暄（条件触发，不算定时任务）
  const schedule = scheduler(ctx, config, { agent, store, quota, enqueue, toMessages }, [idleTask(config, store), jobs.task()])
  jobs.setRunner(key => schedule.run('jobs', key))
  const nameOf = (id: string) => store.profile(id)?.name || ''
  // 视频链接解析：send_video 工具调它下载；自动解析时群里出现视频链接就让她跑一轮去调这个工具
  const videos = new VideoService(ctx, config)

  /** 关键词表情上次在某个会话里发出的时间：`${会话键}|${关键词}` → 毫秒 */
  const keywordSent = new Map<string, number>()

  /**
   * 组装要发的消息，并按关键词自动附上表情（网关直接发，不经过模型、不花 token）；key 是会话键，用于冷却。
   * split：回复按换行拆成多条（聊天回复拆，日记这种成段的不拆）
   */
  function toMessages(reply: AgentReply, key = '', split = false): h[][] {
    const parts = splitText(reply.text, split ? config.agent.splitReply : 1)
    const messages = baseMessages(reply, parts)
    const already = new Set(reply.outbox.map(i => i.src))
    const extra: h[][] = []
    for (const rule of config.keywordStickers) {
      const words = rule.keyword.split('|').map(w => w.trim()).filter(Boolean)
      if (!reply.text || !words.some(w => reply.text.includes(w))) continue
      // 冷却按会话分别计算：同一个群 / 私聊里 N 分钟内只发一次
      const sentKey = `${key}|${rule.keyword}`
      const cooldown = (rule.cooldownMin ?? 0) * 60_000
      if (cooldown && Date.now() - (keywordSent.get(sentKey) ?? 0) < cooldown) continue
      const src = pathToFileURL(profilePath(rule.image)).href
      if (already.has(src)) continue
      already.add(src)
      keywordSent.set(sentKey, Date.now())
      extra.push([h.image(src)])
    }
    // 紧跟在文字后面，免得被"每条消息最多回复 4 次"截掉
    messages.splice(parts.length, 0, ...extra)
    return messages
  }
  // 原文（短期记忆）按配置的天数保留，每天清理一次
  const prune = () => logger.debug('清理原文 %d 条', store.pruneGroupMessages(config.memory.shortTerm.retentionDays * 86400_000))
  prune()
  ctx.setInterval(prune, 86400_000)

  // 用中间件而不是 message 事件：已匹配为指令（shark.usage 等）的消息不会进到这里
  ctx.middleware((session, next) => {
    if (!session.userId || session.userId === session.selfId) return next()
    if (!session.isDirect && !session.guildId) return next()
    // 全量模式下 @ 消息可能同时以 GROUP_AT 和 GROUP_MESSAGE 推送，按消息 id 去重
    if (session.messageId) {
      if (seen.has(session.messageId)) return
      seen.add(session.messageId)
      if (seen.size > 2000) seen.delete(seen.values().next().value!)
    }

    const key = session.isDirect ? `qq:user:${session.userId}` : `qq:group:${session.guildId}`
    const sender = session.author?.nick || session.author?.name || ''
    const { text, images: urls } = flatten(session.elements ?? [], session.selfId, nameOf)
    // 每条消息都记下来：群消息用于发言榜、总结和记忆梳理，私聊（chat 记为 user:<openid>）只用于记忆梳理
    if (sender) store.touchProfile(session.userId, sender)
    const logged = text + (urls.length ? '[图片]'.repeat(urls.length) : '')
    let rowId: number | undefined
    if (logged) {
      const chat = chatOf(session)
      rowId = store.logGroupMessage(chat, session.userId, sender, logged, session.timestamp || Date.now())
      hooks.onMessage?.(chat)
    }
    // 定时任务（早安、日记）的主动消息没发出去的话，借这条消息的被动回复补上
    const missed = schedule.takePending(key)
    if (missed.length) enqueue(key, () => sendMissed(session, missed))
    // 自动解析视频：消息里有视频链接，就算没叫她也让她跑一轮，提示她用 send_video 发出来。
    // send_video 被设成仅限主人、而发链接的不是主人时不自动处理（工具会拒绝）
    const videoAllowed = !config.features.ownerOnlyTools.includes('send_video') || session.userId === config.owner?.id
    const autoVideo = videoAllowed && videos.autoLinks(session, text).length > 0
    const reason = trigger.decide(session) ?? (autoVideo ? 'video' : null)
    logger.debug('收到 %s %s(%s): %s', session.isDirect ? '私聊' : `群 ${session.guildId}`, sender, session.userId, text.slice(0, 40))
    if (!reason) {
      // 每个群启动后第一条非 @ 消息记一行，用来确认全量消息权限真的生效了
      if (!session.isDirect && !fullSeen.has(session.guildId)) {
        fullSeen.add(session.guildId)
        logger.info('群 %s 收到非 @ 消息（全量消息已生效）：%s', session.guildId, text.slice(0, 30))
      }
      // 旁听的群消息里的图片也登记，之后被问到"刚才那张图"时可以去看
      images.stash(key, urls, sender).then(tags => trigger.observe(session, text + tags))
      return
    }
    if (!text && !urls.length && !session.quote) return

    logger.info('%s <- %s(%s) [%s]: %s', key, sender, session.userId, reason, text.slice(0, 60))
    enqueue(key, () => handle(session, key, reason, autoVideo ? `${text}\n${VIDEO_HINT}` : text, urls, autoVideo, rowId))
  })

  /** 占用这条消息的一次被动回复；没额度了返回 false */
  function takeReply(messageId: string) {
    const n = used.get(messageId) ?? 0
    if (n >= MAX_REPLIES) return false
    used.set(messageId, n + 1)
    if (used.size > 500) used.delete(used.keys().next().value!)
    return true
  }

  function enqueue(key: string, task: () => Promise<void>) {
    const queue = queues.get(key) ?? { tail: Promise.resolve(), pending: 0 }
    if (queue.pending >= MAX_PENDING) return logger.info('%s 队列已满，丢弃消息', key)
    queue.pending++
    // 一轮结束（回复已发出）后执行排着的事，例如改配置后的重启
    queue.tail = queue.tail.then(task).catch(e => logger.warn(e)).finally(() => {
      queue.pending--
      return hooks.afterTurn?.().catch(e => logger.warn(e))
    })
    queues.set(key, queue)
  }

  /** rowId：触发消息在原文里的行，补记轮次，深度回忆时能把这条消息和她的回复、工具调用对上 */
  async function handle(session: Session, key: string, reason: AgentRequest['reason'], text: string, urls: string[], video = false, rowId?: number) {
    const isAdmin = config.admins.includes(session.userId)
    // 谁买单：主动插话、自动解析视频都不是谁叫她，记在群上，不扣发言者的个人额度
    const groupId = session.isDirect ? undefined : session.guildId
    const unasked = reason === 'interest' || reason === 'video'
    const subject: QuotaSubject = unasked ? { groupId } : { userId: session.userId, groupId }
    const blocked = quota.blocked(subject)
    if (blocked) {
      logger.info('%s %s 被%s额度拦下', key, session.userId, { user: '个人', group: '群', global: '全局' }[blocked])
      if (subject.userId) await session.send(h.quote(session.messageId) + (blocked === 'user' ? config.quota.exceededReply : config.quota.sharedExceededReply))
      return
    }

    const sender = session.author?.nick || session.author?.name || ''
    let quote: AgentRequest['quote']
    if (session.quote) {
      // 引用的消息里如果有图片，同样只登记占位，手机 QQ 上"引用图片 + @她"就是指定看这张图
      const quoted = flatten(session.quote.elements ?? [], session.selfId, nameOf)
      const quotedName = session.quote.user?.id === session.selfId ? '你' : session.quote.user?.name || '某人'
      // QQ 新版引用常把被引用消息整理成一段文字，图片写成「[附件1] 类型:图片 … URL:https://…」，没有图片元素
      const { text: quotedText, images: textImages } = parseQuotedText(quoted.text || session.quote.content || '')
      quote = {
        name: quotedName,
        text: quotedText.slice(0, 300) + await images.stash(key, [...quoted.images, ...textImages], quotedName),
      }
    }

    const req: AgentRequest = {
      sessionKey: key,
      scene: session.isDirect ? 'private' : 'group',
      reason,
      sender: { id: session.userId, name: sender, isAdmin, isOwner: session.userId === config.owner?.id },
      groupId: session.isDirect ? undefined : session.guildId,
      text: text + await images.stash(key, urls, sender),
      quote,
      observed: session.isDirect ? [] : trigger.drain(session.guildId),
      mentions: mentionsOf(session, nameOf),
      turn: newTurnId(),
    }
    if (rowId) store.tagTurn(rowId, req.turn!)

    let reply: AgentReply
    try {
      // 要下载视频的轮次多等一会儿（解析 + 下载最多约 3 分钟）
      const timeoutSec = video ? Math.max(config.agent.timeoutSec, 240) : config.agent.timeoutSec
      reply = await agent.chat(req, AbortSignal.timeout(timeoutSec * 1000))
    } catch (e) {
      logger.warn('agent 调用失败 %s: %s', key, (e as Error).message)
      if (!unasked) await session.send(config.agent.errorReply)
      return
    }
    quota.record(subject, key, reply.charges)
    if (reply.silent) return
    await deliver(session, reply, reason)
  }

  async function deliver(session: Session, reply: AgentReply, reason: AgentRequest['reason']) {
    const messages = toMessages(reply, session.isDirect ? `qq:user:${session.userId}` : `qq:group:${session.guildId}`, true)
    if (reason !== 'direct' && session.messageId && (reply.text || reply.outbox.some(i => i.type === 'image'))) messages[0].unshift(h.quote(session.messageId))
    // 她自己说的话也记进原文，总结、深度回忆时才是完整的对话
    logReply(store, chatOf(session), config.bot.name, reply, reason)
    let previous = ''
    for (const message of messages) {
      // 额度和视频解析共用，逐条占用；用完就不发了
      if (session.messageId && !takeReply(session.messageId)) break
      // 连发的几条之间停一下，像在打下一句（按上一条的字数，最多 2.5 秒）
      if (previous) await sleep(Math.min(500 + previous.length * 80, 2500))
      previous = message.filter(el => el.type === 'text').map(el => el.attrs.content).join('') || ' '
      try {
        await session.send(message)
      } catch (e) {
        logger.warn('发送失败：%s', (e as Error).message)
        // 图文消息里图片发不出去时，至少把文字补发出去
        const text = message.filter(el => el.type === 'text' || el.type === 'quote')
        if (text.length < message.length && text.some(el => el.type === 'text')) {
          await session.send(text).catch(e2 => logger.warn('补发文字失败：%s', (e2 as Error).message))
        }
      }
    }
  }

  async function sendMissed(session: Session, messages: string[]) {
    // 最多占 2 次，留给这条消息本身的回复
    const sent = messages.slice(0, 2)
    for (const message of sent) {
      try {
        await session.send(message)
      } catch (e) {
        logger.warn('补发早安失败：%s', (e as Error).message)
      }
    }
    if (session.messageId) for (const _ of sent) takeReply(session.messageId)
    logger.info('%s 已补发早安', session.isDirect ? `qq:user:${session.userId}` : `qq:group:${session.guildId}`)
  }

  // ---- 命令：内置的写在这里（看板只读），自定义的在角色包 config.yaml 的 commands（看板可增删改） ----

  builtinCommand(ctx, config, { name: 'shark.usage', description: '查看今日额度' }, (session) => {
    const s = quota.userStatus(session.userId)
    const fmt = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 1 })
    if (s.admin) return `今日已用 ${fmt(s.spent)} credits（管理员不限）`
    return `今日已用 ${fmt(s.spent)} / ${fmt(s.limit)} credits${s.balance ? `，充值余额 ${fmt(s.balance)}` : ''}，还能用 ${fmt(s.remaining)}`
  })

  builtinCommand(ctx, config, { name: 'shark.whoami', description: '查看自己的 openid（填管理员用）' }, (session) => {
    return session.isDirect ? `你的 openid：${session.userId}` : `你的 openid：${session.userId}
本群 openid：${session.guildId}`
  })

  builtinCommand(ctx, config, { name: 'shark.reset', description: '清空当前会话上下文', permission: 'admin' }, async (session) => {
    await agent.reset(session.isDirect ? `qq:user:${session.userId}` : `qq:group:${session.guildId}`)
    return '好的，之前聊的我都忘掉啦'
  })

  // 自定义命令（原来的 /shark.greet、/shark.diary 现在是默认的自定义命令 /早安、/写日记 的别名）
  customCommands(ctx, {
    config,
    // 和每天定时执行的完全一样：走主动消息，发不出去按任务的规则处理
    runTask: (taskId, session) => {
      const key = session.isDirect ? `qq:user:${session.userId}` : `qq:group:${session.guildId}`
      return taskId === 'idle' ? schedule.run('idle', key) : jobs.runByName(taskId, key)
    },
    runPrompt: (session, text) => {
      const key = session.isDirect ? `qq:user:${session.userId}` : `qq:group:${session.guildId}`
      enqueue(key, () => handle(session, key, session.isDirect ? 'direct' : 'at', text, []))
    },
  }, hooks.onConfigChange ?? (() => {}))

  // ---- 群数据：发言榜、总结、群规、欢迎新人 ----

  const RANGES: Record<string, { label: string, since: () => number, until?: () => number }> = {
    今天: { label: '今天', since: () => startOfDay(0) },
    昨天: { label: '昨天', since: () => startOfDay(1), until: () => startOfDay(0) },
    本周: { label: '最近 7 天', since: () => Date.now() - 7 * 86400_000 },
    本月: { label: '最近 30 天', since: () => Date.now() - 30 * 86400_000 },
  }

  builtinCommand(ctx, config, { name: '发言榜', args: '[range:string]', aliases: ['shark.rank'], description: '查看群发言排行（今天 / 昨天 / 本周 / 本月）', scene: 'group' }, (session, range = '今天') => {
    const r = RANGES[range] ?? RANGES.今天
    const list = store.groupRank(session.guildId, r.since(), r.until?.(), 'self', 10)
    if (!list.length) return `${r.label}群里还没人说话`
    const medals = ['🥇', '🥈', '🥉']
    const { messages, speakers } = store.groupTotals(session.guildId, r.since(), 'self')
    return [
      `${r.label}发言榜`,
      ...list.map((x, i) => `${medals[i] ?? `${i + 1}.`} ${x.name || '某人'}  ${x.count} 条`),
      ...(r.until ? [] : [`共 ${speakers} 人说了 ${messages} 条`]),
    ].join('\n')
  })

  builtinCommand(ctx, config, { name: '总结', args: '[hours:number]', aliases: ['shark.summary'], description: `让${config.bot.name}总结最近几小时的群聊（默认 3 小时）`, scene: 'group' }, (session, hours = 3) => {
    hours = Math.min(Math.max(hours, 0.5), 24)
    const key = `qq:group:${session.guildId}`
    enqueue(key, () => handle(session, key, 'at', `帮我总结一下最近 ${hours} 小时的群聊（用 deep_recall 翻聊天原文），说说大家聊了哪几件事、有什么结论，分几句话讲清楚。`, []))
  })

  builtinCommand(ctx, config, { name: '群规', aliases: ['shark.rules'], description: '查看群规', scene: 'group' }, () => {
    return config.welcome.rules.trim() || '本群还没有设置群规'
  })

  // 新成员入群：官方文档没写群聊有这个事件，适配器支持，平台推了就欢迎（推没推看日志）
  ctx.on('guild-member-added', (session) => {
    if (session.platform !== 'qq' || !session.guildId || !session.userId) return
    logger.info('群 %s 有新成员入群：%s', session.guildId, session.userId)
    if (!config.welcome.enabled) return
    const key = `qq:group:${session.guildId}`
    enqueue(key, async () => {
      // 欢迎新人没有发起人，和定时任务一样算主人发起的
      const sender = ownerSender(config, store)
      const subject = { userId: sender.isOwner ? sender.id : undefined, groupId: session.guildId }
      if (!quota.check(subject)) return
      let reply: AgentReply
      try {
        reply = await agent.chat({
          sessionKey: key,
          scene: 'group',
          reason: 'schedule',
          sender,
          groupId: session.guildId,
          text: config.welcome.prompt
            + (config.welcome.rules.trim() ? '群规会在你这句话后面自动发出去，你可以顺口提醒 TA 看一眼，但别自己复述群规。' : ''),
          observed: [],
        }, AbortSignal.timeout(config.agent.timeoutSec * 1000))
      } catch (e) {
        return logger.warn('欢迎语生成失败：%s', (e as Error).message)
      }
      quota.record(subject, key, reply.charges)
      logReply(store, session.guildId, config.bot.name, reply, 'welcome')
      const messages: (h[] | string)[] = toMessages(reply, key)
      if (config.welcome.rules.trim()) messages.push(config.welcome.rules.trim())
      for (const message of messages) {
        await session.bot.sendMessage(session.guildId, message).catch(e => logger.warn('欢迎消息发送失败：%s', (e as Error).message))
      }
    })
  })

  return { quota, videos, jobs }
}

/**
 * 解析文字形式的引用内容：抽出「类型:图片 … URL:…」里的图片地址，去掉这些附件行和"=== 消息 1 ==="等格式行，
 * 只留下对方原本说的话。
 */
export function parseQuotedText(text: string) {
  const images: string[] = []
  const kept: string[] = []
  for (const line of text.split('\n')) {
    const url = line.match(/URL:(https?:\/\/[^\s\]]+)/)?.[1]
    if (url && /类型:\s*图片/.test(line)) images.push(url)
    else if (url || /^=== 消息 \d+ ===$/.test(line.trim()) || /^\[消息类型\]/.test(line.trim())) continue
    else kept.push(line)
  }
  return { text: kept.join('\n').trim(), images }
}

/** 文本 + 图片合并为一条；语音、表情包各自单独一条（QQ 不支持图文混排语音）。 */
/** 按换行拆成最多 max 条；多出来的行并进最后一条 */
function splitText(text: string, max: number): string[] {
  if (!text) return []
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean)
  if (max <= 1 || lines.length <= 1) return [text]
  return lines.length <= max ? lines : [...lines.slice(0, max - 1), lines.slice(max - 1).join('\n')]
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function baseMessages(reply: AgentReply, parts: string[]): h[][] {
  const messages: h[][] = parts.map(p => [h.text(p)])
  // 生成的图片跟在最后一句话后面
  const images = reply.outbox.filter(i => i.type === 'image').map(i => h.image(i.src))
  if (images.length) messages.length ? messages[messages.length - 1].push(...images) : messages.push(images)
  for (const item of reply.outbox) {
    if (item.type === 'video') messages.push([h.video(item.src)])
    if (item.type === 'sticker') messages.push([h.image(item.src)])
    if (item.type === 'audio') messages.push([h.audio(item.src)])
  }
  return messages
}

/** 消息记录里的会话：群是群 openid，私聊是 user:<openid> */
const chatOf = (session: Session) => session.isDirect ? `user:${session.userId}` : session.guildId

/** 北京时间 daysAgo 天前的 0 点（毫秒时间戳） */
function startOfDay(daysAgo: number) {
  const DAY = 86400_000
  const now = Date.now() + 8 * 3600_000
  return now - (now % DAY) - 8 * 3600_000 - daysAgo * DAY
}

/** 这句话里提到的人：@ 到的（含嵌套元素）和被引用消息的作者，去掉她自己和发言人，按出现顺序去重 */
function mentionsOf(session: Session, nameOf: (id: string) => string): Mention[] {
  const out: Mention[] = []
  const add = (id: string | undefined, name: string | undefined, via: Mention['via']) => {
    if (!id || id === session.selfId || id === session.userId || out.some(m => m.id === id)) return
    out.push({ id, name: name || nameOf(id) || '某人', via })
  }
  const walk = (elements: h[]) => {
    for (const el of elements) {
      if (el.type === 'at') add(el.attrs.id, el.attrs.name, 'at')
      else if (el.children?.length) walk(el.children)
    }
  }
  walk(session.elements ?? [])
  add(session.quote?.user?.id, session.quote?.user?.name, 'quote')
  return out
}

/** 把消息元素拆成纯文本和图片地址；去掉 @机器人 本身。@ 别人时 QQ 只给 openid，用 nameOf 换成昵称。 */
function flatten(elements: h[], selfId: string, nameOf: (id: string) => string) {
  const images: string[] = []
  const parts: string[] = []
  for (const el of elements) {
    if (el.type === 'text') parts.push(el.attrs.content)
    else if (el.type === 'at' && el.attrs.id !== selfId) parts.push(`@${el.attrs.name || nameOf(el.attrs.id) || '某人'}`)
    else if (el.type === 'img' || el.type === 'image') images.push(el.attrs.src || el.attrs.url)
    else if (el.type === 'face') parts.push(`[表情:${el.attrs.name || el.attrs.id}]`)
    else if (el.children?.length) parts.push(flatten(el.children, selfId, nameOf).text)
  }
  return { text: parts.join('').trim(), images }
}

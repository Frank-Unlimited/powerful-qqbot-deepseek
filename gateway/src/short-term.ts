/**
 * 短期记忆（原文）：每个群 / 私聊里群友的消息、她的回复、她调用的工具和结果，存在 group_messages 表里。
 * 会话 chat 的写法沿用消息记录：群是群 openid，私聊是 user:<openid>。
 * 她用 deep_recall 翻原文（替代原来的 read_group_history），只能翻当前会话的。
 */
import { randomBytes } from 'node:crypto'
import type { Episode, GroupMessage, MemoryAnchor, Store } from '../../shared/store.mjs'
import type { Context } from 'koishi'
import type { MemorySettings } from './config.js'
import type { ActivityLog } from './activity.js'
import { deepseekJson } from './llm.js'

const DAY = 86400_000
const TZ = 8 * 3600_000

export const newTurnId = () => `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`

/** 会话键（qq:group:X / qq:user:X）→ 原文里的会话（X / user:X） */
export const chatOfKey = (sessionKey: string) => sessionKey.startsWith('qq:group:') ? sessionKey.slice(9) : `user:${sessionKey.slice(8)}`

const textOf = (content: unknown) => Array.isArray(content)
  ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
  : String(content ?? '')

/** 工具参数压成一句：只取字符串和数字参数的值 */
function argsSummary(raw: string) {
  try {
    const args = JSON.parse(raw || '{}')
    return Object.values(args).filter(v => typeof v === 'string' || typeof v === 'number').join('，').slice(0, 60)
  } catch {
    return String(raw).slice(0, 60)
  }
}

/** 这一轮跑完后，把工具调用按发生时间写进原文（她的回复由网关发出时另记） */
export function logToolCalls(store: Store, chat: string, turn: string, events: any[], resultChars: number) {
  const calls = new Map<string, any>()
  for (const e of events) {
    if (e.type === 'tool/call') calls.set(e.data.callId, e)
    else if (e.type === 'tool/result') {
      const call = calls.get(e.data?.message?.toolCallId)
      if (!call) continue
      const name = call.data.name
      const args = String(call.data.arguments ?? '')
      const result = textOf(e.data.message.content)
      const error = e.data.message.isError ? result.slice(0, 300) : undefined
      store.logGroupMessage(chat, 'self', '', `调用 ${name}（${argsSummary(args)}）`, call.time ?? Date.now(), {
        kind: 'tool', turn,
        meta: { tool: name, args: args.slice(0, 1000), ...(error ? { error } : { result: result.slice(0, resultChars) }) },
      })
    }
  }
}

/** 北京时间某天 0 点 */
function dayStart(t: number) {
  return t - ((t + TZ) % DAY)
}

/** 「今天 / 昨天 / 前天 / 10-21 / 2026-10-21」→ 那天的 [since, until) */
export function parseDay(text: string, now = Date.now()): { since: number, until: number } | null {
  const s = text.trim()
  const rel = ({ 今天: 0, 昨天: 1, 前天: 2 } as Record<string, number>)[s]
  if (rel !== undefined) {
    const since = dayStart(now) - rel * DAY
    return { since, until: since + DAY }
  }
  const m = s.match(/^(?:(\d{4})[-/.])?(\d{1,2})[-/.](\d{1,2})$/)
  if (!m) return null
  const local = new Date(now + TZ)
  let year = m[1] ? Number(m[1]) : local.getUTCFullYear()
  // 没写年份、日期在今天之后的，算去年
  let since = Date.UTC(year, Number(m[2]) - 1, Number(m[3])) - TZ
  if (!m[1] && since > now) since = Date.UTC(--year, Number(m[2]) - 1, Number(m[3])) - TZ
  if (Number.isNaN(since)) return null
  return { since, until: since + DAY }
}

const pad = (n: number) => String(n).padStart(2, '0')
function stamp(t: number, withDate: boolean) {
  const d = new Date(t + TZ)
  const clock = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  return withDate ? `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${clock}` : clock
}

/** 一行原文给模型看的样子 */
export function formatRow(r: GroupMessage, withDate = false) {
  const t = stamp(r.time, withDate)
  if (r.kind === 'reply' || (r.kind !== 'tool' && r.user_id === 'self')) return `${t} 你：${r.text.slice(0, 300)}`
  if (r.kind === 'tool') {
    const meta = parseMeta(r)
    const head = `${t} 你 → ${r.text.replace(/^调用 /, '')}`
    if (meta.error) return `${head} 失败：${String(meta.error).slice(0, 100)}`
    return meta.result ? `${head}：${String(meta.result).replace(/\s+/g, ' ').slice(0, 120)}` : head
  }
  return `${t} ${r.name || '某人'}：${r.text.slice(0, 300)}`
}

export function parseMeta(r: GroupMessage): Record<string, any> {
  try {
    return r.meta ? JSON.parse(r.meta) : {}
  } catch {
    return {}
  }
}

export interface BrowseOptions {
  hours?: number
  date?: string
  /** 只看这个人（已解析好的 openid 和名字） */
  who?: { id: string, name: string }
  keyword?: string
}

/** 段编号：「E12」「e12」「12」都行 */
const parseEpisode = (ref: unknown) => Number(String(ref ?? '').trim().replace(/^[Ee#]/, ''))

/**
 * 深度回忆：原文按"段"组织（见 store.assignEpisode），每次返回都不超过 deepRecallChars 字。
 * 三级：段目录（摘要）→ 一段原文（分页）→ 段里的某几行（记忆出处 / 某人 / 关键词）。
 */
export class ShortTermMemory {
  constructor(private store: Store, private settings: MemorySettings) {}

  private get budget() {
    return this.settings.shortTerm.deepRecallChars
  }

  /** 段的标题行：编号、起止时间、几行、谁在聊、摘要 */
  private header(e: Episode) {
    const cross = dayStart(e.start) !== dayStart(e.end)
    const people = this.store.episodePeople(e.id)
    return `E${e.id} · ${stamp(e.start, true)} ~ ${stamp(e.end, cross)} · ${e.rows} 条${people.length ? ` · ${people.slice(0, 6).join('、')}${people.length > 6 ? ' 等' : ''}` : ''}${e.summary ? ` · ${e.summary}` : ''}`
  }

  /**
   * 按时间翻：和这段时间有重叠的完整的段（跨 0 点的段不截断）。
   * 放得下就给原文，放不下给段目录让她挑；who / keyword 只看相关的行，按段分组。
   */
  browse(chat: string, opts: BrowseOptions) {
    const now = Date.now()
    let range: { since: number, until: number }
    let label: string
    if (opts.date) {
      const day = parseDay(opts.date, now)
      if (!day) throw new Error(`看不懂日期「${opts.date}」，写成 今天 / 昨天 / 前天 / 10-21`)
      range = day
      label = stamp(day.since, true).slice(0, 5)
    } else {
      const hours = Math.min(Math.max(Number(opts.hours) || 3, 0.1), 72)
      range = { since: now - hours * 3600_000, until: now }
      label = `最近 ${hours} 小时`
    }
    const scope = chat.startsWith('user:') ? '私聊' : '本群'
    const episodes = this.store.episodesBetween(chat, range.since, range.until)
    const keyword = opts.keyword?.trim()
    const title = `【${scope}原文 · ${label}${opts.who ? ` · 只看 ${opts.who.name}` : ''}${keyword ? ` · 关键词 ${keyword}` : ''}】`
    if (!episodes.length) return `${label}${scope}没有聊天记录`

    // 只看相关的行：每段筛一遍，新的段优先放进预算
    if (opts.who || keyword) {
      const groups: string[][] = []
      for (const e of episodes) {
        const rows = this.store.episodeRows(e.id)
        // 某人：TA 的发言，加上她回 TA 的那几轮（回复、工具调用）
        const turns = new Set(opts.who ? rows.filter(r => r.kind === 'msg' && r.user_id === opts.who!.id).map(r => r.turn).filter(Boolean) : [])
        const byWho = (r: GroupMessage) => (r.kind === 'msg' && r.user_id === opts.who!.id) || (r.kind !== 'msg' && Boolean(r.turn) && turns.has(r.turn))
        // 关键词：命中的行和前后两行
        const near = new Set<number>()
        if (keyword) rows.forEach((r, i) => { if (`${r.name ?? ''} ${r.text} ${r.meta ?? ''}`.includes(keyword)) for (let j = i - 2; j <= i + 2; j++) near.add(j) })
        // 两个都给了取交集
        const keep = new Set(rows.map((r, i) => i).filter(i => (!opts.who || byWho(rows[i])) && (!keyword || near.has(i))))
        if (keep.size) groups.push([`—— ${this.header(e)} ——`, ...folded(rows, keep, e)])
      }
      if (!groups.length) return `${title}\n没有找到`
      return [title, ...this.pack(groups, '更早的')].join('\n')
    }

    // 整段给：放得下就全给
    const full = episodes.map(e => [`—— ${this.header(e)} ——`, ...this.store.episodeRows(e.id).map(r => formatRow(r, dayStart(e.start) !== dayStart(e.end)))])
    if (full.reduce((n, g) => n + size(g), 0) <= this.budget) return [title, ...full.flat()].join('\n')
    // 放不下：给段目录
    const index = episodes.map(e => [this.header(e) + (e.summary ? '' : `（开头：${this.store.episodeRows(e.id).find(r => r.kind === 'msg')?.text.slice(0, 30) ?? ''}）`)])
    return [title, `这段时间有 ${episodes.length} 段，原文太长放不下，下面是目录。想看哪段就用 deep_recall 的 episode 填编号（比如 E${episodes[episodes.length - 1].id}）：`, ...this.pack(index, '更早的')].join('\n')
  }

  /** 打开一段，超过预算就分页（offset = 从第几行开始） */
  openEpisode(ref: unknown, chat: string, canSeeAll: boolean, offset = 0) {
    const id = parseEpisode(ref)
    const e = Number.isFinite(id) ? this.store.episode(id) : undefined
    if (!e) return `没有 ${String(ref)} 这一段（可能已经被清理）`
    if (e.chat !== chat && !canSeeAll) return `E${id} 在别的会话里，这里不能看`
    const rows = this.store.episodeRows(e.id)
    const cross = dayStart(e.start) !== dayStart(e.end)
    const start = Math.min(Math.max(Math.floor(Number(offset) || 0), 0), Math.max(rows.length - 1, 0))
    const lines: string[] = [`【${this.header(e)}】`]
    if (start > 0) lines.push(`……（前面 ${start} 条省略）`)
    let used = 0, i = start
    for (; i < rows.length; i++) {
      const line = formatRow(rows[i], cross)
      if (used + line.length > this.budget && i > start) break
      lines.push(line)
      used += line.length + 1
    }
    if (i < rows.length) lines.push(`……（后面还有 ${rows.length - i} 条，用 deep_recall episode=E${e.id} offset=${i} 接着看）`)
    return lines.join('\n')
  }

  /**
   * 顺着长期记忆找原文（二级检索）：出处所在的段（最多 2 段），出处那几行标 ★；
   * 段太长时以 ★ 为中心往两边取满预算。只能看当前会话里的原文；主人在私聊里不限（canSeeAll）。
   */
  byMemory(memoryId: string, chat: string, canSeeAll: boolean) {
    const id = memoryId.replace(/^#/, '').trim()
    if (id.length < 6) throw new Error('记忆编号至少要 6 位')
    const anchors = this.store.anchorsOf(id)
    if (!anchors.length) return `#${id} 没有原文（手动添加的，或者是记下出处之前的老记忆）`
    const visible = anchors.filter(a => canSeeAll || a.chat === chat)
    if (!visible.length) return `#${id} 的原文在别的会话里，这里不能看`

    // 每段要标 ★ 的行：出处区间里（有重点人物就只标 TA 的发言）
    const marks = new Map<number, { stars: Set<number>, anchor: MemoryAnchor }>()
    for (const a of visible) {
      for (const ep of this.store.episodesOfAnchor(a)) {
        if (marks.size >= 2 && !marks.has(ep)) continue
        const entry = marks.get(ep) ?? { stars: new Set<number>(), anchor: a }
        for (const r of this.store.episodeRows(ep)) {
          if (r.id >= a.from_id && r.id <= a.to_id && (!a.focus || r.user_id === a.focus)) entry.stars.add(r.id)
        }
        marks.set(ep, entry)
      }
    }
    if (!marks.size) return `#${id} 的原文已经被清理`

    const out: string[] = []
    const share = Math.floor(this.budget / marks.size)
    for (const [ep, { stars, anchor }] of marks) {
      const e = this.store.episode(ep)!
      const rows = this.store.episodeRows(ep)
      const cross = dayStart(e.start) !== dayStart(e.end)
      const place = e.chat === chat ? (chat.startsWith('user:') ? '私聊' : '本群') : (e.chat.startsWith('user:') ? '另一个私聊' : '另一个群')
      const focus = anchor.focus ? this.store.profile(anchor.focus)?.name : ''
      out.push(`【#${id} 的原文 · ${place} · ${this.header(e)}${focus ? ` · 重点看 ${focus}` : ''} · ★ 是记下这条时的那几行${anchor.guessed ? '（出处是按时间推测的）' : ''}】`)
      const lines = rows.map(r => (stars.has(r.id) ? '★ ' : '') + formatRow(r, cross))
      // 从 ★ 往两边扩，直到用满这一段的预算
      const keep = new Set<number>()
      let used = 0
      const starIdx = rows.map((r, i) => stars.has(r.id) ? i : -1).filter(i => i >= 0)
      const queue = starIdx.length ? starIdx : [0]
      for (let d = 0; d < rows.length && used < share; d++) {
        for (const c of queue) {
          for (const i of d ? [c - d, c + d] : [c]) {
            if (i < 0 || i >= rows.length || keep.has(i)) continue
            if (used + lines[i].length > share && keep.size) continue
            keep.add(i)
            used += lines[i].length + 1
          }
        }
      }
      out.push(...folded(rows, keep, e, lines))
    }
    return out.join('\n')
  }

  /** 按预算从新到旧装组，装不下的旧组折叠成一句 */
  private pack(groups: string[][], olderLabel: string) {
    const kept: string[][] = []
    let used = 0
    for (let i = groups.length - 1; i >= 0; i--) {
      const n = size(groups[i])
      if (used + n > this.budget && kept.length) {
        kept.unshift([`……（${olderLabel} ${i + 1} 段省略，可以缩小时间范围）`])
        break
      }
      kept.unshift(groups[i])
      used += n
    }
    return kept.flat()
  }
}

const size = (lines: string[]) => lines.reduce((n, l) => n + l.length + 1, 0)

/** 只留 keep 里的行，中间断开的地方写"省略几条"，提示用 episode 看全段 */
function folded(rows: GroupMessage[], keep: Set<number>, e: Episode, lines?: string[]) {
  const cross = dayStart(e.start) !== dayStart(e.end)
  const idx = [...keep].filter(i => i >= 0 && i < rows.length).sort((a, b) => a - b)
  const out: string[] = []
  let prev = -1
  for (const i of idx) {
    const gap = i - prev - 1
    if (gap > 0) out.push(`……（省略 ${gap} 条）`)
    out.push(lines ? lines[i] : formatRow(rows[i], cross))
    prev = i
  }
  const tail = rows.length - 1 - prev
  if (tail > 0) out.push(`……（后面省略 ${tail} 条）`)
  if (idx.length < rows.length) out.push(`（看全段用 deep_recall episode=E${e.id}）`)
  return out
}

/** 给模型看的出处提示：「10-21 本群」「10-21 私聊」「别的会话」；没有出处返回空 */
export function anchorHint(store: Store, memoryId: string, chat: string) {
  const a = store.anchorsOf(memoryId)[0]
  if (!a) return ''
  if (a.chat !== chat) return '别的会话'
  const row = store.transcriptRange(a.chat, a.from_id, a.to_id)[0]
  const day = row ? stamp(row.time, true).slice(0, 5) : ''
  const episode = store.episodesOfAnchor(a)[0]
  return `${day} ${chat.startsWith('user:') ? '私聊' : '本群'}${episode ? ` E${episode}` : ''}`.trim()
}

/** 她的回复写进原文；只发了媒体没说话时记成「[发了视频]」这种 */
export function logReply(store: Store, chat: string, botName: string, reply: { text: string, outbox: { type: string }[], turn?: string }, reason: string, task?: string) {
  const LABEL: Record<string, string> = { image: '图片', sticker: '表情包', audio: '语音', video: '视频' }
  const media = reply.outbox.map(i => i.type)
  const text = reply.text || media.map(t => `[发了${LABEL[t] ?? t}]`).join('')
  if (!text) return
  store.logGroupMessage(chat, 'self', botName, text, Date.now(), {
    kind: 'reply', turn: reply.turn,
    meta: { reason, ...(task ? { task } : {}), ...(media.length ? { media } : {}) },
  })
  // 这一轮里记下的长期记忆，出处延到她的回复
  if (reply.turn) store.closeAnchors(reply.turn)
}

/**
 * 段落摘要：每 10 分钟把已经结束（冷场超过 gap）、还没摘要的段批量交给便宜的模型，各写一句话。
 * 少于 4 行的段不调模型，直接用第一句话。
 */
export function episodeSummarizer(ctx: Context, settings: MemorySettings, store: Store, activity: ActivityLog) {
  const logger = ctx.logger('episodes')
  let running = false
  const failures = new Map<string, number>()
  const firstLine = (rows: GroupMessage[]) => ((rows.find(r => r.kind === 'msg') ?? rows[0])?.text ?? '').split('\n')[0].trim().slice(0, 40)
  async function run() {
    const { summaries, summaryModel, episodeGapMin } = settings.shortTerm
    if (!summaries || running) return
    running = true
    try {
      const due = store.unsummarizedEpisodes(Date.now() - episodeGapMin * 60_000, 40)
      const big: { e: Episode, rows: GroupMessage[] }[] = []
      for (const e of due) {
        const rows = store.episodeRows(e.id)
        if (rows.length < 4) store.setEpisodeSummary(e.id, firstLine(rows))
        else big.push({ e, rows })
      }
      for (let i = 0; i < big.length; i += 5) {
        const batch = big.slice(i, i + 5)
        // 每段最多给 1500 字：开头和结尾各一半
        const text = batch.map(({ e, rows }) => {
          const lines = rows.map(r => formatRow(r))
          let body = lines.join('\n')
          if (body.length > 1500) body = `${body.slice(0, 750)}\n……\n${body.slice(-750)}`
          return `## E${e.id}\n${body}`
        }).join('\n\n')
        let json: any
        try {
          json = await deepseekJson(activity, summaryModel,
            '给 QQ 群聊记录的每一段写一句话摘要（不超过 40 字）：谁和谁在聊什么、有什么结论。"你"指机器人自己，摘要里写成"她"。只输出 JSON：{"summaries": {"E12": "…"}}',
            text, '原文分段摘要', 3000)
        } catch (e) {
          logger.warn('分段摘要失败：%s', (e as Error).message)
          // 下次再试；同一批连续失败 3 次才退回用第一句话，免得一直烧 token
          const key = batch.map(b => b.e.id).join(',')
          failures.set(key, (failures.get(key) ?? 0) + 1)
          if ((failures.get(key) ?? 0) < 3) continue
          failures.delete(key)
        }
        for (const { e, rows } of batch) {
          const got = json?.summaries?.[`E${e.id}`] ?? json?.summaries?.[String(e.id)]
          store.setEpisodeSummary(e.id, typeof got === 'string' && got.trim() ? got.trim().slice(0, 60) : firstLine(rows))
        }
      }
      if (due.length) logger.debug('补了 %d 段摘要', due.length)
    } finally {
      running = false
    }
  }
  ctx.setInterval(() => run().catch(e => logger.warn(e)), 10 * 60_000)
  ctx.on('ready', () => run().catch(e => logger.warn(e)))
}

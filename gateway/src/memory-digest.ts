import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from 'koishi'
import { ROOT, type Config } from './config.js'
import type { Store } from '../../shared/store.mjs'
import type { MemoryService } from './memory.js'
import type { ActivityLog } from './activity.js'

/** 每个群 / 私聊梳理到了哪条消息（group_messages.id），重启后接着来 */
const STATE_FILE = resolve(ROOT, 'data/mem0/digest.json')
/** 每人每次最多交给 mem0 的发言条数 */
const MAX_LINES_PER_PERSON = 40

/**
 * 记忆梳理：每个群 / 私聊每攒够 N 条新消息，把这一批里每个人说的话分别交给 mem0（infer 模式），
 * 提取画像和偏好写进 TA 自己的记忆（user:<openid>）。间隔设 1 就相当于每轮自动记忆。
 * 消息记录里群的 chat 是群 openid，私聊是 user:<openid>。参数在 config.memory.digest，实时生效。
 */
export function memoryDigest(ctx: Context, config: Config, store: Store, memory: MemoryService, activity: ActivityLog) {
  const logger = ctx.logger('digest')
  const state: Record<string, number> = load()
  const running = new Set<string>()

  async function run(chat: string) {
    const { minLines, maxPeople } = config.memory.digest
    const isPrivate = chat.startsWith('user:')
    const rows = store.groupMessagesAfter(chat, state[chat] ?? 0, 1000)
    if (!rows.length) return
    // 先推进进度：梳理失败也不反复重试同一批，避免一直烧 token
    state[chat] = rows[rows.length - 1].id
    save()

    // 每人这一批说的话（user），加上她回 TA 的那几轮里她说的话（assistant），按原文顺序
    const fromId = rows[0].id
    const toId = rows[rows.length - 1].id
    const transcript = store.transcriptRange(chat, fromId, toId)
    const turnOwner = new Map<string, string>()
    const byUser = new Map<string, { role: 'user' | 'assistant', content: string }[]>()
    const spoken = new Map<string, number>()
    for (const r of transcript) {
      if (r.kind === 'msg' && r.user_id !== 'self') {
        if (r.turn) turnOwner.set(r.turn, r.user_id)
        const text = r.text.replace(/\[图片\]/g, '').trim()
        // 纯图片、指令不梳理
        if (!text || text.startsWith('/')) continue
        byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), { role: 'user', content: `${r.name || '某人'}：${text}` }])
        spoken.set(r.user_id, (spoken.get(r.user_id) ?? 0) + 1)
      } else if (r.kind === 'reply' && r.turn && turnOwner.has(r.turn)) {
        const userId = turnOwner.get(r.turn)!
        byUser.get(userId)?.push({ role: 'assistant', content: r.text.slice(0, 300) })
      }
    }
    const people = [...byUser.entries()]
      .filter(([userId]) => (spoken.get(userId) ?? 0) >= minLines)
      .sort((a, b) => (spoken.get(b[0]) ?? 0) - (spoken.get(a[0]) ?? 0))
      .slice(0, maxPeople)
    const label = isPrivate ? `私聊 ${chat.slice(5, 13)}` : `群 ${chat.slice(0, 8)}`
    if (!people.length) return logger.debug('%s 这批 %d 条没有可梳理的人', label, rows.length)

    let added = 0
    for (const [userId, messages] of people) {
      try {
        added += await memory.digest(`user:${userId}`, isPrivate ? undefined : chat, messages.slice(-MAX_LINES_PER_PERSON), { chat, fromId, toId, focus: userId })
      } catch (e) {
        logger.warn('梳理 %s 失败：%s', userId, (e as Error).message)
      }
    }
    logger.info('%s 记忆梳理：%d 条消息，%d 人，新增 %d 条记忆', label, rows.length, people.length, added)
    activity.log({ sessionKey: isPrivate ? `qq:${chat}` : `qq:group:${chat}`, kind: 'memory_write', detail: `记忆梳理：${people.length} 人 +${added} 条`, auto: true })
  }

  function load(): Record<string, number> {
    try {
      if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    } catch {}
    return {}
  }

  function save() {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  }

  return {
    /** 每记一条消息调用一次：攒够了就在后台梳理（同一个会话同时只跑一个） */
    onMessage(chat: string) {
      const { enabled, everyMessages } = config.memory.digest
      if (!enabled || running.has(chat)) return
      if (store.countGroupMessagesAfter(chat, state[chat] ?? 0) < everyMessages) return
      running.add(chat)
      run(chat).catch(e => logger.warn(e)).finally(() => running.delete(chat))
    },
  }
}

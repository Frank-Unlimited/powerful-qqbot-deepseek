/**
 * dsh 插件调用的记忆接口（remember / recall / forget / deep_recall）。
 * 作用域和权限一律由网关按"当前这一轮"决定（插件只传会话 id），插件无法越权。
 */
import type { Context } from 'koishi'
import type { Config } from './config.js'
import type { Store } from '../../shared/store.mjs'
import type { AgentClient, TurnInfo } from './bridge/types.js'
import type { MemoryService } from './memory.js'
import { anchorHint, chatOfKey, type ShortTermMemory } from './short-term.js'
import { resolvePerson } from './people.js'
import type { PortraitService } from './portrait.js'

export function memoryRoutes(ctx: Context, config: Config, store: Store, agent: AgentClient, memory: MemoryService, shortTerm: ShortTermMemory, portraits: PortraitService) {
  const route = (path: string, handler: (body: any, turn: TurnInfo) => unknown) => {
    ctx.server.post(`/internal/memory/${path}`, async (koa: any) => {
      try {
        const body = koa.request.body ?? {}
        const turn = agent.currentTurn(body.sessionId)
        if (!turn) throw new Error('无法确定当前发言人')
        koa.body = { ok: true, result: await handler(body, turn) }
      } catch (e) {
        koa.body = { ok: false, error: (e as Error).message }
      }
    })
  }
  const scopesOf = (turn: TurnInfo) => {
    const chat = chatOfKey(turn.sessionKey)
    return { chat, user: `user:${turn.senderId}`, group: chat.startsWith('user:') ? undefined : `group:${chat}` }
  }
  // dsh 会话 id 是 <会话键>~<代数>，审计里记会话键
  const audit = (turn: TurnInfo) => ({ sessionKey: turn.sessionKey, userId: turn.senderId, via: 'tool' as const })
  const names = (raw: unknown) => String(raw ?? '').split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean)

  route('remember', async ({ about, who, content }, turn) => {
    const s = scopesOf(turn)
    const anchor = { chat: s.chat, turn: turn.turn }
    const text = String(content ?? '').trim()
    if (!text) throw new Error('内容是空的')
    let items
    if (about === 'group') {
      if (!s.group) throw new Error('私聊里不能记群记忆')
      const subjects = names(who).map(n => resolvePerson(store, turn, n).id)
      items = await memory.remember(s.group, text, 'tool', { subjects, anchor })
    } else if (about === 'person') {
      if (!who) throw new Error('about=person 要写 who（是谁的事）')
      const person = resolvePerson(store, turn, String(who))
      // 说的是发言人自己，就按 sender 记
      const reporter = person.id === turn.senderId ? undefined : turn.senderId
      items = await memory.remember(`user:${person.id}`, text, 'tool', { reporter, anchor })
    } else {
      items = await memory.remember(s.user, text, 'tool', { anchor })
    }
    return items.map(m => m.id.slice(0, 8))
  })

  route('recall', async ({ query, who }, turn) => {
    const s = scopesOf(turn)
    const q = String(query ?? '')
    const limit = Math.max(config.agent.memoryLimit, 1)
    if (who) {
      const person = resolvePerson(store, turn, String(who))
      // 问别人的事只给群聊来源的记忆；主人私聊不限
      const publicOnly = person.id !== turn.senderId && !(turn.isOwner && !s.group)
      const items = await memory.searchPerson(person.id, s.group ? [s.group] : [], q, limit, audit(turn), publicOnly)
      return { person: person.name, portrait: portraits.describe(person.id, !publicOnly), rows: items.map(m => ({ id: m.id.slice(0, 8), memory: m.memory, about: m.scope.startsWith('group:') ? 'group' : 'person', from: anchorHint(store, m.id, s.chat) })) }
    }
    const scopes = [s.user, ...(s.group && memory.settings.recallGroup ? [s.group] : [])]
    const items = await memory.search(scopes, q, limit, audit(turn))
    return { rows: items.map(m => ({ id: m.id.slice(0, 8), memory: m.memory, about: m.scope.startsWith('group:') ? 'group' : 'sender', from: anchorHint(store, m.id, s.chat) })) }
  })

  route('forget', async ({ id }, turn) => {
    const s = scopesOf(turn)
    const item = await memory.resolve([s.user, ...(s.group ? [s.group] : [])], String(id ?? '').replace(/^#/, ''))
    if (!item) throw new Error('没有这条记忆，或者它不属于当前发言人/当前群')
    await memory.delete(item.id)
    return item.memory
  })

  route('deep', ({ memory: memoryId, episode, offset, hours, date, who, keyword }, turn) => {
    const chat = chatOfKey(turn.sessionKey)
    // 主人在私聊里可以看别的会话的原文（只限顺着记忆 / 段编号看）
    const canSeeAll = turn.isOwner && chat.startsWith('user:')
    if (memoryId) return shortTerm.byMemory(String(memoryId), chat, canSeeAll)
    if (episode) return shortTerm.openEpisode(episode, chat, canSeeAll, Number(offset) || 0)
    const person = who ? resolvePerson(store, turn, String(who)) : undefined
    return shortTerm.browse(chat, { hours, date, who: person, keyword })
  })
}

/**
 * 把模型写的"某人"（昵称、@昵称、外号的一部分）解析成 openid。
 * 顺序：这句话里 @ 到 / 被引用的人 → 本会话近 30 天说过话的人 → （仅主人私聊）所有见过的人。
 * 多个候选就报错让她换个说法，绝不猜；权限：群里只能指本群的人，私聊只能指对方自己，主人不限。
 */
import type { Store } from '../../shared/store.mjs'
import type { Mention, TurnInfo } from './bridge/types.js'
import { chatOfKey } from './short-term.js'

const RECENT_MS = 30 * 86400_000

export interface Person { id: string, name: string }

const norm = (s: string) => s.trim().replace(/^@/, '').toLowerCase()

/** 精确匹配优先，其次包含 */
function pick<T extends { name: string | null }>(list: T[], who: string): T[] {
  const exact = list.filter(p => p.name && norm(p.name) === who)
  return exact.length ? exact : list.filter(p => p.name && norm(p.name).includes(who))
}

function ambiguous(who: string, list: { id: string, name: string | null }[]): never {
  const names = list.slice(0, 6).map(p => `${p.name}（${p.id.slice(-4)}）`).join('、')
  throw new Error(`「${who}」能对上好几个人：${names}。换个更完整的叫法，或者让对方 @ 一下`)
}

export function resolvePerson(store: Store, turn: TurnInfo, raw: string): Person {
  const who = norm(raw)
  if (!who) throw new Error('没说是谁')
  const chat = chatOfKey(turn.sessionKey)
  const isGroup = !chat.startsWith('user:')
  const senderName = store.profile(turn.senderId)?.name ?? ''
  const self = { id: turn.senderId, name: senderName }

  if (['我', '自己', '本人'].includes(who) || who === norm(senderName) || who === turn.senderId.toLowerCase()) return self

  // 私聊：只能是对方自己，主人例外
  if (!isGroup && !turn.isOwner) throw new Error('私聊里只能记 / 查对方自己的事')

  const mentioned: Mention[] = turn.mentions
  const hit = mentioned.find(m => m.id.toLowerCase() === who) ? [mentioned.find(m => m.id.toLowerCase() === who)!] : pick(mentioned, who)
  if (hit.length === 1) return { id: hit[0].id, name: hit[0].name }
  if (hit.length > 1) ambiguous(raw, hit)

  if (isGroup) {
    const people = store.peopleInChat(chat, Date.now() - RECENT_MS).filter(p => p.id !== turn.senderId)
    const found = people.find(p => p.id.toLowerCase() === who) ? [people.find(p => p.id.toLowerCase() === who)!] : pick(people, who)
    if (found.length === 1) return { id: found[0].id, name: found[0].name ?? raw }
    if (found.length > 1) ambiguous(raw, found)
    if (!turn.isOwner) throw new Error(`本群最近没有叫「${raw}」的人；让对方 @ 一下再说`)
  }

  // 主人：所有见过的人
  const all = store.listProfiles().map(p => ({ id: p.user_id, name: p.name }))
  const found = all.find(p => p.id.toLowerCase() === who) ? [all.find(p => p.id.toLowerCase() === who)!] : pick(all, who)
  if (found.length === 1) return { id: found[0].id, name: found[0].name ?? raw }
  if (found.length > 1) ambiguous(raw, found)
  throw new Error(`没见过叫「${raw}」的人`)
}


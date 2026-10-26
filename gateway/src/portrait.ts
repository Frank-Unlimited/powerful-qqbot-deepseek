/**
 * 群友画像（记忆的第三层）：每人一份结构化画像，夜间由 TA 名下群聊来源的长期记忆融合而成。
 * - 每节标出处（长期记忆短 id），看板可改、可锁定、可回滚；锁定的分节和主人备注整理时不碰
 * - 私聊来源的记忆不进画像（判定见 MemoryService.isPrivate）
 * - 每轮消息头：发言人放画像全文（同一会话隔 reinjectHours 才重放，其间放一句话版本），被提到的人只放不涉及私事的几节
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from 'koishi'
import { ROOT, type Config } from './config.js'
import type { PortraitData, PortraitSection, Store } from '../../shared/store.mjs'
import type { MemoryItem, MemoryService } from './memory.js'
import type { ActivityLog } from './activity.js'
import { deepseekJson } from './llm.js'

export const SECTIONS = [
  { key: 'identity', label: '身份与称呼', hint: '是谁、做什么的、她怎么称呼 TA、外号' },
  { key: 'persona', label: '性格与说话风格', hint: '性格、说话习惯、常玩的梗' },
  { key: 'likes', label: '喜好与雷点', hint: '喜欢什么、讨厌什么、别碰的话题' },
  { key: 'recent', label: '近况与计划', hint: '最近在忙什么、打算做什么（最容易过时）' },
  { key: 'bond', label: '和她的关系', hint: '和她（机器人）的关系、约定、她答应过 TA 的事' },
  { key: 'relations', label: '和群友的关系', hint: '和其他群友的关系' },
  { key: 'note', label: '主人备注', hint: '主人手写，整理永远不改' },
] as const
export type SectionKey = typeof SECTIONS[number]['key']
/** 被别人 @ 到时只露这几节，近况、和她的关系可能涉及私事 */
const MENTION_SECTIONS: SectionKey[] = ['likes', 'relations']
const MAX_SECTION = 200
const MAX_TOTAL = 900
const MAX_SUMMARY = 60
const MAX_EVIDENCE = 150
const INJECTED_FILE = resolve(ROOT, 'data/portrait-injected.json')
const NIGHT_FILE = resolve(ROOT, 'data/portrait-night.json')
const TAGGED_FILE = resolve(ROOT, 'data/mem0/group-subjects-tagged.json')
const SOURCE_LABEL: Record<string, string> = { digest: '梳理', tool: '她记的', manual: '手动', migrated: '旧版', auto: '自动' }

const loadJson = (file: string) => {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  } catch {
    return {}
  }
}
const pad = (n: number) => String(n).padStart(2, '0')
const beijing = (t = Date.now()) => {
  const d = new Date(t + 8 * 3600_000)
  return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, clock: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`, md: `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` }
}
const timeOf = (m: MemoryItem) => Date.parse(m.updatedAt ?? m.createdAt ?? '') || 0

export function emptyPortrait(): PortraitData {
  return {
    sections: Object.fromEntries(SECTIONS.map(s => [s.key, { text: '', sources: [] as string[], locked: s.key === 'note' }])) as Record<string, PortraitSection>,
    summary: '',
  }
}

export class PortraitService {
  private logger
  /** `${dsh 会话 id}|${openid}` → 上次放全文时的画像版本和时间 */
  private injected: Record<string, { version: number, at: number }> = loadJson(INJECTED_FILE)
  private running = false

  constructor(ctx: Context, private config: Config, private store: Store, private memory: MemoryService, private activity: ActivityLog) {
    this.logger = ctx.logger('portrait')
    // 夜间整理：每分钟看一次，到点且今天还没跑过就跑（错过了当天补跑）
    ctx.setInterval(() => this.tick().catch(e => this.logger.warn('夜间整理失败：%s', (e as Error).message)), 60_000)
  }

  get(userId: string) {
    return this.store.portrait(userId)
  }

  // ---- 每轮消息头 ----

  /**
   * 放进消息头的画像行。self = 发言人：全文在同一会话里隔 reinjectHours 才重放，其间只放一句话；
   * mention = 被提到的人：一句话 + 不涉及私事的几节。没画像（或关掉了）返回 null。
   */
  header(userId: string, sessionId: string, role: 'self' | 'mention'): { summary: string, detail?: string } | null {
    const { enabled, reinjectHours } = this.config.memory.portrait
    const row = enabled ? this.store.portrait(userId) : undefined
    if (!row) return null
    const { summary } = row.data
    if (role === 'mention') return { summary, detail: this.sectionsText(row.data, MENTION_SECTIONS) || undefined }
    const key = `${sessionId}|${userId}`
    const last = this.injected[key]
    const fresh = !last || last.version !== row.version || Date.now() - last.at > reinjectHours * 3600_000
    if (!fresh) return { summary }
    this.injected[key] = { version: row.version, at: Date.now() }
    writeFileSync(INJECTED_FILE, JSON.stringify(this.injected))
    return { summary, detail: this.sectionsText(row.data, SECTIONS.map(s => s.key)) || undefined }
  }

  /** recall 工具专门回忆某人时附上的画像；full = false 时只给不涉及私事的几节 */
  describe(userId: string, full: boolean) {
    const row = this.config.memory.portrait.enabled ? this.store.portrait(userId) : undefined
    if (!row) return ''
    const detail = this.sectionsText(row.data, full ? SECTIONS.map(s => s.key) : MENTION_SECTIONS)
    return [row.data.summary, detail].filter(Boolean).join('｜')
  }

  private sectionsText(data: PortraitData, keys: readonly string[]) {
    return keys
      .map(k => ({ k, text: data.sections[k]?.text?.trim() }))
      .filter(s => s.text)
      .map(s => `${SECTIONS.find(x => x.key === s.k)!.label}：${s.text}`)
      .join('｜')
  }

  // ---- 证据：TA 名下群聊来源的长期记忆 ----

  async evidence(userId: string): Promise<MemoryItem[]> {
    const own = await this.memory.list(`user:${userId}`)
    const tagged = (await Promise.all(this.store.memoriesAbout(userId).map(id => this.memory.get(id).catch((): undefined => undefined))))
      .filter((m): m is MemoryItem => Boolean(m))
    return [...own, ...tagged].filter(m => !this.memory.isPrivate(m))
  }

  /** 夜间要整理的人：有画像且有新记忆，或者没画像但记忆够多；按新记忆数从多到少 */
  async candidates() {
    const { minMemories } = this.config.memory.night
    const out: { userId: string, name: string, total: number, fresh: number }[] = []
    for (const p of this.store.listProfiles()) {
      const items = await this.evidence(p.user_id)
      if (!items.length) continue
      const row = this.store.portrait(p.user_id)
      const fresh = row ? items.filter(m => timeOf(m) > row.watermark).length : items.length
      if (row ? fresh > 0 : items.length >= minMemories) out.push({ userId: p.user_id, name: p.name ?? '', total: items.length, fresh })
    }
    return out.sort((a, b) => b.fresh - a.fresh)
  }

  // ---- 整理一个人 ----

  async consolidate(userId: string, by = 'night'): Promise<number | null> {
    const items = await this.evidence(userId)
    if (!items.length) throw new Error('TA 名下没有群聊来源的记忆')
    const old = this.store.portrait(userId)?.data ?? emptyPortrait()
    const name = this.store.profile(userId)?.name || userId.slice(0, 8)
    const recalls = new Map(this.store.recallStats().map(s => [s.memoryId, s.count]))
    const picked = pickEvidence(items, recalls)
    const known = new Set(picked.map(m => m.id.slice(0, 8)))

    const locked = SECTIONS.filter(s => old.sections[s.key]?.locked)
    const lines = picked.map(m => {
      const reporter = m.reporter ? this.store.profile(m.reporter)?.name || '别人' : ''
      const tags = [SOURCE_LABEL[m.source ?? ''] ?? m.source, beijing(timeOf(m)).md, recalls.get(m.id) ? `召回${recalls.get(m.id)}次` : '', reporter ? `据${reporter}说` : '', m.scope.startsWith('group:') ? '群记忆' : '']
        .filter(Boolean).join('·')
      return `#${m.id.slice(0, 8)} [${tags}] ${m.memory}`
    })
    const current = SECTIONS.map(s => `${s.key}（${s.label}${old.sections[s.key]?.locked ? '，已锁定' : ''}）：${old.sections[s.key]?.text || '（空）'}`).join('\n')
    const system = `你在帮 QQ 群聊机器人「${this.config.bot.name}」整理她对一位群友的认识，把关于这个人的零散记忆融合成一份画像。
只输出 JSON：{"sections": {${SECTIONS.filter(s => s.key !== 'note').map(s => `"${s.key}": {"text": "…", "sources": ["记忆编号"]}`).join(', ')}}, "summary": "…"}
各节含义：${SECTIONS.filter(s => s.key !== 'note').map(s => `${s.key}=${s.label}（${s.hint}）`).join('；')}。
规则：
- 只写记忆里有出处的内容，不推测；每节的 sources 列出用到的记忆编号（# 后面 8 位）。没有内容的节 text 留空字符串。
- 新记忆和旧记忆冲突时以新的为准；"据某人说"的内容要写明是转述。
- 不写联系方式、住址、真实姓名、身份证件、健康状况，不写对方说过"别告诉别人"的事。
- 用第三人称、简体中文，每节不超过 ${MAX_SECTION} 字，全部加起来不超过 600 字；summary 是一句话版本，不超过 ${MAX_SUMMARY} 字。
- 现有画像里已锁定的节不用输出（会原样保留）；没锁定、看起来是人工改过的内容，除非有更新的记忆明确推翻，否则保留。`
    const user = `群友：${name}
主人备注（只读，供参考）：${old.sections.note?.text || '（无）'}

现有画像：
${current}
现有一句话版本：${old.summary || '（无）'}

关于 TA 的记忆（${picked.length} 条，新到旧）：
${lines.join('\n')}`
    const json = await this.llm(system, user, `画像整理：${name}`)

    // 校验：分节齐全、长度、出处真实存在、锁定的原样保留
    const next = emptyPortrait()
    let total = 0
    for (const s of SECTIONS) {
      const prev = old.sections[s.key] ?? { text: '', sources: [], locked: s.key === 'note' }
      if (s.key === 'note' || prev.locked) {
        next.sections[s.key] = prev
        continue
      }
      const got = json?.sections?.[s.key]
      const text = typeof got?.text === 'string' ? got.text.trim().slice(0, MAX_SECTION) : ''
      const sources = (Array.isArray(got?.sources) ? got.sources : []).map((x: unknown) => String(x).replace(/^#/, '').slice(0, 8)).filter((x: string) => known.has(x))
      next.sections[s.key] = { text, sources: [...new Set<string>(sources)], locked: false }
      total += text.length
    }
    next.summary = typeof json?.summary === 'string' ? json.summary.trim().slice(0, MAX_SUMMARY) : old.summary
    if (total > MAX_TOTAL) throw new Error(`画像太长（${total} 字），这次不更新`)
    if (!total && !next.summary) throw new Error('模型没写出内容，这次不更新')
    const watermark = Math.max(...items.map(timeOf), 0)
    const version = this.store.savePortrait(userId, next, by, `${picked.length} 条记忆`, watermark)
    this.logger.info('%s 的画像更新到 v%d（%d 条记忆）', name, version, picked.length)
    return version
  }

  // ---- 看板 ----

  /** 看板修改：只改传了的节（文字 / 锁定）和一句话版本 */
  update(userId: string, patch: { sections?: Record<string, { text?: string, locked?: boolean }>, summary?: string }) {
    const data = structuredClone(this.store.portrait(userId)?.data ?? emptyPortrait())
    for (const [key, change] of Object.entries(patch.sections ?? {})) {
      if (!SECTIONS.some(s => s.key === key)) throw new Error(`没有「${key}」这一节`)
      const section = data.sections[key] ?? { text: '', sources: [], locked: false }
      if (typeof change.text === 'string') {
        if (change.text.length > (key === 'note' ? 1000 : MAX_SECTION * 2)) throw new Error('这一节太长了')
        // 人工改过的文字不再对应原来的出处
        if (change.text !== section.text) section.sources = []
        section.text = change.text.trim()
      }
      if (typeof change.locked === 'boolean' && key !== 'note') section.locked = change.locked
      data.sections[key] = section
    }
    if (typeof patch.summary === 'string') data.summary = patch.summary.trim().slice(0, MAX_SUMMARY * 2)
    return this.store.savePortrait(userId, data, 'dashboard')
  }

  rollback(userId: string, version: number) {
    const target = this.store.portraitHistory(userId).find(h => h.version === version)
    if (!target) throw new Error(`没有 v${version}`)
    return this.store.savePortrait(userId, target.data, 'rollback', `回滚到 v${version}`)
  }

  // ---- 夜间整理 ----

  lastNight(): { date?: string, at?: number, people?: number, updated?: number, failed?: number, error?: string } {
    return loadJson(NIGHT_FILE)
  }

  private async tick() {
    const { enabled, time } = this.config.memory.night
    if (!enabled || !this.config.memory.portrait.enabled || this.running) return
    const now = beijing()
    if (!/^\d{1,2}:\d{2}$/.test(time) || now.clock < time.padStart(5, '0') || this.lastNight().date === now.date) return
    await this.runNight(now.date)
  }

  /** 跑一次夜间整理（看板也可以手动触发）；同时只跑一个 */
  async runNight(date = beijing().date) {
    if (this.running) throw new Error('正在整理中')
    this.running = true
    try {
      await this.tagGroupMemories().catch(e => this.logger.warn('给群记忆补标归属人失败：%s', (e as Error).message))
      const list = (await this.candidates()).slice(0, this.config.memory.night.maxPeople)
      let updated = 0, failed = 0
      for (const c of list) {
        try {
          if (await this.consolidate(c.userId)) updated++
        } catch (e) {
          failed++
          this.logger.warn('整理 %s 的画像失败：%s', c.name || c.userId, (e as Error).message)
        }
      }
      writeFileSync(NIGHT_FILE, JSON.stringify({ date, at: Date.now(), people: list.length, updated, failed }))
      this.logger.info('夜间整理：%d 人，更新 %d 份画像，失败 %d', list.length, updated, failed)
      this.activity.log({ kind: 'memory_write', detail: `夜间整理：${list.length} 人，更新 ${updated} 份画像`, auto: true })
    } catch (e) {
      // 整体失败也记下今天跑过，免得每分钟重试
      writeFileSync(NIGHT_FILE, JSON.stringify({ date, at: Date.now(), error: (e as Error).message }))
      throw e
    } finally {
      this.running = false
    }
  }

  /** 一次性：老的群记忆没有归属人，让模型从这个群说过话的人里标出涉及谁（只标人，不改内容） */
  private async tagGroupMemories() {
    if (existsSync(TAGGED_FILE)) return
    let tagged = 0
    const done = new Set(this.store.allSubjects().map(s => s.memoryId))
    for (const { chat } of this.store.transcriptChats()) {
      if (chat.startsWith('user:')) continue
      const people = this.store.peopleInChat(chat).filter(p => p.name)
      const items = (await this.memory.list(`group:${chat}`)).filter(m => !done.has(m.id))
      if (!people.length || !items.length) continue
      for (let i = 0; i < items.length; i += 60) {
        const batch = items.slice(i, i + 60)
        const json = await this.llm(
          '给群记忆标出涉及哪些群友。只能从名单里选名字，不涉及具体某个人的不用列出。只输出 JSON：{"tags": {"记忆编号": ["名字"]}}',
          `群友名单：${people.map(p => p.name).join('、')}\n\n群记忆：\n${batch.map(m => `#${m.id.slice(0, 8)} ${m.memory}`).join('\n')}`,
          '群记忆补标归属人',
        )
        for (const m of batch) {
          const names: unknown = json?.tags?.[m.id.slice(0, 8)] ?? json?.tags?.[`#${m.id.slice(0, 8)}`]
          if (!Array.isArray(names)) continue
          const ids = names.map(n => people.filter(p => p.name === String(n))).filter(l => l.length === 1).map(l => l[0].id)
          if (ids.length) {
            this.store.setSubjects(m.id, ids)
            tagged++
          }
        }
      }
    }
    writeFileSync(TAGGED_FILE, JSON.stringify({ at: new Date().toISOString(), tagged }))
    this.logger.info('老的群记忆补标归属人：%d 条', tagged)
  }

  private llm(system: string, user: string, label: string) {
    return deepseekJson(this.activity, this.config.agent.model, system, user, label)
  }
}

/** 记忆太多时：最新的和被召回最多的各取一半，再按新到旧排 */
function pickEvidence(items: MemoryItem[], recalls: Map<string, number>) {
  const byTime = [...items].sort((a, b) => timeOf(b) - timeOf(a))
  if (items.length <= MAX_EVIDENCE) return byTime
  const half = MAX_EVIDENCE / 2
  const chosen = new Map(byTime.slice(0, half).map(m => [m.id, m]))
  for (const m of [...items].sort((a, b) => (recalls.get(b.id) ?? 0) - (recalls.get(a.id) ?? 0))) {
    if (chosen.size >= MAX_EVIDENCE) break
    chosen.set(m.id, m)
  }
  return [...chosen.values()].sort((a, b) => timeOf(b) - timeOf(a))
}

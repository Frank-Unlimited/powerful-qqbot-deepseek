import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from 'koishi'
import { ROOT, type MemorySettings } from './config.js'
import type { GroupMessage, Store } from '../../shared/store.mjs'
import { chatOfKey } from './short-term.js'
import { embed, EMBED_DIMS, EMBED_MODEL } from './embedder.js'

const DIR = resolve(ROOT, 'data/mem0')

export interface MemoryItem {
  id: string
  scope: string
  memory: string
  score?: number
  createdAt?: string
  updatedAt?: string
  /** 来源：manual 手动 / tool 她用工具记的 / auto 每轮自动 / digest 群记忆梳理 / migrated 旧版迁移 */
  source?: string
  /** 梳理时来自哪个群 */
  group?: string
  /** 转述：谁说的（openid） */
  reporter?: string
}

/** 记一条记忆时顺带记下：说的是谁、谁说的、出自原文哪一段 */
export interface MemoryLinks {
  /** 归属人（user:<X> 名下的隐含是 X，不用写） */
  subjects?: string[]
  reporter?: string
  /** 她在哪个会话的哪一轮记的；出处取这一轮的原文 */
  anchor?: { chat: string, turn?: string }
}

/** 召回审计：谁在哪个会话里、以什么方式召回了记忆 */
export interface RecallContext {
  sessionKey: string
  userId?: string
  via: 'auto' | 'tool'
}

/**
 * 长期记忆：mem0（开源版，Node SDK）。
 * - 只在网关进程里实例化，dsh 插件的记忆工具通过网关本地接口访问，避免两个进程同时写向量库
 * - 作用域沿用 user:<openid> / group:<openid>，对应 mem0 的 userId
 * - 向量用本地 FastEmbed + bge-small-zh-v1.5（DeepSeek 没有 embedding 接口），LLM 用 DeepSeek
 */
export class MemoryService {
  private ready: Promise<any>
  private logger

  /** settings 是 ConfigStore 原地更新的对象，召回参数实时生效 */
  constructor(ctx: Context, private store: Store, private model: string, readonly settings: MemorySettings) {
    this.logger = ctx.logger('memory')
    this.ready = this.init()
    this.ready.catch(e => this.logger.error('mem0 初始化失败：%s', e))
  }

  private async init() {
    // 关掉 mem0 默认的使用统计上报；模型从国内镜像下载
    process.env.MEM0_TELEMETRY ??= 'false'
    const { Memory } = await import('mem0ai/oss')
    // mem0 的 langchain 适配器接受任意带 embedQuery / embedDocuments 的对象，借它接入共享的本地向量模型
    const embedder = {
      embedQuery: async (text: string) => (await embed([text]))[0],
      embedDocuments: embed,
    }
    const memory = new Memory({
      embedder: { provider: 'langchain', config: { model: embedder, embeddingDims: EMBED_DIMS } },
      vectorStore: { provider: 'memory', config: { collectionName: 'shark', dimension: EMBED_DIMS, dbPath: resolve(DIR, 'vector_store.db') } },
      llm: { provider: 'deepseek', config: { apiKey: process.env.DEEPSEEK_API_KEY, model: this.model, temperature: 0.2, maxTokens: 1500 } },
      historyDbPath: resolve(DIR, 'history.db'),
      customInstructions: '对话来自 QQ 群聊或私聊，用简体中文记录。只记录关于这个人本身、长期有用的事实（身份、喜好、习惯、经历、计划、约定、人际关系），不记录闲聊、玩笑和一次性的问题。用第三人称，写清楚是谁。'
        + 'assistant 是机器人自己的回复，只用来理解上下文、记下机器人答应过这个人的事（约定），不要记录关于机器人自己的事。',
    } as any)
    await this.migrate(memory)
    await this.migrateCallNames(memory)
    this.logger.info('mem0 已就绪（向量模型 %s）', EMBED_MODEL)
    return memory
  }

  /** 一次性把旧版自研记忆表迁移进 mem0（原样写入，不经 LLM 改写）；旧表保留作备份。 */
  private async migrate(memory: any) {
    const flag = resolve(DIR, 'migrated.json')
    if (existsSync(flag)) return
    const old = this.store.listMemories()
    let ok = 0
    for (const m of old.reverse()) {
      try {
        await memory.add(m.content, { userId: m.scope, infer: false, metadata: { source: 'migrated', legacy_id: m.id } })
        ok++
      } catch (e) {
        this.logger.warn('迁移记忆 #%d 失败：%s', m.id, (e as Error).message)
      }
    }
    writeFileSync(flag, JSON.stringify({ at: new Date().toISOString(), total: old.length, ok }))
    if (old.length) this.logger.info('已迁移旧记忆 %d/%d 条', ok, old.length)
  }

  /** 一次性：以前 set_call_name 存的外号转成这个人的记忆（外号以后只靠记忆），转完清掉旧字段 */
  private async migrateCallNames(memory: any) {
    const flag = resolve(DIR, 'callnames-migrated.json')
    if (existsSync(flag)) return
    let ok = 0
    for (const p of this.store.listProfiles().filter(p => p.call_name)) {
      try {
        await memory.add(`你给${p.name || 'TA'}起的外号是「${p.call_name}」`, { userId: `user:${p.user_id}`, infer: false, metadata: { source: 'migrated' } })
        this.store.clearCallName(p.user_id)
        ok++
      } catch (e) {
        this.logger.warn('迁移外号 %s 失败：%s', p.user_id, (e as Error).message)
      }
    }
    writeFileSync(flag, JSON.stringify({ at: new Date().toISOString(), ok }))
    if (ok) this.logger.info('已把 %d 个外号转成记忆', ok)
  }

  /**
   * 一次性：给记下出处之前的老记忆按时间推测出处（标 guessed）。原文只保留了 30 天，更早的找不到就算了。
   * - digest：那个群 / 私聊里，创建前 2 小时内这个人的发言
   * - tool：活动记录里创建时刻那次 remember 调用所在的会话，往前 30 分钟内最多 11 行
   */
  async backfillAnchors() {
    const flag = resolve(DIR, 'anchors-backfilled.json')
    if (existsSync(flag)) return
    await this.ready
    const scopes = new Set<string>()
    for (const p of this.store.listProfiles()) scopes.add(`user:${p.user_id}`)
    for (const c of this.store.transcriptChats()) scopes.add(c.chat.startsWith('user:') ? c.chat : `group:${c.chat}`)
    const calls = this.store.activitySince(0).filter(a => a.kind === 'memory_write' && a.detail === 'remember' && a.session_key)
    let total = 0, ok = 0
    for (const scope of scopes) {
      for (const item of await this.list(scope)) {
        if (this.store.anchorsOf(item.id).length) continue
        total++
        const t = Date.parse(item.createdAt ?? '')
        if (Number.isNaN(t)) continue
        let chat: string | undefined
        let rows: GroupMessage[] = []
        let focus: string | undefined
        if (item.source === 'digest' && scope.startsWith('user:')) {
          focus = scope.slice(5)
          chat = item.group ?? scope
          rows = this.store.transcript(chat, t - 2 * 3600_000, t + 60_000).filter(r => r.user_id === focus && r.kind === 'msg')
        } else if (item.source === 'tool') {
          const call = calls.filter(a => a.time >= t - 120_000 && a.time <= t + 5_000).sort((a, b) => Math.abs(a.time - t) - Math.abs(b.time - t))[0]
          if (!call) continue
          chat = chatOfKey(call.session_key!.replace(/~\d+$/, ''))
          rows = this.store.transcript(chat, t - 30 * 60_000, t + 60_000).slice(-11)
        }
        if (!chat || !rows.length) continue
        this.store.addAnchor({ memoryId: item.id, chat, fromId: rows[0].id, toId: rows[rows.length - 1].id, focus, guessed: true })
        ok++
      }
    }
    writeFileSync(flag, JSON.stringify({ at: new Date().toISOString(), total, ok }))
    this.logger.info('老记忆推测出处：%d 条里找到 %d 条', total, ok)
  }

  private toItem(r: any): MemoryItem {
    const meta = r.metadata ?? {}
    return {
      id: r.id, scope: r.userId ?? r.user_id ?? meta.user_id, memory: r.memory, score: r.score,
      createdAt: r.createdAt ?? r.created_at, updatedAt: r.updatedAt ?? r.updated_at,
      source: meta.source, group: meta.group, reporter: meta.reporter,
    }
  }

  /** 原样记下一条（工具 / 看板手动添加用），同时记下归属人和出处。 */
  async remember(scope: string, text: string, source = 'manual', links: MemoryLinks = {}): Promise<MemoryItem[]> {
    const memory = await this.ready
    const metadata = { source, ...(links.reporter ? { reporter: links.reporter } : {}) }
    const res = await memory.add(text, { userId: scope, infer: false, metadata })
    const items: MemoryItem[] = (res.results ?? []).map((r: any) => this.toItem({ ...r, userId: scope, metadata }))
    for (const item of items) {
      try {
        if (links.subjects?.length) this.store.setSubjects(item.id, links.subjects)
        const window = links.anchor && this.store.turnWindow(links.anchor.chat, links.anchor.turn)
        if (window) this.store.addAnchor({ memoryId: item.id, chat: links.anchor!.chat, ...window, turn: links.anchor!.turn })
      } catch (e) {
        this.logger.warn('记录记忆归属 / 出处失败：%s', (e as Error).message)
      }
    }
    return items
  }

  /**
   * 记忆梳理：把一个人这一批的发言（user）和她回 TA 的话（assistant）交给 mem0 提取画像和偏好（infer 模式，会调用 DeepSeek），
   * 每条新记忆的出处记成这一批原文；返回新增条数。私聊时 groupId 为空
   */
  async digest(scope: string, groupId: string | undefined, messages: { role: 'user' | 'assistant', content: string }[], anchor: { chat: string, fromId: number, toId: number, focus: string }): Promise<number> {
    const memory = await this.ready
    const metadata = { source: 'digest', ...(groupId ? { group: groupId } : {}) }
    const res = await memory.add(messages, { userId: scope, infer: true, metadata })
    const results = res?.results ?? []
    for (const r of results) {
      try {
        this.store.addAnchor({ memoryId: r.id, ...anchor })
      } catch (e) {
        this.logger.warn('记录梳理出处失败：%s', (e as Error).message)
      }
    }
    return results.length
  }

  /**
   * 按人检索：TA 自己名下的，加上 groupScopes 里挂到 TA 身上的群记忆；不受 minScore 过滤（保底召回）。
   */
  async searchPerson(userId: string, groupScopes: string[], query: string, limit: number, audit?: RecallContext, publicOnly = false): Promise<MemoryItem[]> {
    if (!query.trim() || limit <= 0) return []
    const memory = await this.ready
    const about = new Set(this.store.memoriesAbout(userId))
    const scope = `user:${userId}`
    // 只要群聊来源的：多取一些再过滤
    const own = memory.search(query, { filters: { user_id: scope }, topK: publicOnly ? limit * 4 : limit })
      .then((res: any) => (res.results ?? []).map((r: any) => this.toItem({ ...r, userId: scope })))
    const tagged = about.size ? groupScopes.map(group => memory.search(query, { filters: { user_id: group }, topK: Math.max(limit * 4, 20) })
      .then((res: any) => (res.results ?? []).filter((r: any) => about.has(r.id)).map((r: any) => this.toItem({ ...r, userId: group })))) : []
    const items = (await Promise.all([own, ...tagged])).flat()
      .filter((m: MemoryItem) => !publicOnly || !this.isPrivate(m))
      .sort((a: MemoryItem, b: MemoryItem) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit)
    this.audit(items, query, audit)
    return items
  }

  /**
   * 这条记忆是不是私聊里来的（私聊内容不进画像，也不带进别人的对话）：
   * 梳理时没有群；出处全在私聊；她用工具记的却找不到出处（来源不明，保守算私聊）。手动添加、旧版迁移的不算。
   */
  isPrivate(item: MemoryItem) {
    if (item.scope.startsWith('group:')) return false
    if (item.source === 'digest') return !item.group
    const anchors = this.store.anchorsOf(item.id)
    if (anchors.length) return anchors.every(a => a.chat.startsWith('user:'))
    return item.source === 'tool' || item.source === 'auto'
  }

  private audit(items: MemoryItem[], query: string, audit?: RecallContext) {
    if (!audit || !items.length) return
    try {
      this.store.logRecalls(items.map(m => ({ memoryId: m.id, ...audit, query: query.slice(0, 200), score: m.score })))
    } catch (e) {
      this.logger.warn('记录召回审计失败：%s', (e as Error).message)
    }
  }

  /**
   * 在多个作用域里按语义检索，合并后按相关度排序；低于 minScore 的丢掉。
   * 传了 audit 就把这次召回记进审计表（看板里能看到每条记忆被召回几次、在哪个会话）。
   */
  async search(scopes: string[], query: string, limit: number, audit?: RecallContext): Promise<MemoryItem[]> {
    if (!query.trim()) return []
    const memory = await this.ready
    const all = await Promise.all(scopes.map(async (scope): Promise<MemoryItem[]> => {
      const res = await memory.search(query, { filters: { user_id: scope }, topK: limit })
      return (res.results ?? []).map((r: any) => this.toItem({ ...r, userId: scope }))
    }))
    const items = all.flat()
      .filter(m => (m.score ?? 1) >= this.settings.minScore)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit)
    this.audit(items, query, audit)
    return items
  }

  async list(scope: string): Promise<MemoryItem[]> {
    const memory = await this.ready
    const res = await memory.getAll({ filters: { user_id: scope }, topK: 1000 })
    return (res.results ?? []).map((r: any) => this.toItem({ ...r, userId: scope }))
  }

  async get(id: string): Promise<MemoryItem | undefined> {
    const memory = await this.ready
    const r = await memory.get(id)
    return r ? this.toItem(r) : undefined
  }

  /** id 可以是完整 id 或前 8 位（给模型看的是短 id），只在给定作用域里查找。 */
  async resolve(scopes: string[], id: string): Promise<MemoryItem | undefined> {
    if (id.length > 8) {
      const item = await this.get(id).catch((): undefined => undefined)
      return item && scopes.includes(item.scope) ? item : undefined
    }
    for (const scope of scopes) {
      const hit = (await this.list(scope)).find(m => m.id.startsWith(id))
      if (hit) return hit
    }
  }

  async update(id: string, text: string) {
    const memory = await this.ready
    await memory.update(id, { text })
  }

  async delete(id: string) {
    const memory = await this.ready
    await memory.delete(id)
    this.store.deleteMemoryLinks(id)
  }
}

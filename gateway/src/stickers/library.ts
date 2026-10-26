import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Context } from 'koishi'
import { ROOT, profilePath, type Config } from '../config.js'
import type { Store } from '../../../shared/store.mjs'
import { cosine, embed } from '../embedder.js'
import { registerOptionSource } from '../config-options.js'
import {
  applyStickerPatch, loadStickerStore, normalizeStickerEntry, sanitizeList, sanitizeStickerText, saveStickerStore, stickerText,
  type StickerEntry, type StickerPatch, type StickerSource,
} from './sticker-lib.js'

/** 认知层：笔记、标签、题材、开关，以及收藏 / 导入的表情本身（在角色包里，随私有仓库走） */
const LIBRARY_FILE = () => profilePath('assets/stickers/library.json')
/** 收藏 / 导入的图片存这里 */
const COLLECTED_DIR = 'assets/stickers/collected'
/** 向量缓存（运行数据，按文本哈希失效） */
const VECTORS_FILE = resolve(ROOT, 'data/stickers/vectors.json')
const MAX_BYTES = 10 * 1024 * 1024
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i

/**
 * 发送过滤器：表情必须通过所有过滤器才会被检索到、发出去。看板列表和审核不受影响。
 * 对修改关闭、对扩展开放：新增规则（比如按群、按时间段）只需要 registerStickerFilter，不用改检索代码。
 */
export type StickerFilter = (entry: StickerEntry, settings: Config['stickers']) => boolean
const filters = new Map<string, StickerFilter>()
export function registerStickerFilter(name: string, filter: StickerFilter) {
  filters.set(name, filter)
}
registerStickerFilter('enabled', e => !e.disabled)
registerStickerFilter('reviewed', (e, s) => !s.requireReview || e.reviewed)
registerStickerFilter('subjects', (e, s) => !s.allowSubjects.length || subjectsOf(e, s).some(x => s.allowSubjects.includes(x)))

/** 实际题材：表情索引和手动目录的表情没单独标时用配置里的默认值（实时读配置，改了马上生效） */
export function subjectsOf(e: StickerEntry, s: Config['stickers']) {
  return e.subjects.length || (e.source !== 'archive' && e.source !== 'manual') ? e.subjects : s.defaultSubjects
}

/** 收藏 / 导入的输入（agent 工具和看板走同一个流程） */
export interface IngestInput {
  /** 图片字节或本地文件 */
  data?: Buffer
  path?: string
  desc: string
  tags: string[] | string
  subjects?: string[] | string
  usage?: string
  localNote?: string
  source: Extract<StickerSource, 'collected' | 'imported'>
  addedBy: string
}

export interface ScoredSticker {
  entry: StickerEntry
  score: number
}

/** 原来的关键词打分（保留，作为语义检索之外的加分）：命中标签 +3，命中文字 +2，双字片段重合各 +0.5 */
function keywordScore(e: StickerEntry, terms: string[]) {
  const text = stickerText(e)
  let score = 0
  for (const term of terms) {
    if (e.tags.includes(term)) score += 3
    else if (text.includes(term)) score += 2
    else for (let i = 0; i + 2 <= term.length; i++) if (text.includes(term.slice(i, i + 2))) score += 0.5
  }
  return score
}

function imageType(data: Buffer) {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (data[0] === 0xff && data[1] === 0xd8) return 'jpg'
  if (data.subarray(0, 4).toString('ascii') === 'GIF8') return 'gif'
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  return ''
}

const md5 = (data: Buffer) => createHash('md5').update(data).digest('hex')

/**
 * 表情包库：合并四个来源，提供检索、挑图、收藏 / 导入、修改。
 * - archive：表情索引（配置 stickers.archiveDir 下的 index.json，列出图片、说明和标签）
 * - manual：assets/stickers/<标签>/<说明>.png，目录名当标签、文件名当说明
 * - collected：她在聊天里用 collect_sticker 收藏的
 * - imported：主人在看板导入的
 * 前两个来源的文件不动，修改只写进认知层；后两个整条存在认知层里。
 */
export class StickerLibrary {
  private entries: StickerEntry[] = []
  private overlay = new Map<string, StickerEntry>()
  private vectors: Record<string, { h: string, v: number[] }> = {}
  private md5Index?: Map<string, string>
  private writable = true
  private logger

  constructor(ctx: Context, private store: Store, private config: Config) {
    this.logger = ctx.logger('stickers')
    this.reload()
    // 看板里「选题材」的字段：库里出现过的题材 + 配置里已经写了的
    registerOptionSource('subjects', () => {
      const count = new Map<string, number>()
      for (const e of this.entries) for (const s of subjectsOf(e, this.settings)) count.set(s, (count.get(s) ?? 0) + 1)
      for (const s of [...this.settings.allowSubjects, ...this.settings.defaultSubjects]) if (!count.has(s)) count.set(s, 0)
      return [...count].sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, label: value, desc: `${n} 张表情` }))
    })
    try {
      if (existsSync(VECTORS_FILE)) this.vectors = JSON.parse(readFileSync(VECTORS_FILE, 'utf8'))
    } catch {}
    // 向量在后台补齐，没算完之前检索退回关键词打分
    this.ensureVectors().catch(e => this.logger.warn('表情向量化失败：%s', (e as Error).message))
  }

  private get settings() {
    return this.config.stickers
  }

  /** 重新读取来源和认知层 */
  reload() {
    try {
      this.overlay = new Map(loadStickerStore(LIBRARY_FILE()).map(e => [e.id, e]))
      this.writable = true
    } catch (e) {
      // 认知层读坏了就只读运行，不覆盖
      this.logger.error('%s', (e as Error).message)
      this.writable = false
    }
    const base: StickerEntry[] = []
    const archive = this.settings.archiveDir.replace(/\\/g, '/').replace(/\/$/, '')
    const index = profilePath(archive, 'index.json')
    if (existsSync(index)) {
      for (const s of JSON.parse(readFileSync(index, 'utf8')).stickers ?? []) {
        if (s.local) base.push(normalizeStickerEntry({ id: `archive:${s.local}`, file: `${archive}/${s.local}`, desc: s.alt, tags: s.tags, source: 'archive' })!)
      }
    }
    const dir = profilePath('assets/stickers')
    for (const tag of existsSync(dir) ? readdirSync(dir) : []) {
      if (tag === 'collected' || !statSync(join(dir, tag)).isDirectory()) continue
      for (const f of readdirSync(join(dir, tag))) {
        if (IMAGE_EXT.test(f)) base.push(normalizeStickerEntry({ id: `manual:${tag}/${f}`, file: `assets/stickers/${tag}/${f}`, desc: f.replace(/\.[^.]+$/, ''), tags: [tag], source: 'manual' })!)
      }
    }
    // 来源里的条目叠加认知层的修改；收藏 / 导入的整条来自认知层
    const merged = base.map((b) => {
      const o = this.overlay.get(b.id)
      return o ? { ...o, file: b.file, source: b.source, desc: o.desc || b.desc, tags: o.tags.length ? o.tags : b.tags } : b
    })
    const extra = [...this.overlay.values()].filter(e => (e.source === 'collected' || e.source === 'imported') && existsSync(profilePath(e.file)))
    this.entries = [...merged, ...extra]
    this.md5Index = undefined
  }

  /** 全部条目（看板用），附使用次数 */
  list() {
    const stats = new Map(this.store.stickerUseStats().map(s => [s.stickerId, s]))
    return this.entries.map(e => ({
      ...e, subjects: subjectsOf(e, this.settings), uses: stats.get(e.id)?.count ?? 0, lastUsed: stats.get(e.id)?.last ?? null, sendable: this.passes(e),
    }))
  }

  get(id: string) {
    return this.entries.find(e => e.id === id)
  }

  /** 所有标签（给工具描述用） */
  tags() {
    return [...new Set(this.entries.filter(e => this.passes(e)).flatMap(e => e.tags))]
  }

  private passes(e: StickerEntry) {
    for (const f of filters.values()) if (!f(e, this.settings)) return false
    return true
  }

  /** 语义检索 + 关键词加分；all = true 时不过滤（看板测试检索用） */
  async search(query: string, { limit = 20, all = false } = {}): Promise<ScoredSticker[]> {
    const terms = query.split(/[\s,，、]+/).filter(Boolean)
    const pool = all ? this.entries : this.entries.filter(e => this.passes(e))
    const [q] = await embed([query]).catch((): number[][] => [])
    return pool
      .map((entry) => {
        const v = this.vectors[entry.id]?.v
        // 语义相似度为主，关键词命中作为加分；向量还没算出来时只靠关键词
        const semantic = q && v ? cosine(q, v) : 0
        return { entry, score: semantic + keywordScore(entry, terms) * 0.03 }
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  /** 给 agent 挑一张：在得分接近的几张里随机，避开这个会话最近发过的；记一次使用 */
  async pick(query: string, sessionKey: string, userId?: string) {
    const ranked = await this.search(query, { limit: 30 })
    if (!ranked.length) return null
    const recent = new Set(this.store.recentStickers(sessionKey, 10))
    const fresh = ranked.filter(x => !recent.has(x.entry.id))
    const list = fresh.length ? fresh : ranked
    const pool = list.filter(x => x.score >= list[0].score - 0.03).slice(0, 6)
    const { entry } = pool[Math.floor(Math.random() * pool.length)]
    this.store.logStickerUse(entry.id, sessionKey, userId, query.slice(0, 100))
    return entry
  }

  /**
   * 标准收藏流程（agent 和看板都走这里）：校验图片 → 去重 → 消毒文本 → 存文件 → 写认知层 → 向量化。
   * 重复的图片不新增，返回已有的那条。
   */
  async ingest(input: IngestInput): Promise<{ entry: StickerEntry, duplicate: boolean }> {
    if (!this.writable) throw new Error('表情库文件读取失败，暂时不能新增')
    const data = input.data ?? readFileSync(input.path!)
    if (data.length > MAX_BYTES) throw new Error('图片超过 10MB')
    const ext = imageType(data)
    if (!ext) throw new Error('不是 png / jpg / gif / webp 图片')
    const desc = sanitizeStickerText(input.desc, 200)
    const tags = sanitizeList(input.tags, 10)
    if (!desc) throw new Error('要写一句说明：图里是什么、表达什么情绪')
    if (!tags.length) throw new Error('至少要一个标签')

    const hash = md5(data)
    const existing = this.findByMd5(hash)
    if (existing) return { entry: existing, duplicate: true }

    const file = `${COLLECTED_DIR}/${hash}.${ext}`
    mkdirSync(profilePath(COLLECTED_DIR), { recursive: true })
    writeFileSync(profilePath(file), data)
    const entry = normalizeStickerEntry({
      id: hash, file, md5: hash, desc, tags,
      subjects: input.subjects, usage: input.usage, localNote: input.localNote,
      source: input.source, addedBy: input.addedBy,
      // 看板导入的直接可用；agent 收藏的按配置决定要不要审核
      reviewed: input.source === 'imported' || !this.settings.requireReview,
    })!
    this.overlay.set(entry.id, entry)
    this.persist()
    this.reload()
    await this.ensureVectors()
    this.logger.info('新增表情（%s，%s）：%s', input.source, input.addedBy, desc)
    return { entry, duplicate: false }
  }

  /** 修改笔记、标签、题材、开关、审核（来源文件不动，只写认知层） */
  async update(id: string, patch: StickerPatch) {
    if (!this.writable) throw new Error('表情库文件读取失败，暂时不能修改')
    const current = this.get(id)
    if (!current) throw new Error('没有这张表情')
    this.overlay.set(id, applyStickerPatch(current, patch))
    this.persist()
    this.reload()
    await this.ensureVectors()
    return this.get(id)!
  }

  /** 只能删除收藏 / 导入的；表情索引和手动目录里的只能禁用 */
  remove(id: string) {
    const e = this.get(id)
    if (!e) throw new Error('没有这张表情')
    if (e.source !== 'collected' && e.source !== 'imported') throw new Error('表情索引和手动目录里的表情不能删，可以禁用')
    this.overlay.delete(id)
    this.persist()
    try { unlinkSync(profilePath(e.file)) } catch {}
    this.reload()
  }

  private findByMd5(hash: string) {
    if (!this.md5Index) {
      this.md5Index = new Map()
      for (const e of this.entries) {
        try {
          this.md5Index.set(e.md5 || md5(readFileSync(profilePath(e.file))), e.id)
        } catch {}
      }
    }
    const id = this.md5Index.get(hash)
    return id ? this.get(id) : undefined
  }

  private persist() {
    saveStickerStore(LIBRARY_FILE(), [...this.overlay.values()])
  }

  /** 补算缺失或文本已变的向量 */
  private async ensureVectors() {
    const todo = this.entries.filter(e => this.vectors[e.id]?.h !== md5(Buffer.from(stickerText(e))))
    if (!todo.length) return
    for (let i = 0; i < todo.length; i += 32) {
      const batch = todo.slice(i, i + 32)
      const vecs = await embed(batch.map(stickerText))
      batch.forEach((e, j) => { this.vectors[e.id] = { h: md5(Buffer.from(stickerText(e))), v: vecs[j] } })
    }
    mkdirSync(resolve(ROOT, 'data/stickers'), { recursive: true })
    writeFileSync(VECTORS_FILE, JSON.stringify(this.vectors))
    this.logger.info('表情向量化完成：%d 张', todo.length)
  }
}

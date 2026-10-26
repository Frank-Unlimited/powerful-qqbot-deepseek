/**
 * 表情包知识库的纯函数：字段归一化、文本消毒、笔记更新、库文件读写、发表情策略提示。
 *
 * 基于 qq-bridge 的 src/sticker-lib.js 二次开发（https://github.com/Derpyu520/qq-bridge）：
 *   Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors，MIT License
 * 改动：表情来源从「QQ 收藏表情」换成本项目的四种来源（表情索引、手动目录、收藏、导入），
 * 增加 subjects（画的是谁）、reviewed（收藏的表情要审核）、disabled；使用次数改记在 SQLite 里（见 library.ts）。
 * 设计沿用原项目：来源是"源"，本地库是"认知层"——源里的说明不覆盖，AI / 主人补充的理解写在 localNote / tags / usage。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

export type StickerSource = 'archive' | 'manual' | 'collected' | 'imported'

export interface StickerEntry {
  /** archive:<文件> / manual:<标签>/<文件> / md5（收藏、导入） */
  id: string
  /** 图片路径，相对角色包目录 */
  file: string
  md5: string
  /** 来源自带的说明（表情索引说明、手动目录的文件名、收藏时写的描述） */
  desc: string
  /** AI 或主人补充的理解 */
  localNote: string
  tags: string[]
  /** 画的是谁 / 属于哪个题材，例如 deepseek；发送时可以按它过滤 */
  subjects: string[]
  /** 什么时候用 */
  usage: string
  source: StickerSource
  /** 收藏来的表情默认待审核，审核前不会被发出去 */
  reviewed: boolean
  disabled: boolean
  /** 谁加进来的：dashboard / 用户 openid */
  addedBy: string
  createdAt: string
  updatedAt: string
}

/** 按码点截断，不切开代理对 */
function truncate(text: string, max: number) {
  const chars = Array.from(text)
  return chars.length > max ? chars.slice(0, max).join('') : text
}

/**
 * 单行化表情库里的自由文本（说明 / 笔记 / 标签 / 用途）。
 * 这些字段会注入到每个会话的工具结果里；收藏工具的内容又可能来自群友诱导，
 * 压平换行、去掉控制字符和零宽字符后，注入内容就没法伪造出新的段落来冒充指令。
 */
/** 空白类字符（换行、制表、不换行空格、全角空格）压成一个空格；控制字符和零宽字符直接去掉 */
const cp = (...codes: number[]) => String.fromCodePoint(...codes)
const range = (a: number, b: number) => `${cp(a)}-${cp(b)}`
const SPACES = new RegExp(`[\\s${cp(0xa0, 0x3000)}]+`, 'g')
const INVISIBLE = new RegExp(`[${range(0x00, 0x1f)}${range(0x7f, 0x9f)}${range(0x200b, 0x200f)}${cp(0x2028, 0x2029, 0xfeff)}]`, 'g')

export function sanitizeStickerText(value: unknown, max = 200) {
  const cleaned = String(value ?? '')
    .replace(SPACES, ' ')
    .replace(INVISIBLE, '')
    .trim()
  return truncate(cleaned, Math.max(1, max))
}

export function sanitizeList(value: unknown, maxItems = 12, maxLen = 24) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,，、\s]+/)
  return [...new Set(list.map(t => sanitizeStickerText(t, maxLen)).filter(Boolean))].slice(0, maxItems)
}

const SOURCES: StickerSource[] = ['archive', 'manual', 'collected', 'imported']

export function normalizeStickerEntry(raw: any): StickerEntry | null {
  const e = raw && typeof raw === 'object' ? raw : {}
  const id = String(e.id ?? '').trim()
  const file = String(e.file ?? '').trim()
  if (!id || !file) return null
  const now = new Date().toISOString()
  const source: StickerSource = SOURCES.includes(e.source) ? e.source : 'collected'
  return {
    id,
    file,
    md5: String(e.md5 ?? '').trim().toLowerCase(),
    desc: sanitizeStickerText(e.desc, 200),
    localNote: sanitizeStickerText(e.localNote, 200),
    tags: sanitizeList(e.tags, 20),
    subjects: sanitizeList(e.subjects, 8),
    usage: sanitizeStickerText(e.usage, 200),
    source,
    // 表情索引和手动目录是主人自己放的，视为已审核
    reviewed: e.reviewed ?? (source === 'archive' || source === 'manual' || source === 'imported'),
    disabled: Boolean(e.disabled),
    addedBy: sanitizeStickerText(e.addedBy, 64),
    createdAt: String(e.createdAt || now),
    updatedAt: String(e.updatedAt || now),
  }
}

/** 笔记 / 标签 / 题材 / 用途 / 开关的修改（AI 和看板共用） */
export interface StickerPatch {
  desc?: string
  localNote?: string
  tags?: string[] | string
  subjects?: string[] | string
  usage?: string
  disabled?: boolean
  reviewed?: boolean
}

export function applyStickerPatch(entry: StickerEntry, patch: StickerPatch): StickerEntry {
  return normalizeStickerEntry({
    ...entry,
    ...(patch.desc !== undefined ? { desc: patch.desc } : {}),
    ...(patch.localNote !== undefined ? { localNote: patch.localNote } : {}),
    ...(patch.tags !== undefined ? { tags: sanitizeList(patch.tags, 20) } : {}),
    ...(patch.subjects !== undefined ? { subjects: sanitizeList(patch.subjects, 8) } : {}),
    ...(patch.usage !== undefined ? { usage: patch.usage } : {}),
    ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
    ...(patch.reviewed !== undefined ? { reviewed: patch.reviewed } : {}),
    updatedAt: new Date().toISOString(),
  })!
}

/** 检索 / 向量化用的文本 */
export function stickerText(e: StickerEntry) {
  return [e.desc, e.localNote, e.usage, e.tags.join(' ')].filter(Boolean).join(' ')
}

/**
 * 读认知层文件。「文件不存在」和「读坏了」必须分开：读坏了还按空库继续，
 * 下次保存就会把积累的笔记、标签全部清零。
 */
export function loadStickerStore(file: string): StickerEntry[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e: any) {
    if (e?.code === 'ENOENT') return []
    throw new Error(`表情库读取失败（${e?.message ?? e}）`)
  }
  try {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) throw new Error('顶层不是数组')
    return parsed.map(normalizeStickerEntry).filter((x): x is StickerEntry => Boolean(x))
  } catch (e: any) {
    throw new Error(`表情库内容损坏（${e?.message ?? e}），已拒绝按空库继续以免覆盖已有内容`)
  }
}

/** 先写临时文件再改名，写到一半失败不会留下半个文件 */
export function saveStickerStore(file: string, entries: StickerEntry[]) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (e) {
    try { unlinkSync(tmp) } catch {}
    throw e
  }
}

/**
 * 发表情的策略（写进 send_sticker 的工具描述；描述每轮不变，不影响缓存）。
 * 来自 qq-bridge 的「真人发表情包」策略：回表情是互惠动作、斗图可以连着来但要收、别总用同一张。
 */
export const STICKER_STRATEGY = [
  '像真人一样用表情包，别当装饰：接梗、吐槽、赞同、自嘲、安慰、无语、被戳中、告别晚安时可以来一张；严肃、正式、敏感的话题不发。',
  '别人冲你发表情时，大多数时候回一张，可以只发表情不配字；对方连着发表情是在斗图，可以接两三轮，对方停你也停。',
  '一轮最多一张，普通闲聊三五轮一张就够；用心描述这一刻的情绪和场景去检索，别总想着同一张。',
].join('')

import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from 'koishi'
import { ROOT } from '../config.js'
import type { Store } from '../../../shared/store.mjs'

const MAX_BYTES = 8 * 1024 * 1024
const KEEP_DAYS = 7
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

/**
 * 图片暂存：收到的图片先下载到本地并编号，消息里只放占位符「[图片#12]」，
 * 模型需要时才用 look_image 工具去看。QQ 的图片链接几小时后会失效，所以收到就下载。
 */
export class ImageStash {
  private dir = resolve(ROOT, 'data/images')
  private logger

  constructor(ctx: Context, private store: Store) {
    this.logger = ctx.logger('images')
    mkdirSync(this.dir, { recursive: true })
    const prune = () => {
      for (const file of this.store.pruneImages(KEEP_DAYS * 86400_000)) rmSync(file, { force: true })
    }
    ctx.on('ready', prune)
    ctx.setInterval(prune, 6 * 3600_000)
  }

  /** 下载并登记，返回占位文本，例如 " [图片#3] [图片#4]"；下载失败的写成 [图片(已失效)]。 */
  async stash(sessionKey: string, urls: string[], sender: string) {
    const tags = await Promise.all(urls.map(async (url) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = Buffer.from(await res.arrayBuffer())
        if (data.length > MAX_BYTES) throw new Error('图片过大')
        const ext = EXT[res.headers.get('content-type')?.split(';')[0] ?? ''] ?? 'jpg'
        const file = resolve(this.dir, `${randomUUID()}.${ext}`)
        writeFileSync(file, data)
        return `[图片#${this.store.addImage(sessionKey, file, sender)}]`
      } catch (e) {
        this.logger.warn('图片下载失败 %s: %s', url, (e as Error).message)
        return '[图片(已失效)]'
      }
    }))
    return tags.length ? ` ${tags.join(' ')}` : ''
  }
}

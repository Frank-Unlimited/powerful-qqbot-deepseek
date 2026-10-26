import { Context } from 'koishi'
import type { Store } from '../../../shared/store.mjs'
import type { StickerLibrary } from './library.js'

/**
 * 表情包接口。两类调用方，共用 StickerLibrary 的同一套流程（检索、收藏、修改）：
 * - 看板（/api/stickers/*）：主人浏览、测试检索、导入、编辑、审核
 * - dsh 插件（/internal/stickers/*）：agent 挑图、收藏；身份由网关按"当前发言人"决定，插件只传会话 id
 */
export function stickerRoutes(ctx: Context, library: StickerLibrary, store: Store) {
  const router = ctx.server
  const logger = ctx.logger('stickers')
  const fail = (koa: any, message: string) => {
    koa.status = 400
    koa.body = { error: message }
  }

  // ---- 看板 ----
  router.get('/api/stickers', async (koa) => {
    const q = String(koa.query.q ?? '').trim()
    if (!q) return void (koa.body = { items: library.list() })
    // 测试检索：不过滤，显示每张的得分和能不能发
    const scored = await library.search(q, { limit: 40, all: true })
    const list = new Map(library.list().map(e => [e.id, e]))
    koa.body = { items: scored.map(s => ({ ...list.get(s.entry.id), score: s.score })) }
  })

  router.get('/api/stickers/uses', (koa) => {
    koa.body = store.stickerUsesOf(String(koa.query.id ?? ''))
  })

  router.post('/api/stickers/import', async (koa) => {
    const files = (koa.request as any).files?.file
    const list = (Array.isArray(files) ? files : files ? [files] : []) as { filepath: string, originalFilename?: string }[]
    const { desc, tags, subjects, usage } = (koa.request as any).body ?? {}
    if (!list.length) return fail(koa, '没有选图片')
    const results = []
    for (const f of list) {
      try {
        // 多张一起导入时，没写说明就用文件名
        const r = await library.ingest({
          path: f.filepath, desc: desc || (f.originalFilename ?? '').replace(/\.[^.]+$/, ''),
          tags, subjects, usage, source: 'imported', addedBy: 'dashboard',
        })
        results.push({ name: f.originalFilename, id: r.entry.id, duplicate: r.duplicate })
      } catch (e) {
        results.push({ name: f.originalFilename, error: (e as Error).message })
      }
    }
    koa.body = { results }
  })

  router.put('/api/stickers/:id', async (koa) => {
    try {
      koa.body = await library.update(decodeURIComponent(koa.params.id), (koa.request as any).body ?? {})
    } catch (e) {
      fail(koa, (e as Error).message)
    }
  })

  router.delete('/api/stickers/:id', (koa) => {
    try {
      library.remove(decodeURIComponent(koa.params.id))
      koa.body = { ok: true }
    } catch (e) {
      fail(koa, (e as Error).message)
    }
  })

  // ---- dsh 插件 ----
  const internal = (handler: (body: any) => Promise<unknown>) => async (koa: any) => {
    try {
      koa.body = { ok: true, result: await handler(koa.request.body ?? {}) }
    } catch (e) {
      koa.body = { ok: false, error: (e as Error).message }
    }
  }
  /** dsh 会话 id 是 <会话键>~<代数> */
  const sessionKeyOf = (sessionId: string) => String(sessionId).replace(/~\d+$/, '')

  router.post('/internal/stickers/pick', internal(async ({ sessionId, query }) => {
    const entry = await library.pick(String(query ?? ''), sessionKeyOf(sessionId), store.turn(sessionId)?.userId)
    return entry ? { id: entry.id, file: entry.file, desc: entry.localNote || entry.desc } : null
  }))

  router.post('/internal/stickers/collect', internal(async ({ sessionId, image, desc, tags, subjects, usage }) => {
    const turn = store.turn(sessionId)
    const img = store.image(Number(image))
    // 只能收藏本群 / 本私聊里出现过的图片
    if (!img || img.session_key !== sessionKeyOf(sessionId)) throw new Error(`没有编号 ${image} 的图片`)
    const { entry, duplicate } = await library.ingest({
      path: img.file, desc, tags, subjects, usage, source: 'collected', addedBy: turn?.userId ?? '',
    })
    logger.info('%s 收藏表情 %s', sessionKeyOf(sessionId), entry.id)
    return { duplicate, reviewed: entry.reviewed, desc: entry.desc }
  }))
}

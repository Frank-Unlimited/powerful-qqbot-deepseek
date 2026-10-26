/**
 * 视频链接解析：抖音、B 站和白名单网站的视频，下载成本地 mp4，由 send_video 工具放进发件箱、跟她的回复一起发出去。
 * - 工具：dsh 插件调 /internal/video/fetch，网关解析 + 下载，返回本地文件和视频信息
 * - 自动解析（video.auto）：群里出现视频链接时，桥接让她跑一轮并提示调用 send_video（见 bridge/index.ts）
 *
 * 同时只下载一个；同一个会话同一个视频 dedupeMin 分钟内只发一次。
 * 下载目录 data/cache/video 只是中转：每次下载前删掉 1 小时前的文件和下载残留，总量超过 500 MB 从最旧的删。
 */
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Session } from 'koishi'
import { ROOT, type Config } from '../config.js'
import { findVideoLinks, type VideoLink } from './detect.js'
import { douyinInfo } from './douyin.js'
import { ffmpegAvailable, findYtdlp, ytdlpDownload, ytdlpInfo } from './ytdlp.js'
import type { VideoInfo } from './types.js'

const CACHE_DIR = resolve(ROOT, 'data/cache/video')
const STATS_FILE = resolve(ROOT, 'data/video-stats.json')
const CACHE_LIMIT = 500 * 1024 * 1024
const KEEP_MS = 3600_000

const duration = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

/** B 站短链（b23.tv、bili2233.cn）展开成视频页地址，去掉分享追踪参数，只留分 P */
async function expandShortLink(url: string, signal: AbortSignal) {
  if (!/\/\/(b23\.tv|bili2233\.cn)\//.test(url)) return url
  const res = await fetch(url, { redirect: 'manual', signal })
  const location = res.headers.get('location')
  if (!location) return url
  const target = new URL(location, url)
  const p = target.searchParams.get('p')
  target.search = p ? `?p=${p}` : ''
  if (!/\/video\/(BV|av)/i.test(target.pathname)) throw new Error('B 站短链指向的不是视频')
  return target.href
}

export class VideoService {
  private logger
  private queue: Promise<unknown> = Promise.resolve()
  /** `${会话键}|${视频 id}` → 上次发出的时间 */
  private sent = new Map<string, number>()
  private stats: { date: string, count: number }

  constructor(ctx: Context, private config: Config) {
    this.logger = ctx.logger('video')
    mkdirSync(CACHE_DIR, { recursive: true })
    try {
      this.stats = JSON.parse(readFileSync(STATS_FILE, 'utf8'))
    } catch {
      this.stats = { date: today(), count: 0 }
    }
    this.sweep()
    // 启动时检查一次依赖，缺了只在日志里提示
    findYtdlp().then((cmd) => {
      if (!cmd) this.logger.warn('没找到 yt-dlp（pip install yt-dlp），B 站和其他网站的视频解析不可用，抖音照常')
      else if (!ffmpegAvailable()) this.logger.warn('没找到 ffmpeg（ffmpeg-static 没装好），B 站等需要合并音视频的视频下载不了')
    })
  }

  /** 今天发出去的视频数（看板侧边栏用） */
  todayCount() {
    return this.stats.date === today() ? this.stats.count : 0
  }

  /** 自动解析：这条消息里要不要让她发视频（开关、群范围都在这里判断） */
  autoLinks(session: Session, text: string): VideoLink[] {
    const s = this.config.video
    if (!s.enabled || !s.auto) return []
    if (!session.isDirect && s.groups.length && !s.groups.includes(session.guildId)) return []
    return findVideoLinks(text, session.elements ?? [], s)
  }

  /** 工具调用：解析 + 下载。sessionKey 用于去重；返回本地文件（file:// 地址）和给她看的说明 */
  async fetch(url: string, sessionKey: string): Promise<{ src: string, note: string }> {
    const s = this.config.video
    if (!s.enabled) throw new Error('视频功能已被主人关闭')
    const [link] = findVideoLinks(String(url ?? ''), [], s)
    if (!link) throw new Error('不是支持的视频链接（支持抖音、B 站，以及看板里列出的其他网站）')
    const info = await this.resolveInfo(link)
    const key = `${sessionKey}|${info.id}`
    const last = this.sent.get(key)
    if (last && Date.now() - last < s.dedupeMin * 60_000) throw new Error('这个视频刚刚已经发过了，不用再发')
    if (s.maxDurationMin > 0 && info.durationSec > s.maxDurationMin * 60) {
      throw new Error(`视频太长了（${duration(info.durationSec)}，上限 ${s.maxDurationMin} 分钟），没下载`)
    }
    // 同时只下载一个
    const job = this.queue.then(() => this.download(info, s.maxSizeMB))
    this.queue = job.catch(() => {})
    const started = Date.now()
    const file = await job
    const mb = statSync(file).size / 1024 / 1024
    this.sent.set(key, Date.now())
    if (this.sent.size > 500) this.sent.delete(this.sent.keys().next().value!)
    this.count()
    this.logger.info('%s 下载视频 %s《%s》%s MB，用时 %d 秒', sessionKey, info.site, info.title.slice(0, 30), mb.toFixed(1), Math.round((Date.now() - started) / 1000))
    const by = info.author ? `，${info.platform === 'bilibili' ? 'UP主' : '作者'} ${info.author}` : ''
    const len = info.durationSec ? `，${duration(info.durationSec)}` : ''
    return { src: pathToFileURL(file).href, note: `已附上视频：${info.site}《${info.title.slice(0, 80)}》${by}${len}` }
  }

  private async resolveInfo(link: VideoLink): Promise<VideoInfo> {
    const signal = AbortSignal.timeout(40_000)
    if (link.platform === 'bilibili') return ytdlpInfo(await expandShortLink(link.url, signal), CACHE_DIR, signal)
    if (link.platform !== 'douyin') return ytdlpInfo(link.url, CACHE_DIR, signal)
    try {
      return await douyinInfo(link.url, signal)
    } catch (e) {
      // 网页接口被风控时，有 cookie 就换 yt-dlp 再试一次
      if (!process.env.DOUYIN_COOKIE?.trim()) throw e
      this.logger.info('抖音接口失败（%s），改用 yt-dlp', (e as Error).message)
      return ytdlpInfo(link.url, CACHE_DIR, AbortSignal.timeout(40_000))
    }
  }

  private async download(info: VideoInfo, maxMB: number): Promise<string> {
    this.sweep()
    const file = resolve(CACHE_DIR, `${info.id}.mp4`)
    const signal = AbortSignal.timeout(150_000)
    try {
      if (info.source.kind === 'ytdlp') {
        await ytdlpDownload(info, CACHE_DIR, maxMB, signal)
      } else {
        const res = await fetch(info.source.url, { headers: info.source.headers, signal })
        if (!res.ok) throw new Error(`下载失败（${res.status}）`)
        const declared = Number(res.headers.get('content-length')) || 0
        if (declared > maxMB * 1024 * 1024) throw new Error(`视频超过 ${maxMB} MB`)
        const data = Buffer.from(await res.arrayBuffer())
        if (data.length > maxMB * 1024 * 1024) throw new Error(`视频超过 ${maxMB} MB`)
        writeFileSync(file, data)
      }
    } catch (e) {
      // 失败时把这个视频下了一半的文件（音视频分片、临时文件）都删掉
      this.removeMatching(f => f.startsWith(`${info.id}.`))
      throw e
    }
    return file
  }

  /** 清理中转目录：1 小时前的文件全删（含下载残留），剩下的超过 500 MB（或两个最大视频的大小）从最旧的删 */
  private sweep() {
    const now = Date.now()
    const limit = Math.max(CACHE_LIMIT, this.config.video.maxSizeMB * 2 * 1024 * 1024)
    const files = readdirSync(CACHE_DIR).filter(f => !f.endsWith('-cookies.txt')).map((f) => {
      const path = resolve(CACHE_DIR, f)
      try {
        const st = statSync(path)
        return st.isFile() ? { path, size: st.size, mtime: st.mtimeMs } : null
      } catch {
        return null
      }
    }).filter((f): f is { path: string, size: number, mtime: number } => Boolean(f)).sort((a, b) => a.mtime - b.mtime)
    let total = files.reduce((sum, f) => sum + f.size, 0)
    for (const f of files) {
      if (now - f.mtime < KEEP_MS && total <= limit) break
      try {
        unlinkSync(f.path)
        total -= f.size
      } catch {}
    }
  }

  private removeMatching(match: (name: string) => boolean) {
    for (const f of readdirSync(CACHE_DIR).filter(match)) {
      try {
        unlinkSync(resolve(CACHE_DIR, f))
      } catch {}
    }
  }

  private count() {
    if (this.stats.date !== today()) this.stats = { date: today(), count: 0 }
    this.stats.count++
    try {
      writeFileSync(STATS_FILE, JSON.stringify(this.stats))
    } catch {}
  }
}

/** dsh 插件调用的接口：会话由网关按 sessionId 决定 */
export function videoRoutes(ctx: Context, videos: VideoService) {
  ctx.server.post('/internal/video/fetch', async (koa: any) => {
    const { sessionId, url } = koa.request.body ?? {}
    try {
      koa.body = { ok: true, result: await videos.fetch(url, String(sessionId).replace(/~\d+$/, '')) }
    } catch (e) {
      koa.body = { ok: false, error: (e as Error).message }
    }
  })
}

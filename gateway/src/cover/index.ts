/**
 * 翻唱：sing_cover 工具在本机把一首歌换成角色音色唱一段，作为语音跟她的回复一起发出去（spec：docs/spec-cover.md）。
 * - 找歌、下载在网关里做：B 站搜索接口挑原唱版，yt-dlp 只下音频
 * - 分离人声、RVC 换音色、混音交给翻唱进程（tools/cover/worker.py，独立的 Python 环境，用到时才启动，空闲自己退出）
 *
 * 同时只唱一首；整件事要在 QQ 被动回复的 5 分钟窗口内做完，所以每个请求有总时限。
 * 下载的原曲放 data/cache/cover/songs（按 BV 号复用），翻唱进程把分离结果缓存在 data/cache/cover/stems。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from 'koishi'
import ffmpegPath from 'ffmpeg-static'
import { ROOT, profilePath, type Config } from '../config.js'
import { cookieArgs, ffmpegAvailable, findYtdlp, run } from '../video/ytdlp.js'

const CACHE_DIR = resolve(ROOT, 'data/cache/cover')
const SONG_DIR = resolve(CACHE_DIR, 'songs')
const OUT_DIR = resolve(CACHE_DIR, 'out')
const STATS_FILE = resolve(ROOT, 'data/cover-stats.json')
const PYTHON = resolve(ROOT, 'tools/cover/.venv/Scripts/python.exe')
const WORKER = resolve(ROOT, 'tools/cover/worker.py')
const PORT = 5141
/** 一个请求从收到到唱完的总时限（工具超时 270 秒，留点余量给发件箱） */
const DEADLINE_MS = 255_000
/** 原曲缓存上限 */
const SONG_CACHE_BYTES = 1024 * 1024 * 1024
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`

interface Song { bvid: string, title: string, author: string, durationSec: number }

/** 标题里出现这些词多半不是原唱完整版 */
const BAD_WORDS = ['翻唱', 'cover', '伴奏', '纯音乐', 'dj', 'remix', 'live', '现场', '教学', '教程', '钢琴', '吉他', '鼓谱', '片段', 'reaction', '滚动的天空', '伴唱', '女声版', '男声版', '改编', '混剪', '串烧', '演奏', '指弹', '口琴', '古筝', '二胡', 'ai翻唱', '变声']
const GOOD_WORDS = ['原唱', '官方', 'mv', '完整版', '无损', 'hi-res', '高音质', '4k', '音源', '歌词']

/** "3:12" / "1:02:03" → 秒 */
function parseDuration(s: string) {
  return String(s).split(':').map(Number).reduce((sum, n) => sum * 60 + (Number.isFinite(n) ? n : 0), 0)
}

/** part 参数：副歌（默认）/ 开头 / 从某个时间开始 */
function parsePart(part: unknown): { mode: 'chorus' | 'start' } | { mode: 'at', sec: number } {
  const s = String(part ?? '').trim().toLowerCase()
  if (!s || /副歌|高潮|chorus/.test(s)) return { mode: 'chorus' }
  if (/开头|开始|前奏|第一段|start|intro/.test(s)) return { mode: 'start' }
  const m = s.match(/(\d+)\s*[:：分]\s*(\d{1,2})/) ?? s.match(/^(\d+)\s*(?:秒|s)?$/)
  if (m) return { mode: 'at', sec: m[2] !== undefined ? Number(m[1]) * 60 + Number(m[2]) : Number(m[1]) }
  return { mode: 'chorus' }
}

export class CoverService {
  private logger
  private queue: Promise<unknown> = Promise.resolve()
  private worker: ChildProcess | null = null
  private starting: Promise<void> | null = null
  private stats: { date: string, counts: Record<string, number> }

  constructor(private ctx: Context, private config: Config) {
    this.logger = ctx.logger('cover')
    mkdirSync(SONG_DIR, { recursive: true })
    mkdirSync(OUT_DIR, { recursive: true })
    try {
      this.stats = JSON.parse(readFileSync(STATS_FILE, 'utf8'))
    } catch {
      this.stats = { date: today(), counts: {} }
    }
    ctx.on('dispose', () => { this.worker?.kill() })
    if (config.cover.enabled) {
      const problem = this.problem()
      if (problem) this.logger.warn('翻唱不可用：%s', problem)
    }
  }

  /** 缺什么就返回原因；都齐了返回 null（dsh 启动时据此决定注册不注册工具） */
  problem(): string | null {
    if (!existsSync(PYTHON)) return '没装翻唱环境（tools/cover/.venv），见 tools/cover/README.md'
    if (!ffmpegAvailable()) return '找不到 ffmpeg'
    if (!this.model()) return `音色目录 ${this.config.cover.modelDir} 里没有 .pth 模型`
    return null
  }

  /** 音色目录里的 .pth 和 .index（index 可以没有） */
  private model(): { pth: string, index: string | null } | null {
    const dir = profilePath(this.config.cover.modelDir)
    if (!existsSync(dir)) return null
    const files = readdirSync(dir)
    const pth = files.find(f => f.toLowerCase().endsWith('.pth'))
    if (!pth) return null
    const index = files.find(f => f.toLowerCase().endsWith('.index'))
    return { pth: resolve(dir, pth), index: index ? resolve(dir, index) : null }
  }

  /** 工具调用：找歌、下载、交给翻唱进程，返回发件箱要的本地文件和给她看的说明 */
  async sing(songArg: unknown, partArg: unknown, sessionKey: string): Promise<{ src: string, note: string }> {
    const s = this.config.cover
    if (!s.enabled) throw new Error('翻唱功能已被主人关闭')
    const problem = this.problem()
    if (problem) throw new Error(`现在唱不了：${problem}`)
    const query = String(songArg ?? '').trim()
    if (!query) throw new Error('没说唱哪首歌')
    if (s.dailyLimit > 0 && this.countOf(sessionKey) >= s.dailyLimit) throw new Error(`今天这里已经唱了 ${s.dailyLimit} 首，嗓子要歇歇了，明天再来`)

    const deadline = Date.now() + DEADLINE_MS
    const part = parsePart(partArg)
    // 同时只唱一首；前面那首占的时间也算进这次的时限
    const job = this.queue.then(() => {
      if (Date.now() > deadline - 60_000) throw new Error('正在唱别的歌，排不上了，等会儿再点')
      return this.run(query, part, deadline)
    })
    this.queue = job.catch(() => {})
    const started = Date.now()
    const { file, song, start, end, transpose } = await job
    this.count(sessionKey)
    const seconds = Math.round((Date.now() - started) / 1000)
    this.logger.info('%s 翻唱《%s》%s–%s，变调 %d，用时 %d 秒', sessionKey, song.title.slice(0, 30), clock(start), clock(end), transpose, seconds)
    const which = part.mode === 'chorus' ? '副歌' : part.mode === 'start' ? '开头' : '指定的那段'
    return {
      src: pathToFileURL(file).href,
      note: `已附上翻唱语音：B 站《${song.title.slice(0, 60)}》（UP主 ${song.author}），唱的是${which} ${clock(start)}–${clock(end)}${transpose ? `，升降调 ${transpose > 0 ? '+' : ''}${transpose}` : ''}`,
    }
  }

  private async run(query: string, part: ReturnType<typeof parsePart>, deadline: number) {
    const s = this.config.cover
    const remaining = () => AbortSignal.timeout(Math.max(deadline - Date.now(), 1000))
    const song = await this.findSong(query, remaining())
    if (song.durationSec > s.maxSongMinutes * 60) throw new Error(`这首太长了（${clock(song.durationSec)}，上限 ${s.maxSongMinutes} 分钟）`)
    const audio = await this.download(song, remaining())
    await this.ensureWorker(remaining())
    const model = this.model()!
    this.sweep(OUT_DIR, 3600_000, 200 * 1024 * 1024)
    const out = resolve(OUT_DIR, `${song.bvid}-${Date.now()}.wav`)
    const res = await fetch(`http://127.0.0.1:${PORT}/sing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: remaining(),
      body: JSON.stringify({
        audio, out, model: model.pth, index: model.index,
        cache_dir: resolve(CACHE_DIR, 'stems'),
        part: part.mode, at: part.mode === 'at' ? part.sec : null,
        length: s.lengthSec, auto_transpose: s.autoTranspose, transpose: s.transpose,
        index_rate: s.indexRate, protect: s.protect, ffmpeg: ffmpegPath,
      }),
    })
    const data = await res.json() as { ok: boolean, error?: string, start: number, end: number, transpose: number }
    if (!data.ok) throw new Error(data.error ?? '翻唱失败')
    return { file: out, song, start: data.start, end: data.end, transpose: data.transpose }
  }

  /** 歌名 → B 站视频：直接给了 BV 号 / 链接就用它，否则搜索后按标题和播放量挑原唱版 */
  private async findSong(query: string, signal: AbortSignal): Promise<Song> {
    const bv = query.match(/BV[0-9A-Za-z]{10}/)?.[0]
    if (bv) return this.songInfo(bv, signal)
    const spi = await (await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: { 'user-agent': UA }, signal })).json() as any
    const params = new URLSearchParams({ search_type: 'video', keyword: query })
    const res = await fetch(`https://api.bilibili.com/x/web-interface/search/type?${params}`, {
      headers: { 'user-agent': UA, 'referer': 'https://search.bilibili.com/', 'cookie': `buvid3=${spi?.data?.b_3 ?? ''}` },
      signal,
    })
    const data = await res.json() as any
    if (data.code !== 0) throw new Error(`B 站搜索失败（${data.message ?? data.code}）`)
    const max = this.config.cover.maxSongMinutes * 60
    const candidates = (data.data?.result ?? []).map((v: any): Song & { score: number } => {
      const title = String(v.title ?? '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim()
      const lower = title.toLowerCase()
      const durationSec = parseDuration(v.duration)
      let score = Math.log10(Number(v.play) + 10)
      for (const w of BAD_WORDS) if (lower.includes(w)) score -= 3
      for (const w of GOOD_WORDS) if (lower.includes(w)) score += 1
      // 搜索词里的字（歌名、歌手）在标题里出现得越多越好
      const words = query.split(/\s+/).filter(Boolean)
      score += words.filter(w => lower.includes(w.toLowerCase())).length * 2
      if (durationSec < 90 || durationSec > max) score -= 100
      return { bvid: String(v.bvid), title, author: String(v.author ?? ''), durationSec, score }
    }).sort((a: { score: number }, b: { score: number }) => b.score - a.score)
    const best = candidates[0]
    if (!best || best.score < -50) throw new Error(`B 站上没找到「${query}」能唱的版本`)
    return best
  }

  private async songInfo(bvid: string, signal: AbortSignal): Promise<Song> {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: { 'user-agent': UA }, signal })
    const data = await res.json() as any
    if (data.code !== 0) throw new Error(`找不到这个视频（${data.message ?? data.code}）`)
    return { bvid, title: String(data.data.title), author: String(data.data.owner?.name ?? ''), durationSec: Number(data.data.duration) || 0 }
  }

  /** 只下音频，按 BV 号复用 */
  private async download(song: Song, signal: AbortSignal): Promise<string> {
    const cached = readdirSync(SONG_DIR).find(f => f.startsWith(`${song.bvid}.`) && !f.endsWith('.part'))
    if (cached) return resolve(SONG_DIR, cached)
    this.sweep(SONG_DIR, 0, SONG_CACHE_BYTES)
    const cmd = await findYtdlp()
    if (!cmd) throw new Error('没装 yt-dlp（pip install yt-dlp）')
    const url = `https://www.bilibili.com/video/${song.bvid}`
    await run(cmd, [
      '-f', 'ba/b', '--no-playlist', '--no-part', '--no-warnings', '--no-progress',
      ...cookieArgs(url, CACHE_DIR),
      '-o', resolve(SONG_DIR, `${song.bvid}.%(ext)s`),
      url,
    ], 120_000, signal)
    const file = readdirSync(SONG_DIR).find(f => f.startsWith(`${song.bvid}.`))
    if (!file) throw new Error('歌下载失败')
    return resolve(SONG_DIR, file)
  }

  /** 翻唱进程没在跑就启动它，等到 /health 通了为止 */
  private async ensureWorker(signal: AbortSignal) {
    if (await this.healthy()) return
    this.starting ??= (async () => {
      this.logger.info('启动翻唱进程')
      const child = spawn(PYTHON, [WORKER, '--port', String(PORT), '--idle', String(this.config.cover.idleMinutes * 60)], {
        cwd: resolve(ROOT, 'tools/cover'),
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
      this.worker = child
      child.stdout?.on('data', d => this.logger.debug(String(d).trim()))
      child.stderr?.on('data', (d) => {
        const text = String(d).trim()
        if (/error|traceback|exception/i.test(text)) return this.logger.warn(text.slice(-800))
        // worker.py 自己打的进度（用时、音高、退出），其余第三方库的输出不进日志
        for (const line of text.split('\n')) if (/^(分离|原唱|翻唱进程|空闲)/.test(line.trim())) this.logger.info(line.trim())
      })
      child.on('exit', (code) => {
        this.logger.info('翻唱进程退出（%s）', code)
        if (this.worker === child) this.worker = null
      })
      const until = Date.now() + 90_000
      while (Date.now() < until) {
        if (child.exitCode !== null) throw new Error('翻唱进程启动失败，看网关日志')
        if (await this.healthy()) return
        await new Promise(r => setTimeout(r, 1000))
      }
      child.kill()
      throw new Error('翻唱进程启动超时')
    })().finally(() => { this.starting = null })
    signal.throwIfAborted()
    await this.starting
  }

  private async healthy() {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) })
      return res.ok
    } catch {
      return false
    }
  }

  /** 删掉 maxAge 之前的文件，剩下的超过 maxBytes 从最旧的删（maxAge = 0 只按大小删） */
  private sweep(dir: string, maxAge: number, maxBytes: number) {
    const now = Date.now()
    const files = readdirSync(dir).map((f) => {
      const path = resolve(dir, f)
      try {
        const st = statSync(path)
        return st.isFile() ? { path, size: st.size, mtime: st.mtimeMs } : null
      } catch {
        return null
      }
    }).filter((f): f is { path: string, size: number, mtime: number } => Boolean(f)).sort((a, b) => a.mtime - b.mtime)
    let total = files.reduce((sum, f) => sum + f.size, 0)
    for (const f of files) {
      if ((!maxAge || now - f.mtime < maxAge) && total <= maxBytes) break
      try {
        unlinkSync(f.path)
        total -= f.size
      } catch {}
    }
  }

  private countOf(key: string) {
    return this.stats.date === today() ? this.stats.counts[key] ?? 0 : 0
  }

  private count(key: string) {
    if (this.stats.date !== today()) this.stats = { date: today(), counts: {} }
    this.stats.counts[key] = (this.stats.counts[key] ?? 0) + 1
    try {
      writeFileSync(STATS_FILE, JSON.stringify(this.stats))
    } catch {}
  }
}

/** dsh 插件调用的接口：会话由网关按 sessionId 决定 */
export function coverRoutes(ctx: Context, covers: CoverService) {
  ctx.server.post('/internal/cover/sing', async (koa: any) => {
    const { sessionId, song, part } = koa.request.body ?? {}
    try {
      koa.body = { ok: true, result: await covers.sing(song, part, String(sessionId).replace(/~\d+$/, '')) }
    } catch (e) {
      koa.body = { ok: false, error: (e as Error).message }
    }
  })
}

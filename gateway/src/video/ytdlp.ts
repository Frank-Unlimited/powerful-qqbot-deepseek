/**
 * yt-dlp：B 站和其他网站的解析、下载都交给它。
 * 命令按顺序找：环境变量 YTDLP_PATH、PATH 里的 yt-dlp、python -m yt_dlp、py -m yt_dlp（Windows 上 pip 装的脚本目录不一定在 PATH 里）。
 * B 站高画质是音视频分开的，用 ffmpeg-static 自带的 ffmpeg 合并。
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import type { VideoInfo } from './types.js'

export type Command = { file: string, prefix: string[] }

export function run(cmd: Command, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((ok, fail) => {
    execFile(cmd.file, [...cmd.prefix, ...args], { timeout: timeoutMs, signal, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        // yt-dlp 的报错在 stderr 最后几行，带上它比 "Command failed" 有用
        const detail = String(stderr || '').trim().split('\n').filter(l => l.includes('ERROR')).pop()
        return fail(Object.assign(new Error(detail || err.message), { code: (err as any).code }))
      }
      ok(String(stdout))
    })
  })
}

let found: Promise<Command | null> | null = null

/** 找到能用的 yt-dlp 命令；找不到返回 null（只影响 B 站和其他网站，抖音照常） */
export function findYtdlp(): Promise<Command | null> {
  found ??= (async () => {
    const candidates: Command[] = [
      ...(process.env.YTDLP_PATH ? [{ file: process.env.YTDLP_PATH, prefix: [] }] : []),
      { file: 'yt-dlp', prefix: [] },
      { file: 'python', prefix: ['-m', 'yt_dlp'] },
      { file: 'python3', prefix: ['-m', 'yt_dlp'] },
      { file: 'py', prefix: ['-m', 'yt_dlp'] },
    ]
    for (const cmd of candidates) {
      try {
        await run(cmd, ['--version'], 20_000)
        return cmd
      } catch {}
    }
    return null
  })()
  return found
}

export const ffmpegAvailable = () => Boolean(ffmpegPath && existsSync(ffmpegPath))

/** 把 "a=b; c=d" 形式的 cookie 写成 yt-dlp 要的 Netscape cookies.txt */
function cookieFile(dir: string, name: string, domain: string, cookie: string) {
  const lines = cookie.split(';').map(s => s.trim()).filter(s => s.includes('=')).map((pair) => {
    const i = pair.indexOf('=')
    return [domain, 'TRUE', '/', 'FALSE', '0', pair.slice(0, i), pair.slice(i + 1)].join('\t')
  })
  mkdirSync(dir, { recursive: true })
  const file = resolve(dir, name)
  writeFileSync(file, `# Netscape HTTP Cookie File\n${lines.join('\n')}\n`)
  return file
}

/** 按网址决定带哪个 cookie：B 站用 BILIBILI_SESSDATA（只填 SESSDATA 的值也行），抖音用 DOUYIN_COOKIE */
export function cookieArgs(url: string, dir: string): string[] {
  const bili = process.env.BILIBILI_SESSDATA?.trim()
  if (bili && /bilibili\.com|b23\.tv|bili2233\.cn/.test(url)) {
    return ['--cookies', cookieFile(dir, 'bilibili-cookies.txt', '.bilibili.com', bili.includes('=') ? bili : `SESSDATA=${bili}`)]
  }
  const douyin = process.env.DOUYIN_COOKIE?.trim()
  if (douyin && /douyin\.com/.test(url)) return ['--cookies', cookieFile(dir, 'douyin-cookies.txt', '.douyin.com', douyin)]
  return []
}

const SITE_NAMES: Record<string, string> = {
  BiliBili: 'B站', Douyin: '抖音', Kuaishou: '快手', Weibo: '微博', AcFunVideo: 'AcFun', Youtube: 'YouTube', Twitter: 'X',
}

export async function ytdlpInfo(url: string, cacheDir: string, signal: AbortSignal): Promise<VideoInfo> {
  const cmd = await findYtdlp()
  if (!cmd) throw new Error('没装 yt-dlp（pip install yt-dlp）')
  const out = await run(cmd, ['-J', '--no-playlist', '--no-warnings', ...cookieArgs(url, cacheDir), url], 60_000, signal)
  let data = JSON.parse(out)
  if (data._type === 'playlist') data = data.entries?.[0]
  if (!data) throw new Error('没解析出视频')
  if (data.is_live || data.live_status === 'is_live') throw new Error('这是直播，不搬')
  const extractor = String(data.extractor_key ?? 'Video')
  return {
    platform: extractor === 'BiliBili' ? 'bilibili' : extractor === 'Douyin' ? 'douyin' : 'other',
    site: SITE_NAMES[extractor] ?? extractor,
    id: `${extractor}-${data.id}`.replace(/[^\w.-]/g, '_'),
    title: String(data.title ?? data.fulltitle ?? '视频').trim(),
    author: String(data.uploader ?? data.channel ?? ''),
    durationSec: Math.round(Number(data.duration) || 0),
    pageUrl: String(data.webpage_url ?? url),
    source: { kind: 'ytdlp', url: String(data.webpage_url ?? url) },
    approxBytes: Number(data.filesize ?? data.filesize_approx) || 0,
  }
}

/**
 * 下载到 <dir>/<id>.mp4。画质按大小上限挑：优先 H.264（QQ 播放兼容最好）、不超过 1080P，
 * 估计大小超了就退到小一档，实在没有就最低画质；--max-filesize 兜底。
 */
export async function ytdlpDownload(info: VideoInfo, dir: string, maxMB: number, signal: AbortSignal): Promise<string> {
  const cmd = await findYtdlp()
  if (!cmd) throw new Error('没装 yt-dlp（pip install yt-dlp）')
  if (!ffmpegAvailable()) throw new Error('找不到 ffmpeg（npm install 后 ffmpeg-static 会自带）')
  const videoMB = Math.max(maxMB - 5, 1)
  const size = (mb: number) => `[filesize<=?${mb}M][filesize_approx<=?${mb}M]`
  const format = [
    `bv*[height<=1080]${size(videoMB)}+ba`,
    `b[height<=1080]${size(maxMB)}`,
    'wv*+ba',
    'w',
  ].join('/')
  const url = info.source.kind === 'ytdlp' ? info.source.url : info.pageUrl
  await run(cmd, [
    '-f', format,
    '-S', 'vcodec:h264,res,acodec:m4a',
    '--max-filesize', `${maxMB}M`,
    '--merge-output-format', 'mp4',
    '--remux-video', 'mp4',
    '--ffmpeg-location', ffmpegPath!,
    '--no-playlist', '--no-part', '--no-warnings', '--no-progress',
    '--concurrent-fragments', '4',
    ...cookieArgs(url, dir),
    '-o', resolve(dir, `${info.id}.%(ext)s`),
    url,
  ], 180_000, signal)
  const file = resolve(dir, `${info.id}.mp4`)
  // 超过 --max-filesize 时 yt-dlp 不报错，只是不下载
  if (!existsSync(file)) throw new Error(`视频超过 ${maxMB} MB`)
  return file
}

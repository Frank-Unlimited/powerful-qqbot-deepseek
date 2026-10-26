/**
 * 抖音作品解析：短链展开拿作品 id，再调网页版作品详情接口，拿无水印播放地址。
 *
 * 移植自 nonebot-plugin-parser 的 parsers/douyin（https://github.com/fllesser/nonebot-plugin-parser）：
 *   Copyright (c) 2024 Les Freire，MIT License
 * 改动：只保留视频作品（图集、实况图不搬）；Python 改写成 TypeScript；可选带 cookie（DOUYIN_COOKIE）。
 */
import type { VideoInfo } from './types.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/55.0.2883.87 UBrowser/6.2.4098.3 Safari/537.36'
export const DOUYIN_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Origin: 'https://open.douyin.com',
  Referer: 'https://open.douyin.com/',
}

/** 作品 id：/video/<id>、/note/<id>、/share/video/<id>、?modal_id=<id> */
function awemeIdOf(url: string): string | null {
  const m = /\/(?:video|note|slides|share\/[a-z]+|m\/[a-z]+)\/(\d{8,})/.exec(url) ?? /[?&]modal_id=(\d{8,})/.exec(url)
  return m?.[1] ?? null
}

/** 短链（v.douyin.com/xxx）跟着跳转找作品 id，最多跳 3 次 */
async function resolveId(url: string, signal: AbortSignal): Promise<string> {
  let current = url
  for (let i = 0; i < 4; i++) {
    const id = awemeIdOf(current)
    if (id) return id
    const res = await fetch(current, { redirect: 'manual', headers: { 'User-Agent': UA }, signal })
    const next = res.headers.get('location')
    if (!next) break
    current = new URL(next, current).href
  }
  throw new Error('链接里找不到抖音作品')
}

export async function douyinInfo(url: string, signal: AbortSignal): Promise<VideoInfo> {
  const id = await resolveId(url, signal)
  const api = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${id}&aid=6383`
  const cookie = process.env.DOUYIN_COOKIE?.trim()
  const res = await fetch(api, { headers: { ...DOUYIN_HEADERS, ...(cookie ? { Cookie: cookie } : {}) }, signal })
  if (!res.ok) throw new Error(`抖音接口返回 ${res.status}`)
  const text = await res.text()
  // 被风控时接口返回 200 + 空内容
  if (!text.trim()) throw new Error('抖音接口返回空内容（可能被风控，可以在 .env 填 DOUYIN_COOKIE）')
  const aweme = JSON.parse(text)?.aweme_detail
  if (!aweme) throw new Error('抖音接口没有返回作品（可能已删除或被风控）')
  if (aweme.images?.length) throw new Error('这是图文作品，不是视频')
  const uri = aweme.video?.play_addr?.uri
  if (!uri) throw new Error('抖音作品没有视频地址')
  const share = aweme.share_info ?? {}
  const shareText = String(share.share_desc_info ?? '').replace(`#${share.share_desc ?? ''}#`, '')
  return {
    platform: 'douyin',
    site: '抖音',
    id: `douyin-${id}`,
    title: String(aweme.desc || shareText || '抖音视频').trim(),
    author: String(aweme.author?.nickname ?? ''),
    durationSec: Math.round((aweme.video?.duration ?? aweme.duration ?? 0) / 1000),
    pageUrl: `https://www.douyin.com/video/${id}`,
    source: { kind: 'direct', url: `https://aweme.snssdk.com/aweme/v1/play/?video_id=${uri}&ratio=1080p&line=0`, headers: { 'User-Agent': UA } },
  }
}

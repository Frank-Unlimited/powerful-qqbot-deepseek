/**
 * 从群消息里找视频链接，按平台归类。
 * 链接模式参考 nonebot-plugin-parser（https://github.com/fllesser/nonebot-plugin-parser，MIT）。
 */
import type { h } from 'koishi'

export type VideoPlatform = 'douyin' | 'bilibili' | 'other'

export interface VideoLink {
  platform: VideoPlatform
  url: string
}

export interface DetectSettings {
  platforms: string[]
  /** 走 yt-dlp 的其他网站（域名，含子域名） */
  otherSites: string[]
}

const URL_RE = /https?:\/\/[^\s<>"'`，。！？、；）)\]】「」]+/gi
/** 只发了一个 BV 号（可以带分 P 序号），也当成 B 站链接 */
const BARE_BV = /^\s*(BV[0-9A-Za-z]{10})\s*$/

const DOUYIN_HOSTS = ['douyin.com', 'iesdouyin.com']
const BILIBILI_HOSTS = ['b23.tv', 'bili2233.cn', 'bilibili.com']

const hostIs = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)

function classify(url: string, settings: DetectSettings): VideoPlatform | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  if (DOUYIN_HOSTS.some(d => hostIs(host, d))) {
    // 短链，或者 /video/、/note/、/share/video/ 这种带作品 id 的
    return host.startsWith('v.') || host.startsWith('jx.') || /\/\d{8,}/.test(u.pathname) || u.searchParams.has('modal_id') ? 'douyin' : null
  }
  if (BILIBILI_HOSTS.some(d => hostIs(host, d))) {
    // 只要视频：短链展开后由 yt-dlp 判断；主站只认 /video/
    if (hostIs(host, 'bilibili.com')) return /\/video\/(BV|av)/i.test(u.pathname) ? 'bilibili' : null
    return 'bilibili'
  }
  if (settings.otherSites.some(d => hostIs(host, d.toLowerCase().replace(/^\.+/, '')))) return 'other'
  return null
}

/**
 * 消息里的视频链接（去重，最多 2 个）。
 * 除了文字，也翻一遍其他元素的属性：QQ 小程序分享卡片如果能收到，链接藏在卡片的 json 里。
 */
export function findVideoLinks(text: string, elements: h[], settings: DetectSettings): VideoLink[] {
  const sources = [text]
  for (const el of elements) {
    if (el.type === 'text' || el.type === 'at' || el.type === 'img' || el.type === 'image') continue
    sources.push(JSON.stringify(el.attrs ?? {}).replace(/\\\//g, '/'))
  }
  const links: VideoLink[] = []
  const seen = new Set<string>()
  const bv = BARE_BV.exec(text)
  if (bv) sources.push(`https://www.bilibili.com/video/${bv[1]}`)
  for (const source of sources) {
    for (const [raw] of source.matchAll(URL_RE)) {
      const url = raw.replace(/[.,!?;:]+$/, '')
      const platform = classify(url, settings)
      if (!platform || !settings.platforms.includes(platform) || seen.has(url)) continue
      seen.add(url)
      links.push({ platform, url })
    }
  }
  return links.slice(0, 2)
}

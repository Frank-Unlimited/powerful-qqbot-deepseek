import type { VideoPlatform } from './detect.js'

/** 解析出来的视频：下载前就知道的信息 */
export interface VideoInfo {
  platform: VideoPlatform
  /** 显示用的平台名：抖音、B站、YouTube…… */
  site: string
  /** 缓存和去重用的唯一 id，例如 douyin-7521023890996514083、bilibili-BV1xx411c7mD_p1 */
  id: string
  title: string
  author: string
  /** 0 = 不知道 */
  durationSec: number
  pageUrl: string
  /** 怎么下载：直链直接下；其余交给 yt-dlp */
  source: { kind: 'direct', url: string, headers: Record<string, string> } | { kind: 'ytdlp', url: string }
  /** yt-dlp 估计的文件大小（字节），不知道就是 0 */
  approxBytes?: number
}

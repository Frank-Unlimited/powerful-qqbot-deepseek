import { resolve } from 'node:path'
import { ROOT } from './config.js'

/** 本地向量模型（FastEmbed + bge-small-zh-v1.5，CPU）。记忆和表情包检索共用一个实例 */
export const EMBED_MODEL = 'fast-bge-small-zh-v1.5'
export const EMBED_DIMS = 512
const CACHE_DIR = resolve(ROOT, 'data/mem0/models')

let instance: Promise<(texts: string[]) => Promise<number[][]>> | undefined

/** 模型首次使用时加载（从国内镜像下载一次后缓存在 data/mem0/models） */
function load() {
  instance ??= (async () => {
    process.env.HF_ENDPOINT ??= 'https://hf-mirror.com'
    const { FlagEmbedding } = await import('fastembed')
    const flag = await FlagEmbedding.init({ model: EMBED_MODEL as any, cacheDir: CACHE_DIR, showDownloadProgress: false })
    return async (texts: string[]) => {
      const out: number[][] = []
      for await (const batch of flag.embed(texts.map(t => t.replace(/\n/g, ' ')))) out.push(...batch.map(v => Array.from(v)))
      return out
    }
  })()
  return instance
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (!texts.length) return []
  return (await load())(texts)
}

/** 余弦相似度（bge 的向量没有归一化，这里自己算） */
export function cosine(a: number[], b: number[]) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

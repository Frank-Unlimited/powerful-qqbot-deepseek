/**
 * 计费：把每一轮里真实发生的消耗（模型 token、看图、联网、语音）按官方人民币价格算成元，再按汇率折成 credits。
 * 价格表是唯一来源，看板的费用图表和 credits 都用它。
 *
 * 价格来源（2026-10-22 查询）：
 * - DeepSeek https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *   高峰 = 工作日北京时间 9:00–12:00、14:00–18:00，其余时间（含周末）价格减半；法定节假日也是低谷，这里没内置节假日表。
 *   图片按尺寸换算成 token 与文本一起计费（每张最多 1024 token），按接口返回的实际用量算。
 *   Search / Fetch 按成功请求次数计费；通过 DeepSeek Harness 调用的 2026-11-01 前免费。
 * - 智谱开放平台文生图：cogview-3-flash 免费，cogview-4 0.06 元 / 张，glm-image 0.1 元 / 张
 * - 火山引擎豆包语音合成 2.0 https://docs.volcengine.com/docs/6561/1359370 ：后付费 3 元 / 万字符
 *
 * 每笔记两个数：yuan = 实际花了多少（免费、限免为 0），listYuan = 按收费价算多少。
 * credits 一律按 listYuan 折算，所以免费的工具也照常扣额度，以后开始收费也不用改额度设置。
 */

/** 元 / 百万 token（高峰价） */
export const TOKEN_PRICES: Record<string, { hit: number, miss: number, out: number }> = {
  'deepseek-flash': { hit: 0.04, miss: 2, out: 8 },
  'deepseek-v4-pro': { hit: 0.3, miss: 9, out: 27 },
}
/** 元 / 次（成功的请求） */
export const SEARCH_PRICE = 5 / 1000
export const FETCH_PRICE = 5 / 1000
/** DSH 调用的 Search / Fetch 从这个时间起收费 */
export const WEB_BILLED_FROM = Date.parse('2026-11-01T00:00:00+08:00')
/** 元 / 字符 */
export const TTS_PRICE_PER_CHAR = 3 / 10000
/**
 * 元 / 张（2026-10-23 查询）。模型 ID 末尾的日期版本号（如 -260915）查价时会去掉。
 * - 智谱开放平台 https://docs.bigmodel.cn/cn/guide/start/pricing.md
 * - 火山方舟 Seedream https://docs.volcengine.com/docs/ark/model-pricing?lang=zh
 */
export const IMAGE_PRICES: Record<string, number> = {
  'cogview-3-flash': 0,
  'cogview-4': 0.06,
  'glm-image': 0.1,
  'doubao-seedream-5-0-flash': 0.12,
  'doubao-seedream-5-0-lite': 0.22,
  'doubao-seedream-4-0': 0.2,
  'doubao-seedream-4-5': 0.25,
  'doubao-seedream-5-0-pro': 0.3,
}
/** 去掉模型 ID 的日期版本号 */
export const imageModelBase = (model: string) => model.replace(/-\d{6}$/, '')

export function isPeak(time: number) {
  const d = new Date(time + 8 * 3600_000) // 换算成北京时间，再用 UTC 方法读取
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return false
  const h = d.getUTCHours()
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

/** 模型调用的人民币费用 */
export function tokenCost(model: string, time: number, miss: number, hit: number, out: number) {
  const p = TOKEN_PRICES[model] ?? TOKEN_PRICES['deepseek-flash']
  const k = isPeak(time) ? 1 : 0.5
  return k * (miss * p.miss + hit * p.hit + out * p.out) / 1e6
}

/** 工具上报的计费信息（dsh 插件写在 tool/result 的 meta.charge 里） */
export type ToolCharge =
  | { item: 'vision', model: string, miss: number, hit: number, out: number }
  | { item: 'search' }
  | { item: 'fetch' }
  | { item: 'tts', chars: number }
  | { item: 'image', model: string }

/** 一笔费用 */
export interface Charge {
  time: number
  /** chat / vision / search / fetch / tts */
  item: string
  detail: string
  /** 实际花出去的人民币（免费额度、限免期内为 0） */
  yuan: number
  /** 按收费价算的人民币：credits 一律按它折算，免费的东西也照常扣 credits */
  listYuan: number
  miss?: number
  hit?: number
  out?: number
  /** dsh 事件序号，回填去重用 */
  ref?: string
}

/** 免费模型折算 credits 时参照的收费价：cogview-3-flash 按同系列最便宜的收费版 cogview-4 算 */
const IMAGE_LIST_PRICES: Record<string, number> = { 'cogview-3-flash': 0.06 }

/** 按收费价算（限免期、免费模型、试用额度都按正常收费计），credits 用它折算 */
export function toolChargeListCost(c: ToolCharge, time: number) {
  switch (c.item) {
    case 'search': return SEARCH_PRICE
    case 'fetch': return FETCH_PRICE
    case 'image': return IMAGE_LIST_PRICES[imageModelBase(c.model)] ?? toolChargeCost(c, time)
    default: return toolChargeCost(c, time)
  }
}

/** 实际花费 */
export function toolChargeCost(c: ToolCharge, time: number) {
  switch (c.item) {
    case 'vision': return tokenCost(c.model, time, c.miss, c.hit, c.out)
    case 'search': return time >= WEB_BILLED_FROM ? SEARCH_PRICE : 0
    case 'fetch': return time >= WEB_BILLED_FROM ? FETCH_PRICE : 0
    case 'tts': return c.chars * TTS_PRICE_PER_CHAR
    // 没在价格表里的模型按最贵的算，免得少记
    case 'image': return IMAGE_PRICES[imageModelBase(c.model)] ?? Math.max(...Object.values(IMAGE_PRICES))
  }
}

/** 每类花费的中文名（看板额度页也用它） */
export const ITEM_LABEL: Record<ToolCharge['item'], string> = { vision: '看图', search: '联网搜索', fetch: '读网页', tts: '语音合成', image: '生成图片' }

/** 从 dsh 一轮的事件里算出全部费用：每次模型调用一笔，每次计费的工具调用一笔 */
export function chargesOf(events: any[], model: string): Charge[] {
  const out: Charge[] = []
  const calls = new Map<string, any>()
  for (const e of events) {
    if (e.type === 'assistant/message' && e.data?.usage) {
      const u = e.data.usage
      const hit = (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
      const miss = u.inputTokens ?? 0
      const o = u.outputTokens ?? 0
      const yuan = tokenCost(model, e.time, miss, hit, o)
      out.push({ time: e.time, item: 'chat', detail: model, yuan, listYuan: yuan, miss, hit, out: o, ref: String(e.seq) })
    } else if (e.type === 'tool/call') {
      calls.set(e.data.callId, e)
    } else if (e.type === 'tool/result') {
      const charge = e.data?.meta?.charge as ToolCharge | undefined
      const call = calls.get(e.data?.message?.toolCallId)
      if (!charge || e.data.message.isError) continue
      const time = call?.time ?? e.time
      out.push({
        time, item: charge.item, detail: ITEM_LABEL[charge.item] + (charge.item === 'tts' ? ` ${charge.chars} 字` : ''),
        yuan: toolChargeCost(charge, time),
        listYuan: toolChargeListCost(charge, time),
        ...(charge.item === 'vision' ? { miss: charge.miss, hit: charge.hit, out: charge.out } : {}),
        ref: String(call?.seq ?? e.seq),
      })
    }
  }
  return out
}

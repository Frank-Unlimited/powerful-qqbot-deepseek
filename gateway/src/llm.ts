/**
 * 网关后台直接调 DeepSeek（OpenAI 兼容接口，JSON 输出）：画像整理、原文分段摘要用。
 * 费用记进活动日志（后台花费，不扣任何人的额度）。
 */
import type { ActivityLog } from './activity.js'
import { tokenCost } from './billing.js'

export async function deepseekJson(activity: ActivityLog, model: string, system: string, user: string, label: string, maxTokens = 2500): Promise<any> {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model, temperature: 0.3, max_tokens: maxTokens, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(120_000),
  })
  const body: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`DeepSeek ${res.status} ${body.error?.message ?? ''}`)
  const u = body.usage ?? {}
  const hit = u.prompt_cache_hit_tokens ?? 0
  const miss = u.prompt_cache_miss_tokens ?? Math.max((u.prompt_tokens ?? 0) - hit, 0)
  const out = u.completion_tokens ?? 0
  const now = Date.now()
  activity.log({ time: now, kind: 'chat', detail: `${model}（${label}）`, auto: true, miss, hit, out, cost: tokenCost(model, now, miss, hit, out) })
  const text = String(body.choices?.[0]?.message?.content ?? '')
  // 有时会包一层代码块或前后带几句话：取第一个 { 到最后一个 }
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  try {
    return JSON.parse(json)
  } catch {
    const reason = body.choices?.[0]?.finish_reason === 'length' ? '，输出被截断' : ''
    throw new Error(`模型返回的不是 JSON${reason}（${text.slice(0, 60).replace(/\s+/g, ' ')}…）`)
  }
}

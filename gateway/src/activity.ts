import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from 'koishi'
import { ROOT } from './config.js'
import type { Activity, ActivityInput, Store } from '../../shared/store.mjs'
import { toolKind } from './tools-manifest.js'
import { tokenCost as priceOf, toolChargeCost, type ToolCharge } from './billing.js'

// 价格表和计算都在 billing.ts，看板费用和 credits 共用一套
export { isPeak, tokenCost as priceOf } from './billing.js'

// 工具的看板分类由插件在工具清单里声明（tools-manifest.ts），这里不再维护映射表

/**
 * 活动日志：事件发生时写入 SQLite，并通过 SSE 推给打开着的看板。
 * 首次启动时从 dsh 会话日志回填历史。
 */
export class ActivityLog {
  private listeners = new Set<(a: Activity) => void>()
  private logger

  constructor(ctx: Context, private store: Store) {
    this.logger = ctx.logger('activity')
    ctx.on('ready', () => {
      if (this.store.activityCount() === 0) this.backfill()
    })
  }

  log(input: ActivityInput) {
    const row = this.store.logActivity(input)
    if (row) for (const fn of this.listeners) fn(row)
    return row
  }

  subscribe(fn: (a: Activity) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** 从 dsh 会话日志补录对话和工具调用（只在活动表为空时跑一次；按 dsh 事件序号去重）。 */
  private backfill() {
    const root = resolve(ROOT, 'data/dsh-home/sessions')
    if (!existsSync(root)) return
    const decode = (s: string) => s.replace(/~([0-9A-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    let n = 0
    for (const ws of readdirSync(root)) {
      for (const dir of readdirSync(resolve(root, ws))) {
        const sessionKey = decode(dir).replace(/~\d+$/, '')
        for (const f of readdirSync(resolve(root, ws, dir)).filter(f => f.endsWith('.jsonl'))) {
          const events: any[] = []
          for (const line of readFileSync(resolve(root, ws, dir, f), 'utf8').split('\n')) {
            if (!/"(assistant\/message|tool\/call|tool\/result)"/.test(line)) continue
            try { events.push(JSON.parse(line)) } catch {}
          }
          for (const a of eventsToActivity(events, sessionKey, 'deepseek-flash')) {
            if (this.store.logActivity({ ...a, sourceRef: `${dir}#${a.sourceRef}` })) n++
          }
        }
      }
    }
    this.logger.info('已从 dsh 会话日志回填 %d 条活动', n)
  }
}

/**
 * 把一轮（或一整个会话）的 dsh 事件转成活动记录：
 * 每次模型调用一条 chat（带 token 和费用）；每次工具调用一条（按 callId 配对结果，看图的 token 记在这条上）。
 */
export function eventsToActivity(events: any[], sessionKey: string, model: string): ActivityInput[] {
  const out: ActivityInput[] = []
  const calls = new Map<string, any>()
  for (const e of events) {
    if (e.type === 'assistant/message' && e.data?.usage) {
      const u = e.data.usage
      const hit = (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
      out.push({
        time: e.time, sessionKey, kind: 'chat', detail: model, miss: u.inputTokens ?? 0, hit, out: u.outputTokens ?? 0,
        cost: priceOf(model, e.time, u.inputTokens ?? 0, hit, u.outputTokens ?? 0), sourceRef: String(e.seq),
      })
    } else if (e.type === 'tool/call') {
      calls.set(e.data.callId, e)
    } else if (e.type === 'tool/result') {
      const call = calls.get(e.data?.message?.toolCallId)
      if (!call) continue
      // 计费工具（看图、联网、语音）在 meta.charge 里上报真实用量
      const charge = e.data.meta?.charge as ToolCharge | undefined
      const ok = !e.data.message.isError
      out.push({
        time: call.time, sessionKey, kind: toolKind(call.data.name),
        detail: ok ? call.data.name : `${call.data.name}（失败）`,
        ...(charge?.item === 'vision' ? { miss: charge.miss, hit: charge.hit, out: charge.out } : {}),
        cost: charge && ok ? toolChargeCost(charge, call.time) : 0, sourceRef: String(call.seq),
      })
    }
  }
  return out
}

import type { Charge } from '../billing.js'
import type { ObservedMessage, TriggerReason } from './trigger.js'

/** 网关交给智能体的一轮输入。 */
export interface AgentRequest {
  /** 会话键：qq:group:<openid> 或 qq:user:<openid>，同一个键复用同一个 dsh 会话 */
  sessionKey: string
  scene: 'group' | 'private'
  reason: TriggerReason
  sender: { id: string, name: string, isAdmin: boolean, isOwner: boolean }
  groupId?: string
  /** 正文；图片以「[图片#N]」占位 */
  text: string
  quote?: { name: string, text: string }
  /** 这句话里提到的人：@ 到的、被引用消息的作者（不含她自己），用于按人召回和 who 解析 */
  mentions?: Mention[]
  /** 轮次 id：触发消息、她的回复、这一轮的工具调用在原文里共用；不传由 agent 生成 */
  turn?: string
  /** 全量模式下旁听到的近期群消息 */
  observed: ObservedMessage[]
}

/** 媒体工具不直接发消息，而是写进发件箱，由网关合并进被动回复。 */
export type OutboxItem =
  | { type: 'image', src: string }
  | { type: 'sticker', src: string }
  | { type: 'audio', src: string }
  | { type: 'video', src: string }

export interface AgentReply {
  text: string
  outbox: OutboxItem[]
  /** 这一轮的全部真实费用（模型 + 计费工具），由网关折算成 credits 记账 */
  charges: Charge[]
  /** 模型选择不回复（插话判断为无关时） */
  silent?: boolean
  /** 这一轮的轮次 id（同 AgentRequest.turn） */
  turn: string
}

export interface Mention { id: string, name: string, via: 'at' | 'quote' }

/** 某个 dsh 会话正在进行（或最近一次）的一轮 */
export interface TurnInfo {
  seq: number
  reason: TriggerReason
  senderId: string
  sessionKey: string
  /** 轮次 id（原文里的 turn） */
  turn: string
  isOwner: boolean
  mentions: Mention[]
}

export interface AgentClient {
  chat(req: AgentRequest, signal: AbortSignal): Promise<AgentReply>
  /** dsh 会话 id → 当前这一轮的信息（插件调网关接口时用来确认是谁、第几轮） */
  currentTurn(sessionId: string): TurnInfo | undefined
  reset(sessionKey: string): Promise<void>
  /** 按最新超参数重启智能体进程 */
  restart(): Promise<Record<string, unknown>>
}

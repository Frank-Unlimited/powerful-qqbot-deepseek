import { Session } from 'koishi'
import type { Config } from '../config.js'

/** video = 自动解析视频：没人叫她，但消息里有视频链接 */
export type TriggerReason = 'direct' | 'at' | 'name' | 'reply' | 'interest' | 'schedule' | 'video'

export interface ObservedMessage {
  userId: string
  name: string
  text: string
  time: number
}

/**
 * 群聊触发策略。按 @ / 叫名字 / 回复她 / 兴趣概率 决定是否回复，不回复的消息进入旁听窗口，作为下一次回复的上下文。
 * 平台只推送 @ 消息时，后面几种自然不会出现；开通「接收所有消息」后自动生效，不需要额外开关。
 */
export class Trigger {
  private lastInterject = new Map<string, number>()
  private observed = new Map<string, ObservedMessage[]>()

  /** config 是 ConfigStore 原地更新的对象，每次读取都是最新值 */
  constructor(private config: Config['group']) {}

  decide(session: Session): TriggerReason | null {
    if (session.isDirect) return 'direct'
    if (session.elements?.some(e => e.type === 'at' && e.attrs.id === session.selfId)) return 'at'

    const { trigger } = this.config
    const text = session.content ?? ''
    if (trigger.onName.some(name => text.includes(name))) return 'name'
    if (session.quote?.user?.id === session.selfId) return 'reply'

    if (trigger.interest > 0) {
      const last = this.lastInterject.get(session.guildId) ?? 0
      if (Date.now() - last >= trigger.cooldownSec * 1000 && Math.random() < trigger.interest) {
        this.lastInterject.set(session.guildId, Date.now())
        return 'interest'
      }
    }
    return null
  }

  observe(session: Session, text: string) {
    if (session.isDirect || this.config.observeWindow <= 0) return
    const list = this.observed.get(session.guildId) ?? []
    list.push({
      userId: session.userId,
      name: session.author?.nick || session.author?.name || session.userId,
      text,
      time: session.timestamp || Date.now(),
    })
    if (list.length > this.config.observeWindow) list.splice(0, list.length - this.config.observeWindow)
    this.observed.set(session.guildId, list)
  }

  /** 取出并清空旁听窗口（已经交给模型的内容不再重复发送）。 */
  drain(groupId: string) {
    const list = this.observed.get(groupId) ?? []
    this.observed.delete(groupId)
    return list
  }
}

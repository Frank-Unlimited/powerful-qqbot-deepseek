import { randomUUID } from 'node:crypto'
import type { Config } from '../config.js'
import type { Store } from '../../../shared/store.mjs'
import type { Charge } from '../billing.js'

/** 谁为这一轮买单：插话只记群，定时任务两者都为空（只算全局） */
export interface QuotaSubject {
  userId?: string
  groupId?: string
}

/** 北京时间的日期 YYYY-MM-DD */
export function beijingDay(time = Date.now()) {
  return new Date(time + 8 * 3600_000).toISOString().slice(0, 10)
}

/**
 * 每日额度（credits）。每一笔真实花费按人民币算好后乘汇率记进账本（store.credit_ledger，只增不改）。
 * - 个人：每天有上限（默认 quota.user，可单独改），超出后从充值余额里扣，余额也没了就停
 * - 群、全局：每天上限 quota.group / quota.global
 * - 管理员不受限制，但照样记账
 * config 是 ConfigStore 原地更新的对象，上限和汇率实时生效。
 */
export class Quota {
  constructor(private store: Store, private config: Config['quota'], private admins: string[]) {}

  /** 这个人今天的上限：单独设置过就用设置的，否则用默认值 */
  limitOf(userId: string) {
    return this.store.creditAccount(userId).daily_limit ?? this.config.user
  }

  /** 个人今天的情况：已花、上限、余额、还能花多少 */
  userStatus(userId: string, day = beijingDay()) {
    const spent = this.store.creditsSpent({ userId, day })
    const limit = this.limitOf(userId)
    const { balance, daily_limit } = this.store.creditAccount(userId)
    const admin = this.admins.includes(userId)
    return { spent, limit, custom: daily_limit !== null, balance, admin, remaining: admin ? Infinity : Math.max(0, limit - spent) + Math.max(0, balance) }
  }

  /** 返回 true 表示允许这一轮 */
  check(subject: QuotaSubject) {
    return this.blocked(subject) === null
  }

  /** 这一轮被哪一级额度拦下：个人 / 群 / 全局；null = 不拦 */
  blocked(subject: QuotaSubject): 'user' | 'group' | 'global' | null {
    if (subject.userId && this.admins.includes(subject.userId)) return null
    const day = beijingDay()
    if (subject.userId && this.userStatus(subject.userId, day).remaining <= 0) return 'user'
    if (subject.groupId && this.groupSpent(subject.groupId, day) >= this.config.group) return 'group'
    return this.checkGlobal() ? null : 'global'
  }

  /** 群今天花了多少（不算管理员的：管理员不受限，他们用多少都不该挤掉群友的额度） */
  groupSpent(groupId: string, day = beijingDay()) {
    return this.store.creditsSpent({ groupId, day, excludeUsers: this.admins })
  }

  checkGlobal() {
    return this.store.creditsSpent({ day: beijingDay() }) < this.config.global
  }

  /** 记一轮的费用（charges 来自 billing.chargesOf），返回这一轮花了多少 credits */
  record(subject: QuotaSubject, sessionKey: string, charges: Charge[]) {
    const rate = this.config.creditsPerYuan
    // credits 按收费价折算（免费、限免的也照常扣）；yuan 记实际花费，方便对账
    const rows = charges.map(c => ({ time: c.time, item: c.item, detail: c.detail, yuan: c.yuan, credits: c.listYuan * rate }))
    const admin = subject.userId ? this.admins.includes(subject.userId) : false
    this.store.chargeTurn({
      day: beijingDay(),
      userId: subject.userId,
      groupId: subject.groupId,
      sessionKey,
      turn: randomUUID(),
      limit: subject.userId && !admin ? this.limitOf(subject.userId) : Infinity,
    }, rows)
    return rows.reduce((n, r) => n + r.credits, 0)
  }
}

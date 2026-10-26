import { resolve } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Bot, Context, h, Universal } from 'koishi'
import { ROOT, type Config } from '../config.js'
import type { Store } from '../../../shared/store.mjs'
import type { Quota } from './quota.js'
import type { AgentClient, AgentReply, AgentRequest } from './types.js'
import { logReply } from '../short-term.js'

const STATE_FILE = resolve(ROOT, 'data/schedule.json')
/** 定时任务的检查间隔；条件触发的任务（如 0 分钟 = 10 秒的调试寒暄）靠它保证及时 */
const TICK_MS = 5_000
/** 主动发送失败后，改成"对方下次说话时补上"，超过这么久就不补了 */
const PENDING_TTL_MIN = 4 * 60
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

export interface Target { key: string, scene: 'group' | 'private', id: string }

/** 北京时间的日期、当天分钟数、星期 */
export interface BeijingNow { date: string, minutes: number, weekday: number, weekdayLabel: string }

/**
 * 一个调度项。两种触发方式：
 * - 每天定时：settings 给出 time / catchupMin，引擎保证每个会话每天只做一次、错过补发（现在没有用到，早安、日记已经并进定时任务）
 * - 条件触发（冷场寒暄、定时任务）：实现 due()，引擎每 5 秒问一次"现在该不该做"，并记下每个会话上次做的时间
 * 引擎负责生成、发送、主动消息被拒时改成被动补发、记账；任务只描述"什么时候、发给谁、让她做什么"。
 */
export interface ScheduledTask {
  id: string
  /** 日志里的名字，例如"早安" */
  label: string
  /** 每次读取，配置改了实时生效；条件触发的任务只看 enabled */
  settings(): { enabled: boolean, time?: string, catchupMin?: number }
  /** 条件触发：现在该不该对这个会话做一次；runs = 最近几次做的时间（毫秒，旧到新） */
  due?(target: Target, now: BeijingNow, runs: number[]): boolean
  /** 主动消息发不出去时，要不要等对方说话时补上（寒暄这种过了时机就没意义，设 false） */
  fallback?: boolean
  /** 回复按换行拆成多条发（寒暄这种闲聊拆；日记、早安这种成段的不拆）；可以按这一次执行的内容决定，在 prompt() 之后调用 */
  split?: boolean | ((target: Target) => boolean)
  /** 这一次执行的名字（日志、活动记录里用），在 prompt() 之后调用；不写 = label */
  runLabel?(target: Target): string
  targets(): Target[]
  /** 交给模型的提示；返回 null = 这次跳过这个目标（比如群里今天没人说话） */
  prompt(target: Target, now: BeijingNow): string | null
  /** 这一次用谁的身份执行（权限和记账都算 TA 的）；不写 = 主人。在 prompt() 之后调用 */
  sender?(target: Target): AgentRequest['sender']
  /** 生成好之后（不管主动消息发没发出去）调用，例如把日记存档 */
  generated?(target: Target, text: string, now: BeijingNow): void
}

interface TaskState {
  date: string
  /** 今天已经处理过的会话（发出去了，或已转为待补发） */
  done: string[]
  /** 主动发送失败、等对方先说话再补发的消息，附上计划时间（分钟）用于判断过期 */
  pending: Record<string, { messages: string[], at: number }>
  /** 每个会话最近几次执行的时间（毫秒，旧到新），跨天保留，条件触发的任务用 */
  runs: Record<string, number[]>
}

interface Deps {
  agent: AgentClient
  store: Store
  quota: Quota
  enqueue: (key: string, task: () => Promise<void>) => void
  toMessages: (reply: AgentReply, key?: string, split?: boolean) => h[][]
}

export function scheduler(ctx: Context, config: Config, deps: Deps, tasks: ScheduledTask[]) {
  const logger = ctx.logger('schedule')
  const state = load()
  const badTime = new Map<string, string>()
  const queued = new Set<string>()

  ctx.setInterval(() => {
    for (const task of tasks) tick(task).catch(e => logger.warn(e))
  }, TICK_MS)

  function stateOf(task: ScheduledTask, date: string): TaskState {
    if (state[task.id]?.date !== date) {
      state[task.id] = { date, done: [], pending: {}, runs: state[task.id]?.runs ?? {} }
      save()
    }
    state[task.id].runs ??= {}
    return state[task.id]
  }

  async function tick(task: ScheduledTask) {
    const now = beijingNow()
    const s = stateOf(task, now.date)
    const { enabled, time = '', catchupMin = 0 } = task.settings()
    if (!enabled) return
    if (task.due) return tickCondition(task, s, now)
    const at = parseTime(time)
    if (at === null) {
      if (badTime.get(task.id) !== time) logger.warn('%s 的时间格式不对（要 HH:MM）：%s', task.label, time)
      badTime.set(task.id, time)
      return
    }
    if (now.minutes < at || now.minutes > at + catchupMin) return
    const bot = onlineBot()
    if (!bot) return
    for (const target of task.targets()) {
      if (s.done.includes(target.key)) continue
      // 先占位，防止下一个 tick 重复生成
      s.done.push(target.key)
      save()
      deps.enqueue(target.key, () => runOnce(task, bot, target, now, at))
    }
  }

  /** 条件触发的任务：每个会话问一次 due()，该做就排进队列；同一个会话排着队时不重复 */
  function tickCondition(task: ScheduledTask, s: TaskState, now: BeijingNow) {
    const bot = onlineBot()
    if (!bot) return
    for (const target of task.targets()) {
      const id = `${task.id}|${target.key}`
      const runs = s.runs[target.key] ?? []
      if (queued.has(id) || !task.due!(target, now, runs)) continue
      queued.add(id)
      // 做完才记一次：被重启打断的不算（重启后会重新补上）；生成失败的也算，免得每 5 秒重试一遍
      deps.enqueue(target.key, () => runOnce(task, bot, target, now, now.minutes).finally(() => {
        const st = stateOf(task, beijingNow().date)
        st.runs[target.key] = [...(st.runs[target.key] ?? []), Date.now()].slice(-50)
        save()
        queued.delete(id)
      }))
    }
  }

  async function runOnce(task: ScheduledTask, bot: Bot, target: Target, now: BeijingNow, at: number) {
    const text = task.prompt(target, now)
    if (!text) return logger.info('%s 跳过%s', target.key, task.label)
    const label = task.runLabel?.(target) ?? task.label
    const split = typeof task.split === 'function' ? task.split(target) : task.split
    // 没有发起人的任务（早安、日记、寒暄）算主人发起的：权限按主人（仅限主人的工具能用），记账记在主人和所在的群上；
    // 有发起人的（她帮人设的定时任务）按发起人的身份和额度
    const groupId = target.scene === 'group' ? target.id : undefined
    const sender = task.sender?.(target) ?? ownerSender(config, deps.store)
    const subject = { userId: task.sender || sender.isOwner ? sender.id : undefined, groupId }
    if (!deps.quota.check(subject)) return logger.info('%s 额度用完，跳过%s', target.key, label)
    const req: AgentRequest = {
      sessionKey: target.key,
      scene: target.scene,
      reason: 'schedule',
      sender,
      groupId,
      text,
      observed: [],
    }
    let reply: AgentReply
    try {
      reply = await deps.agent.chat(req, AbortSignal.timeout(config.agent.timeoutSec * 1000))
    } catch (e) {
      return logger.warn('%s %s生成失败：%s', target.key, label, (e as Error).message)
    }
    deps.quota.record(subject, target.key, reply.charges)
    const messages = deps.toMessages(reply, target.key, split)
    if (!messages.length) return
    if (reply.text) {
      try {
        task.generated?.(target, reply.text, now)
      } catch (e) {
        logger.warn('%s %s存档失败：%s', target.key, label, (e as Error).message)
      }
    }
    // 她主动发的话也记进原文，总结群聊、写日记、深度回忆时才是完整的
    logReply(deps.store, target.scene === 'group' ? target.id : `user:${target.id}`, config.bot.name, reply, 'schedule', label)
    try {
      for (const message of messages) await send(bot, target, message)
      logger.info('%s 已发送%s：%s', target.key, label, reply.text.slice(0, 40))
    } catch (e) {
      if (task.fallback === false) return logger.info('%s 主动消息发不出去（%s），这次%s就算了', target.key, describe(e), label)
      // 已经发出去的部分不再补；没发出去的留给被动回复
      logger.info('%s 主动消息发不出去（%s），等对方说话时补上%s', target.key, describe(e), label)
      stateOf(task, now.date).pending[target.key] = { messages: messages.map(m => m.map(String).join('')), at }
      save()
    }
  }

  function send(bot: Bot, target: Target, message: h[]) {
    if (target.scene === 'group') return bot.sendMessage(target.id, message)
    // 不带 session 的话适配器会把私聊当成群聊发，这里手动标成私聊频道
    const session = bot.session({ type: 'send', channel: { id: target.id, type: Universal.Channel.Type.DIRECT }, user: { id: target.id } })
    return bot.sendMessage(target.id, message, undefined, { session })
  }

  function onlineBot() {
    return ctx.bots.find(b => b.platform === 'qq' && b.status === Universal.Status.ONLINE)
  }

  function save() {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  }

  return {
    /** 立即对某个会话执行一次任务（测试用，不计入"今天已做"） */
    run(taskId: string, key: string) {
      const task = tasks.find(t => t.id === taskId)
      const bot = onlineBot()
      const [, scene, id] = key.split(':')
      if (!task || !bot || !id) return false
      const now = beijingNow()
      deps.enqueue(key, () => runOnce(task, bot, { key, scene: scene === 'group' ? 'group' : 'private', id }, now, now.minutes))
      return true
    },
    /** 对方说话了：取出所有任务里待补发的消息（只取一次，过期的丢掉） */
    takePending(key: string): string[] {
      const out: string[] = []
      const now = beijingNow()
      for (const task of tasks) {
        const s = state[task.id]
        const p = s?.date === now.date ? s.pending[key] : undefined
        if (!p) continue
        delete s.pending[key]
        save()
        if (now.minutes - p.at <= PENDING_TTL_MIN) out.push(...p.messages)
      }
      return out
    },
  }
}

function load(): Record<string, TaskState> {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {}
  return {}
}

export function parseTime(text: string) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text?.trim() ?? '')
  if (!m || +m[1] > 23 || +m[2] > 59) return null
  return +m[1] * 60 + +m[2]
}

export function beijingNow(): BeijingNow {
  const d = new Date(Date.now() + 8 * 3600_000)
  return {
    date: d.toISOString().slice(0, 10),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    weekday: d.getUTCDay(),
    weekdayLabel: `星期${WEEKDAYS[d.getUTCDay()]}`,
  }
}

/** 没有发起人的回合（定时任务、寒暄、欢迎新人）用主人的身份；没配主人时用一个占位身份 */
export function ownerSender(config: Config, store: Store): AgentRequest['sender'] {
  const owner = config.owner
  if (!owner?.id) return { id: 'schedule', name: '', isAdmin: false, isOwner: false }
  return { id: owner.id, name: store.profile(owner.id)?.name || owner.name, isAdmin: true, isOwner: true }
}

/** 她待过的真实群（跳过本地测试留下的会话，真实群 openid 是 32 位十六进制） */
export function knownGroups(store: Store) {
  return store.listSessions().map(s => s.key).filter(k => k.startsWith('qq:group:')).map(k => k.slice(9)).filter(id => /^[0-9A-F]{32}$/i.test(id))
}

function describe(e: unknown) {
  const errors = e instanceof AggregateError ? e.errors : [e]
  return errors.map((x: any) => x?.response?.data ? JSON.stringify(x.response.data) : x?.message ?? String(x)).join('; ')
}

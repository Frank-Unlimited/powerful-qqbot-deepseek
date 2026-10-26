/**
 * 定时任务：早安、日记这种她每天的习惯，和她用 schedule 工具帮人设的提醒，都是同一种结构、存在一起。三种触发方式参考 OpenClaw 的 automations：
 * - at：到点一次（"20m""2h""21:30""2026-10-24 09:00"，北京时间），执行完自动删除
 * - every：固定间隔（"30m""2h""1d"）
 * - cron：五段 cron 表达式（分 时 日 月 周，北京时间），日和周都限定时按"或"算（同标准 cron）
 *
 * 到点后在任务所在的会话里让她跑一轮，照任务里的指令去做，**按设任务的人的身份执行**：
 * 权限、额度都算 TA 的（主人设的才有主人权限），别人没法借定时任务用到仅限主人的工具。
 * 系统任务（早安、日记）算主人设的，只有主人和超级用户能改。目标可以是"全部群"（她待过的所有群，新进的群自动算上）。
 * 任务存在 data/jobs.json；调度挂在 scheduler 上（条件触发），重启后照常继续。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import YAML from 'yaml'
import { CONFIG_PATH, DEFAULT_PROMPTS, ROOT, type Config } from '../config.js'
import type { Store } from '../../../shared/store.mjs'
import { knownGroups, type BeijingNow, type ScheduledTask, type Target } from './scheduler.js'
import { saveDiary } from './diary.js'

const FILE = resolve(ROOT, 'data/jobs.json')
const BJ = 8 * 3600_000
const MAX_MESSAGE = 500
/** 系统任务和主人设的提示词可以很长（日记） */
const MAX_SYSTEM_MESSAGE = 4000
/** "全部群"：她待过的所有群 */
export const ALL_GROUPS: Target = { key: 'qq:group:*', scene: 'group', id: '*' }

export type JobKind = 'at' | 'every' | 'cron'

export interface Job {
  id: string
  name: string
  kind: JobKind
  /** at：原样记下的时间；every：间隔；cron：表达式 */
  when: string
  /** 到点时交给她的指令；{time} {date} {weekday} {hours} 会替换成当前时间、日期、星期、今天过了几小时 */
  message: string
  target: Target
  creatorId: string
  creatorName: string
  createdAt: number
  nextRunAt: number
  lastRunAt?: number
  runs: number
  /** 暂停的任务不执行；没写 = 开着 */
  enabled?: boolean
  /** 系统任务（早安、日记）：只有主人和超级用户能改、能删；指令原样交给她，不套"这是定时任务"的说明 */
  system?: boolean
  /** 群里今天（北京时间 0 点起）别人的消息少于这么多条就跳过这次 */
  minMessages?: number
  /** 把她写的内容存档：diary = 存到角色包 diary/<日期>.md */
  archive?: 'diary'
  /** 到点时网关没开，开机后多少分钟内还补做；没写 = 补做一次，不论多久 */
  catchupMin?: number
  /** 回复按换行拆成多条发；没写 = 系统任务不拆（日记、早安是成段的），其余拆 */
  split?: boolean
  /** 目标是"全部群"时，这一轮已经做过的群（全做完才算下一轮） */
  done?: string[]
}

export interface JobInput { name?: string, kind?: string, when?: string, message?: string, enabled?: boolean | string }

// ---- 时间解析 ----

/** "1h30m""20m""2d""45s" → 毫秒；不是这种格式返回 null */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, '')
  if (!/^(\d+(\.\d+)?(s|sec|m|min|h|hr|d|day|秒|分钟?|小时|天))+$/.test(t)) return null
  const unit: Record<string, number> = { s: 1e3, sec: 1e3, 秒: 1e3, m: 6e4, min: 6e4, 分: 6e4, 分钟: 6e4, h: 36e5, hr: 36e5, 小时: 36e5, d: 864e5, day: 864e5, 天: 864e5 }
  let ms = 0
  for (const [, n, , u] of t.matchAll(/(\d+(\.\d+)?)(sec|min|hr|day|分钟|小时|s|m|h|d|秒|分|天)/g)) ms += Number(n) * unit[u]
  return ms > 0 ? ms : null
}

/** 北京时间的年月日时分 → 时间戳 */
const bjTime = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi) - BJ

/** at 的时间：相对时间、"HH:MM"（今天没过就今天，过了就明天）、"[YYYY-]MM-DD HH:MM"、带时区的 ISO 时间 */
export function parseAt(text: string, now = Date.now()): number | null {
  const t = text.trim()
  const rel = parseDuration(t)
  if (rel) return now + rel
  const bj = new Date(now + BJ)
  let m = /^(\d{1,2})[:：](\d{2})$/.exec(t)
  if (m) {
    let at = bjTime(bj.getUTCFullYear(), bj.getUTCMonth() + 1, bj.getUTCDate(), +m[1], +m[2])
    if (at <= now) at += 864e5
    return +m[1] < 24 && +m[2] < 60 ? at : null
  }
  m = /^(?:(\d{4})[-/年])?(\d{1,2})[-/月](\d{1,2})日?[\sT]+(\d{1,2})[:：](\d{2})$/.exec(t)
  if (m) return bjTime(m[1] ? +m[1] : bj.getUTCFullYear(), +m[2], +m[3], +m[4], +m[5])
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) {
    const ms = Date.parse(t)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

/** 解析一段 cron 字段：*、n、a-b、a,b、*\/n、a-b/n */
function cronField(spec: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>()
  for (const part of spec.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!m) return null
    const from = m[1] === '*' ? min : +m[2]
    const to = m[1] === '*' ? max : m[3] !== undefined ? +m[3] : m[4] ? max : from
    const step = m[4] ? +m[4] : 1
    if (from < min || to > max || from > to || step < 1) return null
    for (let v = from; v <= to; v += step) out.add(v)
  }
  return out
}

/** 下一次满足 cron 表达式的时间（北京时间，从 after 的下一分钟起找，最多找一年） */
export function nextCron(expr: string, after = Date.now()): number | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [mi, h, dom, mon, dow] = [
    cronField(parts[0], 0, 59), cronField(parts[1], 0, 23), cronField(parts[2], 1, 31), cronField(parts[3], 1, 12), cronField(parts[4], 0, 7),
  ]
  if (!mi || !h || !dom || !mon || !dow) return null
  if (dow.has(7)) dow.add(0)
  const domAny = parts[2] === '*', dowAny = parts[4] === '*'
  let t = Math.floor(after / 6e4) * 6e4 + 6e4
  for (let i = 0; i < 366 * 1440; i++, t += 6e4) {
    const d = new Date(t + BJ)
    if (!mi.has(d.getUTCMinutes()) || !h.has(d.getUTCHours()) || !mon.has(d.getUTCMonth() + 1)) continue
    const dayOk = domAny && dowAny ? true
      : domAny ? dow.has(d.getUTCDay())
        : dowAny ? dom.has(d.getUTCDate())
          : dom.has(d.getUTCDate()) || dow.has(d.getUTCDay())
    if (dayOk) return t
  }
  return null
}

const fmt = (ms: number) => new Date(ms + BJ).toISOString().slice(0, 16).replace('T', ' ')

/** 指令里的占位符：{time} = 日期，星期，HH:MM；{date}；{weekday}；{hours} = 今天 0 点到现在几小时（填给 deep_recall） */
export function fillPlaceholders(text: string, now: BeijingNow) {
  const hh = String(Math.floor(now.minutes / 60)).padStart(2, '0'), mm = String(now.minutes % 60).padStart(2, '0')
  return text
    .replaceAll('{time}', `${now.date}，${now.weekdayLabel}，${hh}:${mm}`)
    .replaceAll('{date}', now.date)
    .replaceAll('{weekday}', now.weekdayLabel)
    .replaceAll('{hours}', String(Math.max(1, Math.ceil(now.minutes / 60))))
}

// ---- 任务存储 ----

export class JobStore {
  private jobs: Job[] = []
  /** 立即执行：会话 → 要执行的任务 id（看板按钮、/早安 这类命令），不影响下次执行时间 */
  private forced = new Map<string, string>()
  private runner?: (key: string) => boolean

  constructor(private config: Config, private store: Store, private logger?: { info(...a: unknown[]): void, warn(...a: unknown[]): void }) {
    try {
      if (existsSync(FILE)) this.jobs = JSON.parse(readFileSync(FILE, 'utf8'))
    } catch {}
    this.migrateLegacy()
  }

  private save() {
    writeFileSync(FILE, JSON.stringify(this.jobs, null, 2))
  }

  isSuper(userId: string) {
    return userId === this.config.owner?.id || this.config.superUsers.includes(userId)
  }

  /** 由 scheduler 接上：立即对某个会话跑一次任务 */
  setRunner(fn: (key: string) => boolean) {
    this.runner = fn
  }

  all() {
    return this.jobs
  }

  get(id: string) {
    const job = this.jobs.find(j => j.id === String(id ?? '').trim().replace(/^#/, ''))
    if (!job) throw new Error('没有这个任务，先 list 看看 id')
    return job
  }

  /** 校验触发方式，算出第一次执行的时间 */
  private firstRun(kind: string, when: string, superUser: boolean, now = Date.now()) {
    if (!['at', 'every', 'cron'].includes(kind)) throw new Error('kind 只能是 at / every / cron')
    if (kind === 'at') {
      const at = parseAt(when, now)
      if (!at) throw new Error('时间格式不对：写 "20m""2h""21:30" 或 "2026-10-24 09:00"（北京时间）')
      if (at < now - 60_000) throw new Error(`${fmt(at)} 已经过去了`)
      if (at > now + 366 * 864e5) throw new Error('最多只能设一年以内的')
      return at
    }
    if (kind === 'every') {
      const ms = parseDuration(when)
      if (!ms) throw new Error('间隔格式不对：写 "30m""2h""1d"')
      if (!superUser && ms < this.config.jobs.minIntervalMin * 6e4) throw new Error(`间隔最短 ${this.config.jobs.minIntervalMin} 分钟`)
      return now + ms
    }
    const next = nextCron(when, now)
    if (!next) throw new Error('cron 表达式不对：五段"分 时 日 月 周"，北京时间，例如 "0 9 * * 1-5" 是工作日早上 9 点')
    const second = nextCron(when, next)
    if (!superUser && second && second - next < this.config.jobs.minIntervalMin * 6e4) throw new Error(`两次之间最短隔 ${this.config.jobs.minIntervalMin} 分钟`)
    return next
  }

  private checkMessage(message: string, long?: boolean) {
    if (!message) throw new Error('message 要写清楚到时候做什么')
    const max = long ? MAX_SYSTEM_MESSAGE : MAX_MESSAGE
    if (message.length > max) throw new Error(`message 太长了（最多 ${max} 字）`)
  }

  add(target: Target, creatorId: string, input: JobInput) {
    if (!this.config.jobs.enabled) throw new Error('定时任务功能被主人关掉了')
    const kind = String(input.kind ?? '') as JobKind
    const when = String(input.when ?? '').trim()
    const message = String(input.message ?? '').trim()
    const superUser = this.isSuper(creatorId)
    this.checkMessage(message, superUser)
    const mine = this.jobs.filter(j => j.creatorId === creatorId && !j.system)
    if (!superUser && mine.length >= this.config.jobs.maxPerUser) throw new Error(`每人最多 ${this.config.jobs.maxPerUser} 个定时任务，TA 已经有 ${mine.length} 个了，先删掉旧的`)
    const now = Date.now()
    const job: Job = {
      id: randomBytes(3).toString('hex'),
      name: String(input.name ?? '').trim().slice(0, 30) || message.slice(0, 20),
      kind, when, message, target,
      creatorId,
      creatorName: this.store.profile(creatorId)?.name || '',
      createdAt: now,
      nextRunAt: this.firstRun(kind, when, superUser, now),
      runs: 0,
    }
    this.jobs.push(job)
    this.save()
    return job
  }

  /** 这个会话里的任务（含"全部群"的）；超级用户在私聊里能看到所有任务 */
  list(target: Target, viewerId: string) {
    if (target.scene === 'private' && this.isSuper(viewerId)) return this.jobs
    return this.jobs.filter(j => this.covers(j, target))
  }

  /** 能不能改、删这个任务：系统任务只有超级用户能动；别人设的只有本人或超级用户；不在这个会话的只有超级用户（在私聊里）能动 */
  private checkEdit(job: Job, viewerId: string, target: Target) {
    const superUser = this.isSuper(viewerId)
    if (job.system && !superUser) throw new Error('这是系统任务，只有主人能改')
    if (job.creatorId !== viewerId && !superUser) throw new Error('只有设这个任务的人（或者主人）能改')
    if (!this.covers(job, target) && !(superUser && target.scene === 'private')) throw new Error('这个任务不是在这里设的')
  }

  update(id: string, viewerId: string, target: Target, input: JobInput) {
    const job = this.get(id)
    this.checkEdit(job, viewerId, target)
    const superUser = this.isSuper(viewerId)
    const kind = input.kind ? String(input.kind) as JobKind : job.kind
    const when = input.when !== undefined && String(input.when).trim() ? String(input.when).trim() : job.when
    const enabled = input.enabled === undefined || input.enabled === '' ? job.enabled !== false : input.enabled === true || input.enabled === 'true'
    if (input.message !== undefined && String(input.message).trim()) {
      const message = String(input.message).trim()
      this.checkMessage(message, job.system || superUser)
      job.message = message
    }
    if (input.name !== undefined && String(input.name).trim()) job.name = String(input.name).trim().slice(0, 30)
    // 改了时间、或者从暂停恢复：从现在起重新算下一次（暂停期间错过的不补）
    if (kind !== job.kind || when !== job.when || (enabled && job.enabled === false)) {
      job.nextRunAt = this.firstRun(kind, when, superUser)
      job.kind = kind
      job.when = when
      delete job.done
    }
    job.enabled = enabled
    this.save()
    return job
  }

  remove(id: string, viewerId: string, target: Target) {
    const job = this.get(id)
    this.checkEdit(job, viewerId, target)
    this.jobs = this.jobs.filter(j => j !== job)
    this.save()
    return job
  }

  /** 立即对某个会话执行一次（不影响下次执行时间）；目标是"全部群"时 key 必须是其中一个群 */
  runNow(id: string, key: string) {
    const job = this.get(id)
    const [, scene, chat] = key.split(':')
    if (!this.covers(job, { key, scene: scene === 'group' ? 'group' : 'private', id: chat })) throw new Error('这个任务不在这个会话里')
    if (!this.runner) throw new Error('调度还没启动')
    this.forced.set(key, job.id)
    if (!this.runner(key)) {
      this.forced.delete(key)
      throw new Error('机器人不在线')
    }
    return job
  }

  /** 按名字找任务立即执行（自定义命令用）：先找 id 完全相同的，再找 id 以它开头的（greeting → greeting-owner） */
  runByName(name: string, key: string) {
    const [, scene, chat] = key.split(':')
    const target: Target = { key, scene: scene === 'group' ? 'group' : 'private', id: chat }
    const job = this.jobs.find(j => j.id === name && this.covers(j, target)) ?? this.jobs.find(j => j.id.startsWith(`${name}-`) && this.covers(j, target))
    if (!job) return false
    try {
      this.runNow(job.id, key)
      return true
    } catch {
      return false
    }
  }

  describeTarget(target: Target) {
    if (target.key === ALL_GROUPS.key) return '全部群'
    if (target.scene === 'private') return `私聊 ${this.store.profile(target.id)?.name || target.id.slice(0, 8)}`
    return `群 ${target.id.slice(0, 8)}`
  }

  describe(job: Job, withTarget = false) {
    const rule = job.kind === 'at' ? `一次，${fmt(job.nextRunAt)}` : job.kind === 'every' ? `每 ${job.when}` : `cron "${job.when}"`
    const state = job.enabled === false ? '已暂停' : `下次 ${fmt(job.nextRunAt)}`
    const who = job.system ? '系统任务' : `${job.creatorName || job.creatorId.slice(0, 8)} 设的`
    const message = job.message.length > 120 ? `${job.message.slice(0, 120)}…` : job.message
    return `#${job.id}「${job.name}」${withTarget ? `在${this.describeTarget(job.target)}，` : ''}${rule}，${state}，${who}，要做：${message}`
  }

  // ---- 调度 ----

  /** 任务覆盖这个会话吗（"全部群"覆盖所有群） */
  private covers(job: Job, target: Target) {
    return job.target.key === target.key || (job.target.key === ALL_GROUPS.key && target.scene === 'group')
  }

  /** 任务实际要发的会话："全部群"展开成她待过的群 */
  private targetsOf(job: Job): Target[] {
    if (job.target.key !== ALL_GROUPS.key) return [job.target]
    return knownGroups(this.store).map(id => ({ key: `qq:group:${id}`, scene: 'group', id }))
  }

  private active(job: Job) {
    // 总开关只管她帮人设的任务；早安、日记各自有开关
    return job.enabled !== false && (job.system || this.config.jobs.enabled)
  }

  /** 每次 tick 先整理：错过补做窗口的跳过这一轮；"全部群"的都做完了就进入下一轮 */
  private sweep(now = Date.now()) {
    let changed = false
    for (const job of [...this.jobs]) {
      if (!this.active(job) || job.nextRunAt > now) continue
      const expired = job.catchupMin !== undefined && now - job.nextRunAt > job.catchupMin * 6e4 + 60_000
      const allDone = job.target.key === ALL_GROUPS.key && this.targetsOf(job).every(t => job.done?.includes(t.key))
      if (expired || allDone) {
        if (expired) this.logger?.info('「%s」错过了 %s 的时间，跳过这一次', job.name, fmt(job.nextRunAt))
        this.advance(job, now, expired)
        changed = true
      }
    }
    if (changed) this.save()
  }

  private isDue(job: Job, target: Target, now: number) {
    return this.active(job) && job.nextRunAt <= now && this.covers(job, target) && !job.done?.includes(target.key)
  }

  /** 这个群今天（北京时间 0 点起）别人说了几条 */
  private todayCount(groupId: string, now: BeijingNow) {
    const since = Date.now() - now.minutes * 60_000 - (Date.now() % 60_000)
    return this.store.groupMessagesBetween(groupId, since, Date.now()).filter(m => m.user_id !== 'self').length
  }

  /** 挂在 scheduler 上的条件触发任务 */
  task(): ScheduledTask {
    /** 每个会话这一次执行的是哪些任务（prompt 里选好，sender / generated 里用） */
    const running = new Map<string, Job[]>()
    return {
      id: 'jobs',
      label: '定时任务',
      fallback: true,
      split: target => running.get(target.key)?.every(j => j.split ?? !j.system) ?? true,
      runLabel: target => running.get(target.key)?.map(j => j.name).join('、') || '定时任务',
      settings: () => ({ enabled: true }),
      targets: () => {
        this.sweep()
        const all = this.jobs.filter(j => this.active(j)).flatMap(j => this.targetsOf(j))
        return [...new Map(all.map(t => [t.key, t])).values()]
      },
      due: target => this.jobs.some(j => this.isDue(j, target, Date.now())),
      prompt: (target, bjNow) => {
        const now = Date.now()
        const forcedId = this.forced.get(target.key)
        this.forced.delete(target.key)
        let batch: Job[]
        if (forcedId) {
          const job = this.jobs.find(j => j.id === forcedId)
          if (!job) return null
          batch = [job]
        } else {
          const due = this.jobs.filter(j => this.isDue(j, target, now))
          if (!due.length) return null
          // 系统任务单独执行；她帮人设的一次只执行同一个人的，别人的下一次 tick 再执行（身份和记账不能混）
          batch = due[0].system ? [due[0]] : due.filter(j => !j.system && j.creatorId === due[0].creatorId)
          for (const job of batch) this.markDone(job, target, now)
          this.save()
          // 群里今天太安静的跳过（日记）
          batch = batch.filter(j => !j.minMessages || target.scene !== 'group' || this.todayCount(target.id, bjNow) >= j.minMessages)
          if (!batch.length) return null
        }
        running.set(target.key, batch)
        if (batch[0].system) return fillPlaceholders(batch[0].message, bjNow)
        const lines = batch.map(j => `「${j.name}」（${j.creatorName || '某人'} ${fmt(j.createdAt)} 让你设的）：${fillPlaceholders(j.message, bjNow)}`)
        return `（这不是谁发来的消息，是之前设的定时任务到点了。照下面的要求做，像平时聊天一样直接说，别提"定时任务"这几个字，除非是提醒）\n${lines.join('\n')}`
      },
      sender: (target) => {
        const creatorId = running.get(target.key)?.[0]?.creatorId ?? ''
        const owner = creatorId && creatorId === this.config.owner?.id
        return { id: creatorId, name: this.store.profile(creatorId)?.name || '', isAdmin: this.config.admins.includes(creatorId), isOwner: Boolean(owner) }
      },
      generated: (target, text, now) => {
        if (target.scene === 'group' && running.get(target.key)?.some(j => j.archive === 'diary')) saveDiary(now.date, target.id, text)
      },
    }
  }

  /** 这个会话这一轮做过了："全部群"的记下来，全做完才进入下一轮；单个会话的直接进入下一轮 */
  private markDone(job: Job, target: Target, now: number) {
    if (job.target.key !== ALL_GROUPS.key) return this.advance(job, now)
    job.done = [...(job.done ?? []), target.key]
    job.lastRunAt = now
    if (this.targetsOf(job).every(t => job.done!.includes(t.key))) this.advance(job, now, false, false)
  }

  /** 进入下一轮：at 删除；every / cron 算下一次（重启错过的不连环补，只补一次） */
  private advance(job: Job, now: number, skipped = false, count = true) {
    if (!skipped) {
      if (count) job.lastRunAt = now
      job.runs++
    }
    delete job.done
    if (job.kind === 'at') {
      this.jobs = this.jobs.filter(j => j !== job)
      return
    }
    const next = job.kind === 'every' ? (() => {
      const ms = parseDuration(job.when) ?? 864e5
      let t = job.nextRunAt + ms
      while (t <= now) t += ms
      return t
    })() : nextCron(job.when, now)
    if (next) job.nextRunAt = next
    else this.jobs = this.jobs.filter(j => j !== job)
  }

  // ---- 旧配置迁移 ----

  /**
   * 早安（greeting）、日记（diary）原来写在 config.yaml 里，各管各的。启动时如果配置里还有这两段，
   * 转成系统任务存进 jobs.json，再把这两段从 config.yaml 里删掉（只迁一次）。
   */
  private migrateLegacy() {
    let doc: YAML.Document.Parsed
    try {
      doc = YAML.parseDocument(readFileSync(CONFIG_PATH, 'utf8'))
    } catch {
      return
    }
    const raw = doc.toJS() ?? {}
    const g = raw.greeting, d = raw.diary
    if (!g && !d) return
    const owner = this.config.owner?.id ?? ''
    const ownerName = owner ? this.store.profile(owner)?.name || this.config.owner?.name || '' : ''
    const now = Date.now()
    const cronOf = (time: unknown, fallback: string) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? fallback).trim()) ?? /^(\d{1,2}):(\d{2})$/.exec(fallback)!
      return `${+m[2]} ${+m[1]} * * *`
    }
    const groupTargets = (groups: unknown): Target[] => Array.isArray(groups) && groups.length
      ? groups.map(id => ({ key: `qq:group:${id}`, scene: 'group' as const, id: String(id) }))
      : [ALL_GROUPS]
    const make = (id: string, name: string, when: string, message: string, target: Target, extra: Partial<Job>): Job => ({
      id, name, kind: 'cron', when, message: message.trim(), target,
      creatorId: owner, creatorName: ownerName, createdAt: now,
      nextRunAt: nextCron(when, now) ?? now + 864e5, runs: 0, system: true, ...extra,
    })
    const added: Job[] = []
    const push = (job: Job) => {
      if (this.jobs.some(j => j.id === job.id)) return
      this.jobs.push(job)
      added.push(job)
    }
    if (g) {
      const when = cronOf(g.time, '09:00')
      const extra = { enabled: g.enabled === true, catchupMin: Number(g.catchupMin ?? 120) }
      groupTargets(g.groups).forEach((t, i) => push(make(i ? `greeting-${i + 1}` : 'greeting', '群早安', when, g.groupPrompt || DEFAULT_PROMPTS.greetingGroup, t, extra)))
      if (g.owner !== false && owner) {
        push(make('greeting-owner', '主人早安', when, g.ownerPrompt || DEFAULT_PROMPTS.greetingOwner, { key: `qq:user:${owner}`, scene: 'private', id: owner }, extra))
      }
    }
    if (d) {
      const when = cronOf(d.time, '23:59')
      const extra: Partial<Job> = { enabled: d.enabled === true, catchupMin: Number(d.catchupMin ?? 0), minMessages: Number(d.minMessages ?? 10), archive: 'diary' }
      groupTargets(d.groups).forEach((t, i) => push(make(i ? `diary-${i + 1}` : 'diary', '写日记', when, d.prompt || DEFAULT_PROMPTS.diary, t, extra)))
    }
    this.save()
    doc.delete('greeting')
    doc.delete('diary')
    writeFileSync(CONFIG_PATH, doc.toString())
    this.logger?.info('早安、日记已从 config.yaml 迁到定时任务：%s', added.map(j => `#${j.id}「${j.name}」`).join('、') || '（已经有了，只删了旧配置）')
  }
}

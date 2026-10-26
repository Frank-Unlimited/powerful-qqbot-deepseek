/**
 * config 工具：超级用户在聊天里让她改配置。两步走：
 * 1. propose：只校验不写入，返回当前值、新值、生效方式、效果和风险，外加一个确认码；她要把这些讲给对方听并请对方确认
 * 2. confirm：对方在**后面的一轮**里确认后，带确认码生效。同一轮里 propose 完马上 confirm 会被拒（她不能替人确认），
 *    定时任务的回合也不能确认（没有真人在场）
 *
 * 三档生效方式各自处理：
 * - live：写入就生效
 * - dsh：写入后，等这一轮的回复发出去再重启 dsh（约 2 秒，QQ 不掉线）
 * - gateway：写入后，等这一轮的回复发出去再退出网关，由 pm2 拉起（约 15 秒，QQ 断开）；不在 pm2 下运行时不让改
 *
 * 身份类（主人、超级用户、管理员）、QQ 连接和看板端口只能在看板改；规则 / 命令这种结构化的字段也不走这里。
 */
import { randomBytes } from 'node:crypto'
import type { Context } from 'koishi'
import { FIELDS, type Config, type ConfigStore, type FieldSchema } from '../config.js'
import type { AgentClient } from '../bridge/types.js'

const BLOCKED = [/^owner\./, /^superUsers$/, /^admins$/, /^qq\./, /^dashboard\./]
const PROPOSAL_TTL_MS = 15 * 60_000

const TIER = {
  live: { name: '热生效', effect: '确认后立即生效，下一条消息就按新值来', risk: '不用重启' },
  dsh: { name: '重启 dsh 生效', effect: '确认后写入配置，这一轮回复发出去以后重启 dsh（约 2 秒），QQ 不掉线', risk: '重启那两秒里别的群、私聊正在进行的回复可能中断或失败' },
  gateway: { name: '重启网关生效', effect: '确认后写入配置，这一轮回复发出去以后重启网关（约 15 秒）', risk: 'QQ 会断开约 15 秒，期间的消息收不到；新配置有问题的话网关可能起不来，只能到电脑上改 config.yaml' },
} as const

/** 一些字段的额外风险提示（按路径前缀匹配，第一个命中的生效） */
const RISKS: [RegExp, string][] = [
  [/^quota\./, '影响大家每天能用多少额度，调大会多花钱'],
  [/^features\.ownerOnlyTools$/, '从列表里去掉的功能所有人都能用，联网、画图这些会花钱'],
  [/^agent\.model$/, '换模型会改变说话风格和价格（v4-pro 约贵 4.5 倍，而且不能看图）'],
  [/^agent\.reasoningEffort$/, '开思考会更慢，输出 token 更多更贵'],
  [/^agent\.(contextWindow|maxTokens)$/, '调大更贵；调小记性变差或者回复被截断'],
  [/^agent\.persona$/, '换人格文件；重启 dsh 后所有会话自动开新会话，聊天上下文会清空，长期记忆还在'],
  [/^agent\.timeoutSec$/, '调太小长回复会超时失败'],
  [/^(features\.webSearch|features\.voice|features\.lookImage|imageGen\.)/, '会产生真实费用'],
  [/^group\.trigger\./, '插话越多群里越吵，也越花 credits'],
  [/^idle\./, '寒暄太频繁会打扰群友，也花 credits'],
  [/^video\./, '视频调大会占更多磁盘、下载更慢'],
  [/^memory\./, '影响记忆召回和梳理，梳理会花 credits'],
  [/^jobs\./, '放宽后别人能设更多、更频繁的定时任务，花的是他们自己的额度'],
]

interface Proposal {
  token: string
  sessionKey: string
  path: string
  value: unknown
  seq: number
  by: string
  at: number
}

const show = (v: unknown) => {
  const text = typeof v === 'string' ? v : JSON.stringify(v)
  return text.length > 300 ? `${text.slice(0, 300)}…（共 ${text.length} 字）` : text
}

const getIn = (obj: any, path: string) => path.split('.').reduce((o, k) => o?.[k], obj)

export class ConfigAdmin {
  private logger
  private proposals = new Map<string, Proposal>()
  /** 这一轮结束后要做的重启 */
  private pendingRestart: 'dsh' | 'gateway' | null = null

  constructor(ctx: Context, private store: ConfigStore, private agent: AgentClient & { restart(): Promise<unknown> }) {
    this.logger = ctx.logger('config-tool')
  }

  private get config(): Config {
    return this.store.config
  }

  isSuper(userId: string) {
    return Boolean(userId) && (userId === this.config.owner?.id || this.config.superUsers.includes(userId))
  }

  /** 这一轮是谁发起的；不是超级用户直接拒绝 */
  private turnOf(sessionId: string) {
    const turn = this.agent.currentTurn(sessionId)
    if (!turn) throw new Error('无法确定当前发言人')
    if (!this.isSuper(turn.senderId)) throw new Error('只有超级用户能改配置，这次不能帮对方改，婉拒就好')
    return turn
  }

  private editable(f: FieldSchema) {
    return !BLOCKED.some(r => r.test(f.path)) && f.type !== 'rules' && f.type !== 'commands'
  }

  list(sessionId: string, keyword = '') {
    this.turnOf(sessionId)
    const k = keyword.trim().toLowerCase()
    const fields = FIELDS.filter(f => this.editable(f))
      .filter(f => !k || `${f.path} ${f.label} ${f.group} ${f.help ?? ''}`.toLowerCase().includes(k))
    if (!fields.length) return '没有匹配的配置项'
    return fields.slice(0, 40).map(f => [
      `${f.path}（${f.group} · ${f.label} · ${TIER[f.apply].name}）= ${show(getIn(this.config, f.path))}`,
      f.type === 'number' ? `  取值 ${f.min ?? '-∞'}～${f.max ?? '∞'}` : f.options ? `  可选：${f.options.join(' / ')}` : '',
      f.help ? `  说明：${f.help}` : '',
    ].filter(Boolean).join('\n')).join('\n') + (fields.length > 40 ? `\n……还有 ${fields.length - 40} 项，换个关键词缩小范围` : '')
  }

  propose(sessionId: string, path: string, raw: unknown) {
    const turn = this.turnOf(sessionId)
    if (turn.reason === 'schedule') throw new Error('定时任务里不能改配置')
    const field = FIELDS.find(f => f.path === path)
    if (!field) throw new Error(`没有配置项 ${path}，先用 list 查一下准确的名字`)
    if (!this.editable(field)) throw new Error(`${field.label} 只能主人在看板上改`)
    if (field.apply === 'gateway' && process.env.pm_id === undefined) throw new Error('网关不是由 pm2 托管的，重启后不会自动起来，这一项只能在电脑上改')
    // list / multi 也接受逗号分隔的字符串
    const { value } = this.store.normalize(path, raw)
    const current = getIn(this.config, path)
    if (JSON.stringify(current) === JSON.stringify(value)) throw new Error(`${field.label} 现在就是 ${show(value)}，不用改`)
    const token = randomBytes(3).toString('hex')
    // 一个会话同时只留一个待确认的修改
    for (const [t, p] of this.proposals) if (p.sessionKey === turn.sessionKey || Date.now() - p.at > PROPOSAL_TTL_MS) this.proposals.delete(t)
    this.proposals.set(token, { token, sessionKey: turn.sessionKey, path, value, seq: turn.seq, by: turn.senderId, at: Date.now() })
    const tier = TIER[field.apply]
    const extra = RISKS.find(([r]) => r.test(path))?.[1]
    this.logger.info('%s 提议修改 %s：%s → %s（确认码 %s）', turn.sessionKey, path, show(current), show(value), token)
    return [
      `待确认的修改（确认码 ${token}，15 分钟内有效）：`,
      `配置项：${field.label}（${path}）`,
      `当前值：${show(current)}`,
      `改成：${show(value)}`,
      `生效方式：${tier.name}。${tier.effect}`,
      `风险：${[tier.risk, extra].filter(Boolean).join('；')}`,
      field.help ? `说明：${field.help}` : '',
      '把上面的效果和风险用你自己的话告诉对方，问 TA 确不确定要改。等 TA 下一条消息明确同意，再用 confirm 带上确认码生效；TA 不同意就用 cancel 取消。现在不能直接 confirm。',
    ].filter(Boolean).join('\n')
  }

  confirm(sessionId: string, token: string) {
    const turn = this.turnOf(sessionId)
    if (turn.reason === 'schedule') throw new Error('定时任务里不能确认修改，要等对方本人说')
    const p = this.proposals.get(String(token ?? '').trim())
    if (!p || p.sessionKey !== turn.sessionKey) throw new Error('没有这个确认码（可能已经过期、被取消，或者不是在这里提的），重新 propose')
    if (Date.now() - p.at > PROPOSAL_TTL_MS) {
      this.proposals.delete(p.token)
      throw new Error('确认码已过期（15 分钟），重新 propose 并再问一次对方')
    }
    if (turn.seq <= p.seq) throw new Error('还没问对方：先把效果和风险告诉对方，等 TA 下一条消息同意了再 confirm')
    this.proposals.delete(p.token)
    const field = FIELDS.find(f => f.path === p.path)!
    if (field.apply === 'gateway' && process.env.pm_id === undefined) throw new Error('网关不是由 pm2 托管的，不能自动重启，没有修改')
    this.store.set(p.path, p.value)
    this.logger.info('%s 确认修改 %s = %s（提议 %s，确认 %s）', turn.sessionKey, p.path, show(p.value), p.by, turn.senderId)
    if (field.apply === 'live') return `已生效：${field.label} = ${show(p.value)}`
    // 两档重启都排到这一轮回复发出去以后；网关重启优先（会顺带重启 dsh）
    if (field.apply === 'gateway' || this.pendingRestart !== 'gateway') this.pendingRestart = field.apply
    return field.apply === 'dsh'
      ? `已写入：${field.label} = ${show(p.value)}。这句回复发出去后 dsh 会重启（约 2 秒），之后生效`
      : `已写入：${field.label} = ${show(p.value)}。这句回复发出去后网关会重启，QQ 断开约 15 秒，之后生效`
  }

  cancel(sessionId: string, token: string) {
    const turn = this.turnOf(sessionId)
    const p = this.proposals.get(String(token ?? '').trim())
    if (!p || p.sessionKey !== turn.sessionKey) return '没有这个待确认的修改，不用取消'
    this.proposals.delete(p.token)
    return `已取消：不改 ${p.path}`
  }

  /** 每一轮回复发出去以后调用：执行排着的重启 */
  async afterTurn() {
    const restart = this.pendingRestart
    if (!restart) return
    this.pendingRestart = null
    if (restart === 'dsh') {
      this.logger.info('配置已改，重启 dsh')
      await this.agent.restart().catch(e => this.logger.warn('重启 dsh 失败：%s', (e as Error).message))
      return
    }
    this.logger.info('配置已改，重启网关（由 pm2 拉起）')
    setTimeout(() => process.exit(0), 1000)
  }
}

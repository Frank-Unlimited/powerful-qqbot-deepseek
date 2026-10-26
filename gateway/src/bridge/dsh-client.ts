import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from 'koishi'
import { DeepSeekHarness, HarnessSession, type SdkPromptContentBlock } from '@deepseek-ai/dsh-sdk-client'
import type { Config } from '../config.js'
import { ROOT, PROFILE_DIR, profilePath } from '../config.js'
import { chargesOf } from '../billing.js'
import { TOOLS_MANIFEST, toolLabel } from '../tools-manifest.js'
import { STICKER_STRATEGY } from '../stickers/sticker-lib.js'
import type { Store } from '../../../shared/store.mjs'
import type { Features } from '../config.js'
import type { MemoryItem, MemoryService } from '../memory.js'
import type { PortraitService } from '../portrait.js'
import { type ActivityLog, eventsToActivity } from '../activity.js'
import { anchorHint, chatOfKey, logToolCalls, newTurnId } from '../short-term.js'
import type { AgentClient, AgentReply, AgentRequest, OutboxItem, TurnInfo } from './types.js'

const SILENT = '[沉默]'
const TURN_COUNTS_FILE = resolve(ROOT, 'data/turn-counts.json')
/** dsh 当前用的人格文件名，用来发现「换了人格文件」 */
const ACTIVE_PERSONA_FILE = resolve(ROOT, 'data/active-persona.txt')
function loadJson(file: string) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  } catch {
    return {}
  }
}

/** 通过 stdio JSON-RPC 驱动一个 dsh 子进程；所有 QQ 会话共用这一个进程。 */
export class DshClient implements AgentClient {
  private harness: DeepSeekHarness
  private sessions = new Map<string, Promise<HarnessSession>>()
  /** 每个会话已回复的次数，用于按间隔提示主动发表情包 */
  /** 每个会话回复了多少轮（主动表情包间隔用）；存在 data/turn-counts.json，重启不清零 */
  private turnCounts: Record<string, number> = loadJson(TURN_COUNTS_FILE)
  /** 每个 dsh 会话当前这一轮：全局递增编号、触发原因、发言人（config 工具的二次确认要求确认发生在后面的一轮） */
  private turnSeq = 0
  private currentTurns = new Map<string, TurnInfo>()
  /** 群友画像（网关启动时挂上；没挂就只按人召回记忆） */
  portraits?: PortraitService
  private logger

  constructor(ctx: Context, private config: Config['agent'], private store: Store, private features: Features, private memory: MemoryService, private activity: ActivityLog, private onRestarted: () => void,
    private stickers: Config['stickers'] = { allowSubjects: [], defaultSubjects: [], requireReview: true, archiveDir: 'assets/archive' },
    private imageGen: Config['imageGen'] = { lowModel: 'cogview-3-flash', highModel: 'doubao-seedream-5-0-flash-260915', defaultQuality: 'low', reference: '' },
    private cover?: Config['cover']) {
    this.logger = ctx.logger('dsh')
    mkdirSync(resolve(ROOT, 'data/dsh-workspace'), { recursive: true })
    this.harness = this.createHarness()
    ctx.on('ready', () => this.startHarness())
    ctx.on('dispose', () => this.harness.close())
  }

  /** 模型参数：直接读 config.yaml（ConfigStore 原地更新）；改了要 restart() 才会作用到 dsh 进程 */
  get runtime() {
    const { model, reasoningEffort, maxTokens, contextWindow } = this.config
    return { model, reasoningEffort, maxTokens, contextWindow }
  }

  private createHarness() {
    const workspace = resolve(ROOT, 'data/dsh-workspace')
    const rt = this.runtime
    return new DeepSeekHarness({
      // 显式指定入口：网关以 CommonJS 运行，SDK 自带的 import.meta.resolve 查找不可用
      dshBin: resolve(ROOT, 'gateway/node_modules/@deepseek-ai/dsh/lib/bin.js'),
      profile: 'sdk-minimal',
      patches: [this.writePatch()],
      dshHome: resolve(ROOT, 'data/dsh-home'),
      cwd: workspace,
      processCwd: workspace,
      provider: 'deepseek-official',
      model: rt.model,
      ...(rt.reasoningEffort !== 'off' ? { reasoningEffort: rt.reasoningEffort as any } : {}),
      maxTokens: rt.maxTokens,
      env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' },
      initializeTimeoutMs: 60_000,
    })
  }

  /**
   * 换了人格文件就让所有会话开新会话：dsh 为了保住前缀缓存，会话中途换系统提示词只会把新的追加到历史末尾，
   * 开头还是旧人格、后面还跟着一长串旧人格的对话，基本不生效。长期记忆不受影响。
   */
  private syncPersona() {
    const persona = this.config.persona
    const previous = existsSync(ACTIVE_PERSONA_FILE) ? readFileSync(ACTIVE_PERSONA_FILE, 'utf8').trim() : ''
    if (previous && previous !== persona) {
      const keys = this.store.listSessions().map(s => s.key)
      for (const key of keys) this.store.resetSession(key)
      this.sessions.clear()
      this.logger.info('人格文件从 %s 换成 %s，%d 个会话都开了新会话', previous, persona, keys.length)
    }
    if (previous !== persona) writeFileSync(ACTIVE_PERSONA_FILE, persona)
  }

  private startHarness() {
    const rt = this.runtime
    this.syncPersona()
    return this.harness.start().then(
      () => this.logger.info('dsh 已启动（模型 %s，推理强度 %s，上下文 %d）', rt.model, rt.reasoningEffort, rt.contextWindow),
      e => this.logger.error('dsh 启动失败：%s', e),
    )
  }

  currentTurn(sessionId: string): TurnInfo | undefined {
    return this.currentTurns.get(sessionId)
  }

  /** 改了模型 / 推理强度等参数后重启 dsh 子进程；会话历史在磁盘上，重启后自动恢复。 */
  async restart() {
    this.logger.info('按新参数重启 dsh…')
    const old = this.harness
    this.sessions.clear()
    this.harness = this.createHarness()
    await old.close().catch(e => this.logger.warn('关闭旧 dsh 失败：%s', e))
    await this.startHarness()
    this.onRestarted()
    return this.runtime
  }

  /** 生成本次启动用的 profile 补丁：关闭内置 shell / 文件工具和日志上传，挂载 shark-bot 插件。 */
  private writePatch() {
    const { config } = this
    const rt = this.runtime
    const patch = [
      {
        id: 'llm-deepseek',
        config: {
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          thinking: rt.reasoningEffort === 'off' ? 'disabled' : 'enabled',
          reasoningEffort: rt.reasoningEffort,
          maxTokens: rt.maxTokens,
          // 聊天场景不需要百万上下文，窗口设小一点让压缩更早发生，省钱
          defaultContextWindow: rt.contextWindow,
          streamIdleTimeoutMs: 120_000,
        },
      },
      { id: 'system-prompt', config: { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '' } },
      { id: 'persistent-pwsh', disabled: true },
      { id: 'persistent-bash', disabled: true },
      { id: 'tool-fs', disabled: true },
      { id: 'tool-working-directory', disabled: true },
      { id: 'session-log-deepseek', disabled: true },
      // 联网：DeepSeek Search & Fetch API（一次请求一次检索，不额外调用模型）；
      // 不挂 dsh 自带的 tool-web，模型可见的 web_search / web_fetch 由 shark-bot 插件提供，便于加开关和权限
      {
        insert: [
          {
            id: 'web',
            name: '@deepseek-ai/dsh-web',
            config: { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' },
          },
          { id: 'web-deepseek-api', name: '@deepseek-ai/dsh-web-deepseek-api', config: { apiKeyEnv: 'DEEPSEEK_API_KEY', count: 8 } },
        ],
      },
      { id: 'plugin-package-inventory-deepseek', disabled: true },
      {
        insert: [{
          id: 'shark-bot',
          name: resolve(ROOT, 'gateway/dsh-plugin/index.mjs').replaceAll('\\', '/'),
          config: {
            storePath: resolve(ROOT, 'data/store.db'),
            personaPath: profilePath('persona', `${config.persona}.yaml`),
            stickerDir: profilePath('assets/stickers'),
            archiveDir: profilePath(this.stickers.archiveDir),
            outboxDir: resolve(ROOT, 'data/outbox'),
            tts: config.tts,
            // 看图固定用 flash：v4-pro 不支持图片输入
            vision: { model: 'deepseek-flash' },
            toolsManifestPath: TOOLS_MANIFEST,
            requestsDir: resolve(ROOT, 'data/requests'),
            settingsPath: resolve(ROOT, 'data/settings.json'),
            memoryApi: `http://127.0.0.1:${config.dashboardPort}/internal/memory`,
            stickerApi: `http://127.0.0.1:${config.dashboardPort}/internal/stickers`,
            videoApi: `http://127.0.0.1:${config.dashboardPort}/internal/video`,
            // 翻唱关掉时不注册 sing_cover（改了要重启 dsh）
            coverApi: this.cover?.enabled ? `http://127.0.0.1:${config.dashboardPort}/internal/cover` : '',
            configApi: `http://127.0.0.1:${config.dashboardPort}/internal/config`,
            jobsApi: `http://127.0.0.1:${config.dashboardPort}/internal/jobs`,
            profileDir: PROFILE_DIR,
            imageGen: this.imageGen,
            // 写进工具描述的发表情策略和题材范围（改了要重启 dsh）
            stickerStrategy: STICKER_STRATEGY,
            stickerSubjects: this.stickers.allowSubjects,
          },
        }],
      },
    ]
    const path = resolve(ROOT, 'data/shark.patch.json')
    mkdirSync(resolve(ROOT, 'data'), { recursive: true })
    writeFileSync(path, JSON.stringify(patch, null, 2))
    return path
  }

  /** 进程重启后先尝试恢复已有会话，没有就新建。 */
  private open(sessionId: string) {
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = this.harness.resumeSession(sessionId).catch((e) => {
        this.logger.info('恢复会话 %s 失败，改为新建：%s', sessionId, (e as Error).message)
        return this.harness.session(sessionId)
      })
      // 打开失败不缓存，下一条消息重新尝试（否则这个会话会一直失败到重启）
      session.catch(() => this.sessions.delete(sessionId))
      this.sessions.set(sessionId, session)
    }
    return session
  }

  async chat(req: AgentRequest, signal: AbortSignal): Promise<AgentReply> {
    const sessionId = this.store.sessionId(req.sessionKey)
    const turn = req.turn ?? newTurnId()
    // 私聊事件不带昵称，空名字不覆盖群里记下的昵称
    if (req.reason !== 'schedule' && req.sender.name) this.store.touchProfile(req.sender.id, req.sender.name)
    this.store.setTurn(sessionId, req.sender.id, req.groupId)
    this.currentTurns.set(sessionId, { seq: ++this.turnSeq, reason: req.reason, senderId: req.sender.id, sessionKey: req.sessionKey, turn, isOwner: req.sender.isOwner, mentions: req.mentions ?? [] })

    // 图片不直接给主模型（贵），消息里只有「[图片#N]」占位，需要时模型调用 look_image
    const blocks: SdkPromptContentBlock[] = [{ type: 'text', text: await this.compose(req) }]

    const session = await this.open(sessionId)
    // SDK 没有取消接口：超时只是不再等待，这一轮仍会在后台跑完
    const result = await Promise.race([
      session.run(blocks),
      new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    ])

    // 模型请求失败（Key 错误、限流、网络）时只有 assistant/attempt 事件，没有正式回复
    if (!result.events.some(e => e.type === 'assistant/message')) {
      const attempts = result.events.filter(e => e.type === 'assistant/attempt')
      // 失败原因在 attempt 的流记录里：{ chunk: { type: 'finish', reason: { kind: 'error', failure: { message, status } } } }
      type Record = { chunk?: { type: string, reason?: { failure?: { message: string, status?: number } } } }
      const failure = attempts
        .flatMap(e => (e.data as { stream: Record[] }).stream)
        .map(r => r.chunk?.type === 'finish' ? r.chunk.reason?.failure : undefined)
        .filter(Boolean)
        .pop()
      const reason = failure ? `${failure.status ?? ''} ${failure.message}`.trim() : '未知原因，检查 DEEPSEEK_API_KEY 和网络'
      throw new Error(`模型请求失败（${attempts.length} 次）：${reason}`)
    }

    // 短期记忆：这一轮的工具调用和结果写进原文
    try {
      logToolCalls(this.store, chatOfKey(req.sessionKey), turn, result.events, this.memory.settings.shortTerm.toolResultChars)
      this.store.closeAnchors(turn)
    } catch (e) {
      this.logger.warn('记录工具调用原文失败：%s', (e as Error).message)
    }

    // 活动日志：每次模型调用、每次工具调用各一条（看板图表的数据源）
    for (const a of eventsToActivity(result.events, req.sessionKey, this.runtime.model)) {
      this.activity.log({ ...a, sourceRef: `${sessionId}#${a.sourceRef}` })
    }

    const outbox: OutboxItem[] = []
    for (const event of result.events) {
      if (event.type === 'tool/result' && !event.data.message.isError) {
        const meta = (event.data as { meta?: { outbox?: OutboxItem } }).meta
        if (meta?.outbox?.src) outbox.push(toSendable(meta.outbox))
      }
    }
    // 这一轮的全部真实费用：每次模型调用 + 看图、联网、语音等工具（由网关记到发起人头上）
    const charges = chargesOf(result.events, this.runtime.model)

    let text = cleanup(result.finalResponse)
    for (const [from, to] of Object.entries(this.config.replaceWords ?? {})) text = text.replaceAll(from, to)
    text = text.replace(/，{2,}/g, '，').replace(/^[，、\s]+/, '').trim()
    return { text: text === SILENT ? '' : text, outbox, charges, silent: text === SILENT && !outbox.length, turn }
  }

  async reset(sessionKey: string) {
    this.sessions.delete(this.store.sessionId(sessionKey))
    this.store.resetSession(sessionKey)
  }

  /** 把场景信息写成用户消息头部；记忆放在这里而不是系统提示词里，不会破坏前缀缓存。 */
  private async compose(req: AgentRequest) {
    const lines: string[] = []
    const profile = this.store.profile(req.sender.id)
    const name = req.sender.name || profile?.name || ''
    const who = name
    // 定时任务没有发送者：群里是对大家说，私聊是对主人说
    if (req.reason === 'schedule') lines.push(req.scene === 'group' ? '[群聊] 没人说话，是你自己主动开口' : `[私聊] 对方：${who || '主人'}，是你主动找 TA`)
    else lines.push(req.scene === 'group' ? `[群聊] 发送者：${who || '群友'}` : `[私聊] 对方：${who || '好友'}`)
    // 主人验证放在正文紧上方（见下），离得远时模型容易漏看，被"我是你主人"这类话带偏
    // 定时任务在群里没人跟她说话（只是借用主人的权限），不写"对方是主人"，免得她以为是主人在跟她说话
    const scheduledInGroup = req.reason === 'schedule' && req.scene === 'group'
    // 明确告诉她这一轮能用全部工具：历史里如果留着"只有主人能用"的报错，她会以为工具一直用不了而不敢再调
    if (req.reason === 'schedule' && req.sender.isOwner) lines.push('[这一轮用的是主人的权限：仅限主人的工具（画图、联网等）也都能用，需要就直接调用]')
    const verified = req.sender.isOwner && !scheduledInGroup ? (req.reason === 'schedule' ? '[已验证：对方就是你的主人]' : '[已验证：发送者就是你的主人]') : ''
    if (!req.sender.isOwner && req.sender.isAdmin) lines.push('[发送者是你的管理员]')
    if (req.reason === 'interest') lines.push(`[插话判断：没人叫你，觉得没必要接话就只回复 ${SILENT}]`)

    const settings = this.features
    if (settings.ownerOnlyTools.length && !req.sender.isOwner && req.reason !== 'schedule') {
      const names = settings.ownerOnlyTools.map(toolLabel).join('、')
      lines.push(`[此人不是主人：${names}只给主人用（工具会直接拒绝），对方要求时用角色口吻婉拒]`)
    }
    // 按间隔提示主动发一次表情包；表情包被设成仅限主人、而对方不是主人时不提示（工具会拒绝）
    const count = (this.turnCounts[req.sessionKey] ?? 0) + 1
    this.turnCounts[req.sessionKey] = count
    writeFileSync(TURN_COUNTS_FILE, JSON.stringify(this.turnCounts))
    const stickerAllowed = req.sender.isOwner || !settings.ownerOnlyTools.includes('send_sticker')
    if (settings.stickers && stickerAllowed && settings.stickerEvery > 0 && count % settings.stickerEvery === 0) {
      lines.push('[这一轮顺手用 send_sticker 发一个和你的回复情绪相符的表情包]')
    }

    if (req.observed.length) {
      lines.push('[近期群聊]')
      for (const m of req.observed) lines.push(`${m.name}：${m.text}`)
    }
    if (req.quote) lines.push(`[引用 ${req.quote.name} 的消息：${req.quote.text || '（无文字）'}]`)

    // 长期记忆（mem0 语义检索）：当前发言人 + 当前群（可关）。检索失败不影响聊天
    const recall = this.memory.settings
    let scopes = [`user:${req.sender.id}`, ...(req.groupId && recall.recallGroup ? [`group:${req.groupId}`] : [])]
    // 回复某条消息时，被引用的内容也参与检索
    let query = req.quote?.text ? `${req.text}\n${req.quote.text}` : req.text
    if (req.reason === 'schedule' && req.groupId) {
      // 定时任务（日记等）没有发言人：改为从今天发过言的群友的记忆里，按今天聊的内容检索
      const local = Date.now() + 8 * 3600_000
      const today = local - (local % 86400_000) - 8 * 3600_000
      const speakers = this.store.groupRank(req.groupId, today, undefined, 'self', 8).map(r => `user:${r.userId}`)
      const recent = this.store.groupHistory(req.groupId, today, 40).filter(m => m.user_id !== 'self').map(m => m.text.replace(/\[图片\]/g, '')).join(' ')
      scopes = [...speakers, `group:${req.groupId}`]
      if (recent.trim()) query = recent.slice(-600)
    }
    const audit = { sessionKey: req.sessionKey, userId: req.sender.id, via: 'auto' as const }
    const failed = (e: Error): MemoryItem[] => {
      this.logger.warn('记忆检索失败：%s', e.message)
      return []
    }
    // 路 A（按人保底）：发言人 + 这句话里 @ 到 / 被引用的人，每人几条，不受相关度下限影响；定时任务没有真的发言人，不走这条
    const people = req.reason === 'schedule' ? [] : [
      { id: req.sender.id, name: who || '对方', role: req.scene === 'group' ? '发言人' : '对方' },
      ...(req.mentions ?? []).slice(0, recall.portrait.mentionLimit).map(m => ({ id: m.id, name: m.name, role: m.via === 'at' ? '被@' : '被引用' })),
    ]
    const groupScopes = req.groupId ? [`group:${req.groupId}`] : []
    const [perPerson, general] = await Promise.all([
      // 被提到的人（不是发言人本人）只带群聊来源的记忆，免得把 TA 私聊里的事说给别人听
      Promise.all(people.map((p, i) => this.memory.searchPerson(p.id, groupScopes, query, recall.portrait.personLimit, audit, i > 0).catch(failed))),
      this.config.memoryLimit <= 0 ? [] : this.memory.search(scopes, query, this.config.memoryLimit, audit).catch(failed),
    ])
    // 路 B（语义）：去掉路 A 已经给过的
    const shown = new Set(perPerson.flat().map(m => m.id))
    const memories = general.filter(m => !shown.has(m.id))
    this.activity.log({ sessionKey: req.sessionKey, kind: 'memory_read', detail: `自动检索（命中 ${shown.size + memories.length}）`, auto: true })
    const chat = chatOfKey(req.sessionKey)
    const memoryLine = (m: MemoryItem) => {
      const from = anchorHint(this.store, m.id, chat)
      return `#${m.id.slice(0, 8)} ${m.scope.startsWith('group:') ? '（本群）' : ''}${m.memory}${from ? `（${from}）` : ''}`
    }
    const sessionId = this.store.sessionId(req.sessionKey)
    people.forEach((p, i) => {
      // 画像：发言人隔一段时间放一次全文，其余只放一句话；被提到的人只放不涉及私事的几节
      const portrait = this.portraits?.header(p.id, sessionId, i === 0 ? 'self' : 'mention')
      if (!perPerson[i].length && !portrait) return
      lines.push(`[关于 ${p.name}（${p.role}）]${portrait?.summary ? ` ${portrait.summary}` : ''}`)
      if (portrait?.detail) lines.push(`[画像] ${portrait.detail}`)
      for (const m of perPerson[i]) lines.push(memoryLine(m))
    })
    if (memories.length) {
      lines.push('[相关记忆]')
      for (const m of memories) lines.push(memoryLine(m))
    }

    lines.push('', ...(verified ? [verified] : []), req.text)
    // 当前时间放在本轮消息的最末尾：之前的对话都是固定前缀，加在这里不影响缓存命中
    lines.push('', `[现在是北京时间 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'full', timeStyle: 'short' })}]`)
    // 人设提醒放在最最后：长上下文里开头和结尾最受重视，中间容易被忽略
    if (this.config.tailReminder?.trim()) lines.push(this.config.tailReminder.trim())
    return lines.join('\n')
  }

}

/** 本地文件转成 file:// 地址，网关的 QQ 适配器能直接读取上传。 */
function toSendable(item: OutboxItem): OutboxItem {
  return /^(https?|file|data):/.test(item.src) ? item : { ...item, src: pathToFileURL(item.src).href }
}

/** 兜底清理：去掉模型偶尔带出的 Markdown 标记和链接。 */
function cleanup(text: string) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/https?:\/\/\S+/g, '')
    .trim()
}

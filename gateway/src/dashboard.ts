import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from 'koishi'
import YAML from 'yaml'
import type { Config, ConfigStore } from './config.js'
import { ROOT, profilePath } from './config.js'
import type { GroupMessage, MemoryAnchor, Store } from '../../shared/store.mjs'
import type { AgentClient } from './bridge/types.js'
import type { MemoryItem, MemoryService } from './memory.js'
import { SECTIONS, type PortraitService } from './portrait.js'
import type { ActivityLog } from './activity.js'
import { beijingDay, type Quota } from './bridge/quota.js'
import { listTools } from './tools-manifest.js'
import { listCommands } from './bridge/commands.js'
import { ALL_GROUPS, type JobStore } from './bridge/jobs.js'
import type { Target } from './bridge/scheduler.js'
import { registerOptionSource } from './config-options.js'
import { FETCH_PRICE, IMAGE_PRICES, ITEM_LABEL, SEARCH_PRICE, TOKEN_PRICES, TTS_PRICE_PER_CHAR, WEB_BILLED_FROM } from './billing.js'
import { PassThrough } from 'node:stream'

const PERSONA_DIR = profilePath('persona')
const SESSIONS_DIR = resolve(ROOT, 'data/dsh-home/sessions')
const PAGE = resolve(ROOT, 'gateway/dashboard/index.html')

/**
 * 本地看板：http://127.0.0.1:<port>/
 * 只监听本机回环地址，没有登录；不要把端口映射到公网。
 */
export function dashboard(ctx: Context, configStore: ConfigStore, store: Store, agent: AgentClient, memory: MemoryService, activity: ActivityLog, quota: Quota, portraits: PortraitService, videos?: { todayCount(): number }, jobs?: JobStore) {
  const { config } = configStore
  const router = ctx.server
  const startedAt = Date.now()

  router.get('/', (koa) => {
    koa.type = 'html'
    koa.body = readFileSync(PAGE, 'utf8').replaceAll('{{BOT_NAME}}', config.bot.name)
  })
  router.get('/avatar.png', (koa) => {
    koa.type = 'image/png'
    // 头像放在角色包 assets/character/avatar.png；没有就不显示
    const file = profilePath('assets/character/avatar.png')
    if (!existsSync(file)) return void (koa.status = 404)
    koa.body = readFileSync(file)
  })
  router.get('/charts.js', (koa) => {
    koa.type = 'application/javascript'
    koa.body = readFileSync(resolve(ROOT, 'gateway/dashboard/charts.js'), 'utf8')
  })

  router.get('/api/overview', async (koa) => {
    const bot = ctx.bots.find(b => b.platform === 'qq')
    koa.body = {
      bot: bot ? { name: bot.user?.name, status: ['离线', '在线', '连接中', '断开中', '重连中'][bot.status] } : null,
      startedAt,
      config: redact(config),
      credits: store.creditsByDay(beijingDay()).global,
      videos: videos?.todayCount() ?? 0,
    }
  })

  router.get('/api/sessions', async (koa) => {
    const profiles = new Map(store.listProfiles().map(p => [p.user_id, p]))
    const sums = store.creditsByDay(beijingDay())
    koa.body = store.listSessions().map((s) => {
      const isGroup = s.key.startsWith('qq:group:')
      const id = isGroup ? s.key.slice(9) : s.key.slice(8)
      const p = profiles.get(s.lastUserId)
      // 今日用量：群看群账，私聊看这个人的账
      const usage = (isGroup ? sums.groups : sums.users).find(u => u.id === id) ?? null
      return { ...s, lastUserName: p?.call_name || p?.name || s.lastUserId, usage }
    })
  })

  router.get('/api/sessions/messages', (koa) => {
    koa.body = readSessionMessages(String(koa.query.id), Math.min(Number(koa.query.limit) || 60, 5000))
  })

  /** 一个会话的所有段：/shark.reset、换人格文件都会开新的一段，旧的一段还在磁盘上 */
  router.get('/api/sessions/generations', (koa) => {
    const key = String(koa.query.key)
    koa.body = { current: store.sessionId(key), list: listGenerations(key) }
  })

  /** LLM 输入检视：某个会话最近 40 次真正发给 DeepSeek 的请求，配上每次的 token 用量和模型输出 */
  router.get('/api/inspect', (koa) => {
    koa.body = inspectSession(String(koa.query.id))
  })

  router.post('/api/sessions/reset', async (koa) => {
    await agent.reset(String((koa.request as any).body.key))
    koa.body = { ok: true }
  })

  // 看板里「选群」「选人」的字段
  // 只列真实的 QQ openid（32 位十六进制），跳过本地测试留下的会话
  const isOpenid = (id: string) => /^[0-9A-F]{32}$/i.test(id)
  registerOptionSource('groups', () => store.listSessions().filter(s => s.key.startsWith('qq:group:') && isOpenid(s.key.slice(9))).map((s) => {
    const id = s.key.slice(9)
    return { value: id, label: `群 ${id.slice(0, 8)}…`, desc: `最近 ${new Date(s.updated).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` }
  }))
  registerOptionSource('users', () => store.listProfiles().filter(p => isOpenid(p.user_id)).map(p => ({ value: p.user_id, label: p.name || `${p.user_id.slice(0, 8)}…`, desc: p.user_id })))

  // 命令：内置（只读）+ 自定义（增删改走 PUT /api/config，path = commands）
  router.get('/api/commands', (koa) => {
    koa.body = {
      commands: listCommands(config),
      custom: config.commands,
      // 定时任务（按 id 执行，greeting 会匹配到 greeting-owner）+ 冷场寒暄
      tasks: [...(jobs?.all() ?? []).map(j => ({ id: j.id, label: `${j.name}（#${j.id}）` })), { id: 'idle', label: '冷场寒暄' }],
    }
  })

  // ---- 定时任务：早安、日记这些系统任务和她帮人设的，统一在这里看和改；看板按主人的身份操作 ----
  const asOwner = () => {
    const id = config.owner?.id
    if (!id) throw new Error('config.yaml 里没配主人（owner.id），看板没法以主人身份改任务')
    return id
  }
  const targetOf = (key: string): Target => {
    if (key === ALL_GROUPS.key) return ALL_GROUPS
    const [, scene, id] = key.split(':')
    if (!id || !['group', 'user'].includes(scene)) throw new Error('目标会话不对')
    return { key, scene: scene === 'group' ? 'group' : 'private', id }
  }
  const jobRoute = (method: 'get' | 'post' | 'put' | 'delete', path: string, handler: (koa: any) => unknown) => {
    router[method](path, (koa: any) => {
      if (!jobs) return badRequest(koa, '定时任务没启动')
      try {
        koa.body = handler(koa) ?? { ok: true }
      } catch (e) {
        badRequest(koa, (e as Error).message)
      }
    })
  }
  jobRoute('get', '/api/jobs', () => ({
    enabled: config.jobs.enabled,
    jobs: jobs!.all().map(j => ({ ...j, targetLabel: jobs!.describeTarget(j.target) })),
    // 新建时可选的会话：全部群、她待过的每个群、私聊过她的人
    targets: [
      { key: ALL_GROUPS.key, label: '全部群（以后进的群也算）' },
      ...store.listSessions().filter(s => /^qq:(group|user):[0-9A-F]{32}$/i.test(s.key)).map(s => ({ key: s.key, label: jobs!.describeTarget(targetOf(s.key)) })),
    ],
  }))
  jobRoute('post', '/api/jobs', (koa) => {
    const { target, ...input } = koa.request.body ?? {}
    return jobs!.add(targetOf(String(target ?? '')), asOwner(), input)
  })
  jobRoute('put', '/api/jobs/:id', (koa) => {
    const job = jobs!.get(koa.params.id)
    return jobs!.update(job.id, asOwner(), job.target, koa.request.body ?? {})
  })
  jobRoute('delete', '/api/jobs/:id', (koa) => {
    const job = jobs!.get(koa.params.id)
    jobs!.remove(job.id, asOwner(), job.target)
  })
  jobRoute('post', '/api/jobs/:id/run', (koa) => {
    const job = jobs!.runNow(koa.params.id, String(koa.request.body?.key ?? ''))
    return { ok: true, name: job.name }
  })

  // 工具页：Agent 视角——工具定义原样取自最近一次发给模型的请求，再配上返回值说明和最近几次真实调用
  router.get('/api/tools', (koa) => {
    const sent = lastSentTools()
    const recent = new Map<string, { time: number, chat: string, args: string, result?: string, error?: string }[]>()
    const counts = new Map<string, number>()
    for (const row of store.recentToolCalls(3000)) {
      let meta: any
      try { meta = JSON.parse(row.meta ?? '{}') } catch { continue }
      if (!meta.tool) continue
      counts.set(meta.tool, (counts.get(meta.tool) ?? 0) + 1)
      const list = recent.get(meta.tool) ?? []
      if (list.length < 3) recent.set(meta.tool, [...list, { time: row.time, chat: row.group_id, args: meta.args ?? '', result: meta.result, error: meta.error }])
    }
    const label = (chat: string) => chat.startsWith('user:') ? `私聊 · ${store.profile(chat.slice(5))?.name || chat.slice(5, 13)}` : `群 ${chat.slice(0, 8)}…`
    koa.body = {
      capturedAt: sent?.time ?? null,
      model: sent?.model ?? null,
      totalChars: sent ? JSON.stringify(sent.tools).length : 0,
      ownerOnly: config.features.ownerOnlyTools,
      resultChars: config.memory.shortTerm.toolResultChars,
      tools: listTools().map(t => {
        const wire = sent?.tools.find((w: any) => w.name === t.name)
        return {
          ...t,
          wire: wire ?? null,
          calls: counts.get(t.name) ?? 0,
          recent: (recent.get(t.name) ?? []).map(c => ({ ...c, chatLabel: label(c.chat) })),
        }
      }),
      // 请求里有、清单里没有的（理论上不会有：内置工具都屏蔽了）
      extra: (sent?.tools ?? []).filter((w: any) => !listTools().some(t => t.name === w.name)),
    }
  })

  // ---- 配置：config.yaml 是唯一来源；看板读写它，手改文件看板也会同步 ----
  router.get('/api/config', (koa) => {
    // 参考人格（ref-*）不放进可选列表，避免误用
    const personaFiles = readdirSync(PERSONA_DIR).filter(f => f.endsWith('.yaml') && !f.startsWith('ref-')).map(f => f.slice(0, -5))
    koa.body = {
      // 人格文件在看板上用下拉框选（选项来自 persona 目录）
      fields: configStore.describe().map(f => f.path === 'agent.persona' ? { ...f, type: 'select', options: personaFiles } : f),
      pending: configStore.pending(),
      runtime: (agent as any).runtime,
      underPm2: process.env.pm_id !== undefined,
    }
  })
  router.put('/api/config', (koa) => {
    const { path, value } = (koa.request as any).body
    try {
      koa.body = { ...configStore.set(path, value), pending: configStore.pending() }
    } catch (e) {
      badRequest(koa, (e as Error).message)
    }
  })
  router.post('/api/restart/dsh', async (koa) => {
    koa.body = { runtime: await agent.restart(), pending: configStore.pending() }
  })
  /** 重启整个网关：进程退出后由 pm2 拉起（不在 pm2 下运行时只会退出，需要手动启动） */
  router.post('/api/restart/gateway', (koa) => {
    koa.body = { ok: true, underPm2: process.env.pm_id !== undefined }
    ctx.logger('dashboard').info('看板请求重启网关')
    setTimeout(() => process.exit(0), 500)
  })

  // ---- 活动（图表数据）----
  router.get('/api/activity', (koa) => {
    const hours = Math.min(Number(koa.query.hours) || 24, 24 * 90)
    koa.body = store.activitySince(Date.now() - hours * 3600_000)
  })
  /** SSE：有新活动时立刻推给看板，看板据此实时刷新图表 */
  router.get('/api/activity/stream', (koa) => {
    const stream = new PassThrough()
    koa.request.socket.setTimeout(0)
    koa.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    koa.body = stream
    stream.write(': connected\n\n')
    const off = activity.subscribe(a => stream.write(`data: ${JSON.stringify(a)}\n\n`))
    const ping = setInterval(() => stream.write(': ping\n\n'), 25_000)
    koa.req.on('close', () => {
      off()
      clearInterval(ping)
      stream.end()
    })
  })

  // ---- 每日额度（credits）：每个人 / 每个群 / 全局的已花、上限、余额；只能充值和改上限，已花的账不能动 ----
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
  router.get('/api/quota', (koa) => {
    const today = beijingDay()
    // day 可以是具体日期，也可以是历史范围：all = 全部、7d / 30d = 最近几天（含今天）
    const raw = String(koa.query.day ?? '')
    const RANGES: Record<string, [string, number]> = { '7d': ['最近 7 天', 6], '30d': ['最近 30 天', 29] }
    const isRange = raw === 'all' || raw in RANGES
    const day = DAY_RE.test(raw) ? raw : today
    const from = raw === 'all' ? (store.creditFirstDay() ?? today) : raw in RANGES ? beijingDay(Date.now() - RANGES[raw][1] * 86400_000) : day
    const to = isRange ? today : day
    const sums = store.creditsByRange(from, to)
    const q = config.quota
    // 这段时间花过的人 + 单独设置过上限或有余额的人
    const userIds = new Set([...sums.users.map(u => u.id), ...store.creditAccounts().map(a => a.user_id)])
    koa.body = {
      day: isRange ? raw : day, today, days: [...new Set([today, ...store.creditDays()])],
      range: { isRange, from, to, label: raw === 'all' ? '全部历史' : RANGES[raw]?.[0] ?? day, activeDays: sums.global.days },
      rate: { creditsPerYuan: q.creditsPerYuan },
      prices: { tokens: TOKEN_PRICES, search: SEARCH_PRICE, fetch: FETCH_PRICE, webBilledFrom: WEB_BILLED_FROM, ttsPerChar: TTS_PRICE_PER_CHAR, images: IMAGE_PRICES },
      itemLabels: { chat: '对话模型', ...ITEM_LABEL },
      global: { ...sums.global, limit: q.global },
      byItem: sums.byItem,
      // counted：计入群限额的部分（不算管理员的花费）
      groups: sums.groups.map(g => ({ ...g, limit: q.group, counted: isRange ? null : quota.groupSpent(g.id, day) })),
      users: [...userIds].map((id) => {
        const p = store.profile(id)
        const spent = sums.users.find(u => u.id === id) ?? { credits: 0, yuan: 0, turns: 0 }
        const status = quota.userStatus(id, isRange ? today : day)
        return {
          id, name: p?.name || '', callName: p?.call_name || '', owner: id === config.owner?.id,
          ...spent, limit: status.limit, custom: status.custom, balance: status.balance, admin: status.admin,
          remaining: !isRange && day === today ? (status.admin ? null : status.remaining) : null,
        }
      }),
    }
  })

  // 某人的账本明细 + 充值 / 改上限记录
  router.get('/api/quota/ledger', (koa) => {
    const id = String(koa.query.user ?? '')
    koa.body = { ledger: store.creditLedgerOf(id, 100), adjustments: store.creditAdjustmentsOf(id) }
  })

  router.post('/api/quota/topup', (koa) => {
    const { userId, credits, note } = (koa.request as any).body ?? {}
    const n = Number(credits)
    if (!userId || !Number.isFinite(n) || n <= 0 || n > 1e9) return badRequest(koa, '充值数额要是正数')
    store.topUp(String(userId), n, String(note ?? '').slice(0, 100))
    ctx.logger('dashboard').info('看板充值：%s +%d credits', userId, n)
    koa.body = { ok: true }
  })

  router.post('/api/quota/limit', (koa) => {
    const { userId, limit } = (koa.request as any).body ?? {}
    const n = limit === null || limit === '' ? null : Number(limit)
    if (!userId || (n !== null && (!Number.isFinite(n) || n < 0 || n > 1e9))) return badRequest(koa, '上限要是 0 以上的数，留空 = 恢复默认')
    store.setDailyLimit(String(userId), n)
    ctx.logger('dashboard').info('看板改每日上限：%s → %s', userId, n ?? '默认')
    koa.body = { ok: true }
  })

  // 看板预览 assets 下的图片（关键词表情配置用）
  router.get('/api/asset', (koa) => {
    const file = profilePath(String(koa.query.path ?? ''))
    if (!file.startsWith(profilePath('assets')) || !/\.(png|jpe?g|gif|webp)$/i.test(file) || !existsSync(file)) {
      koa.status = 404
      return
    }
    koa.type = file.split('.').pop()!.toLowerCase()
    koa.body = readFileSync(file)
  })

  // 可选的图片：表情索引里的 + 手动放的表情包，给关键词表情配置做候选
  router.get('/api/sticker-library', (koa) => {
    const list: { path: string, alt: string }[] = []
    const archive = config.stickers.archiveDir.replace(/\\/g, '/').replace(/\/$/, '')
    const index = profilePath(archive, 'index.json')
    if (existsSync(index)) {
      for (const s of JSON.parse(readFileSync(index, 'utf8')).stickers) {
        if (s.local) list.push({ path: `${archive}/${s.local}`, alt: s.alt })
      }
    }
    const dir = profilePath('assets/stickers')
    for (const tag of existsSync(dir) ? readdirSync(dir) : []) {
      if (!statSync(resolve(dir, tag)).isDirectory()) continue
      for (const f of readdirSync(resolve(dir, tag))) {
        if (/\.(png|jpe?g|gif|webp)$/i.test(f)) list.push({ path: `assets/stickers/${tag}/${f}`, alt: `${tag}：${f.replace(/\.[^.]+$/, '')}` })
      }
    }
    koa.body = list
  })

  router.get('/api/cost', (koa) => {
    koa.body = tokenStats(Number(koa.query.hours) || 24)
  })


  // ---- 记忆（mem0）----
  /** 所有已知作用域：聊过的人 + 聊过的群 + 旧表里出现过的作用域 */
  const knownScopes = () => {
    const scopes = new Set<string>()
    for (const p of store.listProfiles()) scopes.add(`user:${p.user_id}`)
    for (const s of store.listSessions()) if (s.key.startsWith('qq:group:')) scopes.add(`group:${s.key.slice(9)}`)
    for (const m of store.listMemories()) scopes.add(m.scope)
    return [...scopes]
  }
  const ownerLabel = (scope: string) => {
    if (!scope.startsWith('user:')) return scope
    const p = store.profile(scope.slice(5))
    return p ? (p.call_name ? `${p.name}（${p.call_name}）` : p.name ?? scope) : scope
  }

  const nameOf = (id: string) => store.profile(id)?.name || id.slice(0, 8)
  const chatLabel = (chat: string) => chat.startsWith('user:') ? `私聊 · ${store.profile(chat.slice(5))?.name || chat.slice(5, 13)}` : `群 ${chat.slice(0, 8)}…`
  /** 画像引用：记忆短 id → 被谁的画像哪一节引用 */
  const citations = () => {
    const out = new Map<string, { userId: string, name: string, section: string, label: string }[]>()
    for (const p of store.listPortraits()) {
      for (const s of SECTIONS) {
        for (const id of p.data.sections[s.key]?.sources ?? []) {
          out.set(id, [...(out.get(id) ?? []), { userId: p.user_id, name: nameOf(p.user_id), section: s.key, label: s.label }])
        }
      }
    }
    return out
  }
  const rowInfo = (r: GroupMessage) => ({ id: r.id, episode: r.episode, time: r.time, kind: r.kind, userId: r.user_id, name: r.name, text: r.text, meta: r.meta ? JSON.parse(r.meta) : null })
  /** 段的概要：时间、几行、谁在聊、摘要、从这段记下的长期记忆、上一段 / 下一段 */
  const episodeInfo = (id: number) => {
    const e = store.episode(id)!
    const memories = store.allAnchors().filter(a => a.chat === e.chat && store.episodesOfAnchor(a).includes(id)).map(a => a.memory_id)
    return { ...e, chatLabel: chatLabel(e.chat), people: store.episodePeople(id), memories: [...new Set(memories)], ...store.episodeNeighbors(id) }
  }

  router.get('/api/memories', async (koa) => {
    const lists = await Promise.all(knownScopes().map(scope => memory.list(scope)))
    // 召回审计：每条被召回几次、最近一次、涉及几个会话
    const stats = new Map(store.recallStats().map(s => [s.memoryId, s]))
    // 归属人（群记忆挂到谁身上）和出处（最新的一段原文）
    const subjects = new Map<string, string[]>()
    for (const s of store.allSubjects()) subjects.set(s.memoryId, [...(subjects.get(s.memoryId) ?? []), s.userId])
    const anchors = new Map<string, MemoryAnchor>()
    for (const a of store.allAnchors()) anchors.set(a.memory_id, a)
    const cites = citations()
    koa.body = [...new Map(lists.flat().map(m => [m.id, m])).values()]
      .map(m => {
        const s = stats.get(m.id)
        const a = anchors.get(m.id)
        const first = a ? store.transcriptRange(a.chat, a.from_id, a.to_id)[0] : undefined
        return {
          ...m, owner: ownerLabel(m.scope), recalls: s?.count ?? 0, lastRecalled: s?.last ?? null, recallSessions: s?.sessions ?? 0,
          subjects: (m.scope.startsWith('user:') ? [m.scope.slice(5)] : subjects.get(m.id) ?? []).map(id => ({ id, name: nameOf(id) })),
          reporterName: m.reporter ? nameOf(m.reporter) : undefined,
          anchor: a ? { chat: a.chat, fromId: a.from_id, toId: a.to_id, guessed: Boolean(a.guessed), time: first?.time ?? null, episodes: store.episodesOfAnchor(a) } : null,
          private: memory.isPrivate(m),
          cited: cites.get(m.id.slice(0, 8)) ?? [],
        }
      })
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  })
  /** 审计面板里的一条记忆：全部信息 + 出处所在的段（★ 标出处行）+ 召回记录 */
  router.get('/api/memories/:id/detail', async (koa) => {
    const m = await memory.get(koa.params.id).catch((): undefined => undefined)
    if (!m) return badRequest(koa, '这条记忆不存在（可能已经删了）')
    const s = store.recallStats().find(x => x.memoryId === m.id)
    const tagged = store.allSubjects().filter(x => x.memoryId === m.id).map(x => x.userId)
    const anchors = store.anchorsOf(m.id).map(a => ({
      chat: a.chat, chatLabel: chatLabel(a.chat), guessed: Boolean(a.guessed), focus: a.focus ? nameOf(a.focus) : null,
      episodes: store.episodesOfAnchor(a).slice(0, 2).map(id => ({
        ...episodeInfo(id),
        rows: store.episodeRows(id).map(r => ({ ...rowInfo(r), star: r.id >= a.from_id && r.id <= a.to_id && (!a.focus || r.user_id === a.focus) })),
      })),
    }))
    koa.body = {
      ...m, owner: ownerLabel(m.scope),
      subjects: (m.scope.startsWith('user:') ? [m.scope.slice(5)] : tagged).map(id => ({ id, name: nameOf(id) })),
      reporterName: m.reporter ? nameOf(m.reporter) : undefined,
      private: memory.isPrivate(m),
      cited: citations().get(m.id.slice(0, 8)) ?? [],
      recalls: s?.count ?? 0, lastRecalled: s?.last ?? null, recallSessions: s?.sessions ?? 0,
      anchors,
      recallLog: store.recallsOf(m.id, 30).map(r => ({
        time: r.time, via: r.via, score: r.score, query: r.query, session: r.session_key ? chatLabel(r.session_key.replace(/^qq:group:/, '').replace(/^qq:user:/, 'user:')) : '',
        who: r.user_id ? nameOf(r.user_id) : '',
      })),
    }
  })
  // 批量删除（审计时清理从没被召回的、过时的）
  router.post('/api/memories/bulk-delete', async (koa) => {
    const ids: string[] = (koa.request as any).body.ids ?? []
    for (const id of ids) await memory.delete(String(id))
    koa.body = { deleted: ids.length }
  })
  // 某条记忆的召回明细
  router.get('/api/memories/:id/recalls', (koa) => {
    koa.body = store.recallsOf(koa.params.id).map(r => ({
      time: r.time, via: r.via, score: r.score, query: r.query, session: r.session_key,
      who: r.user_id ? store.profile(r.user_id)?.name || r.user_id.slice(0, 8) : '',
    }))
  })
  router.post('/api/memories', async (koa) => {
    const { scope, content } = (koa.request as any).body
    if (!/^(user|group):\S+$/.test(scope) || !content?.trim()) return badRequest(koa, 'scope 或内容不合法')
    koa.body = await memory.remember(scope, content.trim())
  })
  router.put('/api/memories/:id', async (koa) => {
    const content = (koa.request as any).body.content?.trim()
    if (!content) return badRequest(koa, '内容不能为空')
    await memory.update(koa.params.id, content)
    koa.body = { ok: true }
  })
  router.delete('/api/memories/:id', async (koa) => {
    await memory.delete(koa.params.id)
    koa.body = { ok: true }
  })
  // 改群记忆的归属人：按昵称（精确）或 openid 找人，找不到 / 重名就报错
  router.put('/api/memories/:id/subjects', (koa) => {
    const names: string[] = (koa.request as any).body.names ?? []
    const profiles = store.listProfiles()
    const ids: string[] = []
    for (const raw of names.map(n => String(n).trim()).filter(Boolean)) {
      const hit = profiles.filter(p => p.user_id === raw || p.name === raw)
      if (hit.length !== 1) return badRequest(koa, hit.length ? `「${raw}」有 ${hit.length} 个人重名，填 openid` : `没有叫「${raw}」的人`)
      ids.push(hit[0].user_id)
    }
    store.setSubjects(koa.params.id, ids)
    koa.body = { ok: true }
  })

  // ---- 短期记忆（原文） ----
  router.get('/api/transcript/chats', (koa) => {
    koa.body = store.transcriptChats().map(c => ({ ...c, label: chatLabel(c.chat), episodes: store.episodeCount(c.chat) }))
  })
  /** 某会话的段，新到旧分页；before = 只要在这之前开始的（加载更早的 / 跳到某天） */
  router.get('/api/episodes', (koa) => {
    const chat = String(koa.query.chat ?? '')
    const before = Number(koa.query.before) || undefined
    const list = store.episodesBefore(chat, before, Math.min(Number(koa.query.limit) || 20, 100))
    koa.body = list.map(e => episodeInfo(e.id))
  })
  router.get('/api/episodes/:id', (koa) => {
    const id = Number(koa.params.id)
    if (!store.episode(id)) return badRequest(koa, '没有这一段（可能已经被清理）')
    koa.body = { ...episodeInfo(id), rows: store.episodeRows(id).map(rowInfo) }
  })
  /**
   * 某会话某天（北京时间）的原文：和这一天有重叠的完整的段（跨 0 点的不截断）；
   * 每段附上从这段记下的长期记忆，每行附上从这一行开始的记忆出处
   */
  router.get('/api/transcript', (koa) => {
    const chat = String(koa.query.chat ?? '')
    const days = store.transcriptDays(chat)
    const day = String(koa.query.day || days[0] || '')
    if (!chat || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return (koa.body = { days, day, episodes: [], rows: [] })
    const since = Date.parse(`${day}T00:00:00+08:00`)
    const episodes = store.episodesBetween(chat, since, since + 86400_000)
    const rows = episodes.flatMap(e => store.episodeRows(e.id))
    const ids = rows.map(r => r.id)
    const starts = new Map<number, string[]>()
    const byEpisode = new Map<number, Set<string>>()
    for (const a of store.allAnchors()) {
      if (a.chat !== chat) continue
      const at = ids.find(id => id >= a.from_id && id <= a.to_id)
      if (at !== undefined) starts.set(at, [...(starts.get(at) ?? []), a.memory_id])
      for (const ep of store.episodesOfAnchor(a)) byEpisode.set(ep, (byEpisode.get(ep) ?? new Set()).add(a.memory_id))
    }
    koa.body = {
      days, day,
      episodes: episodes.map(e => ({ ...e, people: store.episodePeople(e.id), memories: [...(byEpisode.get(e.id) ?? [])] })),
      rows: rows.map(r => ({ id: r.id, episode: r.episode, time: r.time, kind: r.kind, userId: r.user_id, name: r.name, text: r.text, turn: r.turn, meta: r.meta ? JSON.parse(r.meta) : null, anchors: starts.get(r.id) ?? [] })),
    }
  })

  // ---- 群友画像 ----
  router.get('/api/people', async (koa) => {
    const out = []
    for (const p of store.listProfiles()) {
      const own = await memory.list(`user:${p.user_id}`)
      const tagged = store.memoriesAbout(p.user_id).length
      const row = store.portrait(p.user_id)
      if (!own.length && !tagged && !row) continue
      const usable = await portraits.evidence(p.user_id)
      const fresh = row ? usable.filter(m => (Date.parse(m.updatedAt ?? m.createdAt ?? '') || 0) > row.watermark).length : usable.length
      out.push({
        id: p.user_id, name: p.name, own: own.length, tagged, usable: usable.length, privateCount: own.filter(m => memory.isPrivate(m)).length,
        version: row?.version ?? 0, updated: row?.updated ?? null, by: row?.by ?? null, summary: row?.data.summary ?? '', fresh,
      })
    }
    koa.body = { people: out.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0) || b.usable - a.usable), night: portraits.lastNight(), sections: SECTIONS }
  })
  router.get('/api/portraits/:id', async (koa) => {
    const id = koa.params.id
    const recalls = new Map(store.recallStats().map(s => [s.memoryId, s.count]))
    const own = await memory.list(`user:${id}`)
    const tagged = (await Promise.all(store.memoriesAbout(id).map(m => memory.get(m).catch((): undefined => undefined)))).filter(Boolean) as MemoryItem[]
    koa.body = {
      id, name: store.profile(id)?.name ?? id.slice(0, 8),
      portrait: store.portrait(id) ?? null,
      history: store.portraitHistory(id),
      sections: SECTIONS,
      evidence: [...own, ...tagged]
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map(m => ({ id: m.id, memory: m.memory, source: m.source, createdAt: m.createdAt, scope: m.scope, private: memory.isPrivate(m), recalls: recalls.get(m.id) ?? 0, reporterName: m.reporter ? store.profile(m.reporter)?.name || m.reporter.slice(0, 8) : undefined })),
    }
  })
  router.put('/api/portraits/:id', (koa) => {
    try {
      koa.body = { version: portraits.update(koa.params.id, (koa.request as any).body ?? {}) }
    } catch (e) {
      badRequest(koa, (e as Error).message)
    }
  })
  router.post('/api/portraits/:id/rollback', (koa) => {
    try {
      koa.body = { version: portraits.rollback(koa.params.id, Number((koa.request as any).body.version)) }
    } catch (e) {
      badRequest(koa, (e as Error).message)
    }
  })
  router.post('/api/portraits/:id/consolidate', async (koa) => {
    try {
      koa.body = { version: await portraits.consolidate(koa.params.id, 'manual') }
    } catch (e) {
      badRequest(koa, (e as Error).message)
    }
  })
  // 立即跑一次夜间整理：后台跑，看日志 / 刷新列表看结果
  router.post('/api/portraits-night', (koa) => {
    portraits.runNight().catch(e => ctx.logger('portrait').warn('手动整理失败：%s', (e as Error).message))
    koa.body = { started: true }
  })

  // 供 dsh 插件调用的记忆接口在 memory-routes.ts

  // ---- 称呼 / 外号 ----
  router.get('/api/profiles', (koa) => {
    koa.body = store.listProfiles()
  })
  router.put('/api/profiles/:id', (koa) => {
    const callName = (koa.request as any).body.callName?.trim()
    if (callName) store.setCallName(koa.params.id, callName)
    else store.clearCallName(koa.params.id)
    koa.body = { ok: true }
  })

  // ---- 人格 ----
  router.get('/api/personas', (koa) => {
    koa.body = {
      active: config.agent.persona,
      files: readdirSync(PERSONA_DIR).filter(f => f.endsWith('.yaml')).map((f) => {
        const content = readFileSync(resolve(PERSONA_DIR, f), 'utf8')
        let ref: unknown = null, text = ''
        try {
          const parsed = YAML.parse(content)
          ref = parsed?.ref ?? null
          text = [parsed?.common, parsed?.group, parsed?.private].filter(Boolean).join('\n')
        } catch {}
        // 带 ref 段的是收录的参考人格（只读预览），其余是自己的人格
        return { name: f.slice(0, -5), content, ref, text }
      }),
    }
  })
  router.put('/api/personas/:name', (koa) => {
    const { name } = koa.params
    if (!/^[\w-]+$/.test(name)) return badRequest(koa, '文件名只能用字母、数字、下划线和短横线')
    const content: string = (koa.request as any).body.content ?? ''
    try {
      const parsed = YAML.parse(content)
      if (typeof parsed?.common !== 'string') throw new Error('缺少 common 段')
    } catch (e) {
      return badRequest(koa, `YAML 格式错误：${(e as Error).message}`)
    }
    writeFileSync(resolve(PERSONA_DIR, `${name}.yaml`), content)
    koa.body = { ok: true }
  })

  ctx.on('ready', () => ctx.logger('dashboard').info('本地看板：http://127.0.0.1:%d/', config.dashboard.port))
}

/**
 * deepseek-flash 官方价（元 / 百万 token，2026-09 起）：高峰 / 低谷。
 * 只用于看板估算；v4-pro 约贵 4.5 倍，未单独列出。
 */
const FLASH_PRICE = { peak: { hit: 0.04, miss: 2, out: 8 }, offpeak: { hit: 0.02, miss: 1, out: 4 } }

/** 从 dsh 会话日志统计最近若干小时的 token：未命中缓存输入、缓存命中输入、输出，以及看图工具的消耗。 */
function tokenStats(hours: number) {
  const since = Date.now() - hours * 3600_000
  const t = { calls: 0, miss: 0, hit: 0, out: 0, vision: 0 }
  if (existsSync(SESSIONS_DIR)) {
    for (const ws of readdirSync(SESSIONS_DIR)) {
      for (const dir of readdirSync(resolve(SESSIONS_DIR, ws))) {
        for (const f of readdirSync(resolve(SESSIONS_DIR, ws, dir)).filter(f => f.endsWith('.jsonl'))) {
          const file = resolve(SESSIONS_DIR, ws, dir, f)
          if (statSync(file).mtimeMs < since) continue
          for (const line of readFileSync(file, 'utf8').split('\n')) {
            if (!line.includes('"assistant/message"') && !line.includes('"tokens"')) continue
            let e: any
            try { e = JSON.parse(line) } catch { continue }
            if (e.time < since) continue
            if (e.type === 'assistant/message' && e.data?.usage) {
              const u = e.data.usage
              t.calls++
              t.miss += u.inputTokens ?? 0
              t.hit += (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
              t.out += u.outputTokens ?? 0
            } else if (e.type === 'tool/result' && e.data?.meta?.charge?.item === 'vision') {
              const c = e.data.meta.charge
              t.vision += c.miss + c.hit + c.out
            }
          }
        }
      }
    }
  }
  const cost = (p: typeof FLASH_PRICE.peak) => ((t.miss + t.vision) * p.miss + t.hit * p.hit + t.out * p.out) / 1e6
  const peak = cost(FLASH_PRICE.peak), offpeak = cost(FLASH_PRICE.offpeak)
  const perMonth = 30 * 24 / hours
  return {
    hours, ...t,
    cacheHitRate: t.hit + t.miss ? t.hit / (t.hit + t.miss) : 0,
    costYuan: { offpeak, peak },
    monthlyYuan: { offpeak: offpeak * perMonth, peak: peak * perMonth },
  }
}

const REQUESTS_DIR = resolve(ROOT, 'data/requests')

/** 最近一次发给模型的请求里的工具定义（按文件修改时间缓存，请求文件可能有十几 MB） */
let sentToolsCache: { file: string, mtime: number, value: { time: number, model: string, tools: any[] } | null } = { file: '', mtime: 0, value: null }
function lastSentTools() {
  if (!existsSync(REQUESTS_DIR)) return null
  let newest = { file: '', mtime: 0 }
  for (const f of readdirSync(REQUESTS_DIR)) {
    const mtime = statSync(resolve(REQUESTS_DIR, f)).mtimeMs
    if (mtime > newest.mtime) newest = { file: f, mtime }
  }
  if (!newest.file) return null
  if (sentToolsCache.file !== newest.file || sentToolsCache.mtime !== newest.mtime) {
    let value = null
    try {
      const lines = readFileSync(resolve(REQUESTS_DIR, newest.file), 'utf8').trimEnd().split('\n')
      for (let i = lines.length - 1; i >= 0 && !value; i--) {
        const r = JSON.parse(lines[i])
        if (r.body?.tools?.length) value = { time: r.time, model: r.body.model, tools: r.body.tools }
      }
    } catch {}
    sentToolsCache = { ...newest, value }
  }
  return sentToolsCache.value
}

/** 网关写在每轮用户消息开头的场景头，用来区分"真正的一轮输入"和工具结果等其他 user 消息 */
const isTurnInput = (m: any) => m.role === 'user' && Array.isArray(m.content)
  && m.content.some((c: any) => c.type === 'text' && /^\[(群聊|私聊)\]/.test(c.text ?? ''))

function hashText(s: string) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/**
 * 读取插件抓取的请求体，整理成：
 * - dict：系统提示词、工具定义按内容去重（多次请求通常完全相同，只传一份）
 * - calls：每次调用的历史条数、本轮新增内容（tail）、token 用量、模型输出
 * - history：最近一次调用的完整历史（展开"历史消息"时看）
 */
function inspectSession(sessionId: string) {
  const file = resolve(REQUESTS_DIR, `${encodeURIComponent(sessionId)}.jsonl`)
  if (!existsSync(file)) return { calls: [] as unknown[], dict: {}, history: [] as unknown[], historyOffset: 0 }
  const requests = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))

  // 会话日志里按时间顺序的模型输出，用于给每次请求配上用量和回复
  const outputs: { time: number, usage?: any, text: string, reasoning?: string, failed?: boolean }[] = []
  const log = findSessionFile(sessionId)
  if (log) {
    for (const line of readFileSync(log, 'utf8').split('\n')) {
      if (!line.includes('"assistant/message"') && !line.includes('"assistant/attempt"')) continue
      let e: any
      try { e = JSON.parse(line) } catch { continue }
      if (e.type === 'assistant/message') {
        const content = e.data?.message?.content ?? []
        outputs.push({
          time: e.time,
          usage: e.data.usage,
          text: content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(''),
          reasoning: content.filter((c: any) => c.type === 'reasoning').map((c: any) => c.text ?? '').join('\n').trim(),
        })
      } else outputs.push({ time: e.time, text: '', failed: true })
    }
  }

  const dict: Record<string, unknown> = {}
  const calls = requests.map((r, i) => {
    const body = r.body
    const system = typeof body.system === 'string' ? body.system : JSON.stringify(body.system ?? '')
    const tools = (body.tools ?? []).map((t: any) => ({ name: t.name, description: t.description, params: t.input_schema?.properties ?? {}, required: t.input_schema?.required ?? [] }))
    const systemId = hashText(system), toolsId = hashText(JSON.stringify(tools))
    dict[systemId] ??= system
    dict[toolsId] ??= tools
    const messages: any[] = body.messages ?? []
    let start = -1
    for (let k = messages.length - 1; k >= 0; k--) if (isTurnInput(messages[k])) { start = k; break }
    if (start < 0) start = Math.max(0, messages.length - 1)
    const next = requests[i + 1]?.time ?? Infinity
    const out = outputs.find(o => o.time >= r.time && o.time < next)
    return {
      time: r.time,
      purpose: r.purpose,
      model: body.model,
      thinking: body.thinking,
      maxTokens: body.max_tokens,
      systemId,
      toolsId,
      systemChars: system.length,
      toolsChars: JSON.stringify(body.tools ?? []).length,
      historyCount: start,
      historyChars: JSON.stringify(messages.slice(0, start)).length,
      tail: messages.slice(start),
      tailChars: JSON.stringify(messages.slice(start)).length,
      usage: out?.usage ?? null,
      output: out?.text ?? '',
      reasoning: out?.reasoning ?? '',
      failed: out?.failed ?? false,
    }
  })
  const last = requests.at(-1)?.body.messages ?? []
  const lastStart = calls.at(-1)?.historyCount ?? 0
  return { calls, dict, history: last.slice(Math.max(0, lastStart - 60), lastStart), historyOffset: Math.max(0, lastStart - 60) }
}

function badRequest(koa: any, message: string) {
  koa.status = 400
  koa.body = { error: message }
}

/** 隐去密钥，其余配置原样展示。 */
function redact(config: Config) {
  const copy = structuredClone(config)
  copy.qq.secret = copy.qq.secret ? '******' : ''
  return copy
}

/** dsh 会话目录名会把 ":" 等字符编码成 "~003A"，这里反向解码找到对应会话。 */
function findSessionFile(sessionId: string) {
  if (!existsSync(SESSIONS_DIR)) return
  const decode = (s: string) => s.replace(/~([0-9A-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  for (const workspace of readdirSync(SESSIONS_DIR)) {
    for (const dir of readdirSync(resolve(SESSIONS_DIR, workspace))) {
      if (decode(dir) !== sessionId) continue
      const file = readdirSync(resolve(SESSIONS_DIR, workspace, dir)).find(f => /^session\.v\d+\.jsonl$/.test(f))
      if (file) return resolve(SESSIONS_DIR, workspace, dir, file)
    }
  }
}

/** 某个会话键在磁盘上的所有段（key、key~1、key~2…），新的在前 */
function listGenerations(key: string) {
  if (!existsSync(SESSIONS_DIR)) return []
  const decode = (s: string) => s.replace(/~([0-9A-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  const out: { id: string, gen: number, start: number, end: number, turns: number }[] = []
  for (const workspace of readdirSync(SESSIONS_DIR)) {
    for (const dir of readdirSync(resolve(SESSIONS_DIR, workspace))) {
      const id = decode(dir)
      const m = id === key ? ['', '0'] : id.startsWith(`${key}~`) ? id.slice(key.length).match(/^~(\d+)$/) : null
      if (!m) continue
      const name = readdirSync(resolve(SESSIONS_DIR, workspace, dir)).find(f => /^session\.v\d+\.jsonl$/.test(f))
      if (!name) continue
      const text = readFileSync(resolve(SESSIONS_DIR, workspace, dir, name), 'utf8')
      const times = [...text.matchAll(/"time":(\d{13})/g)]
      out.push({
        id, gen: Number(m[1]),
        start: Number(times[0]?.[1] ?? 0), end: Number(times.at(-1)?.[1] ?? 0),
        turns: (text.match(/"type":"turn\/start"/g) ?? []).length,
      })
    }
  }
  return out.sort((a, b) => b.gen - a.gen)
}

/** 从 dsh 会话日志里取最近的对话（用户消息、她的回复、工具调用）。 */
function readSessionMessages(sessionId: string, limit: number) {
  const file = findSessionFile(sessionId)
  if (!file) return []
  const text = (content: unknown) => Array.isArray(content)
    ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
    : String(content ?? '')
  const out: { role: string, text: string, time: number }[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    let event: any
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    // 用户消息的内容在 data.content；source.kind 不是 user 的是 dsh 自己插入的运行时上下文，跳过
    if (event.type === 'user/message') {
      if (event.data?.source?.kind === 'user') out.push({ role: 'user', text: text(event.data.content), time: event.time })
    }
    else if (event.type === 'assistant/message') {
      const t = text(event.data?.message?.content)
      if (t) out.push({ role: 'assistant', text: t, time: event.time })
    } else if (event.type === 'tool/call') {
      out.push({ role: 'tool', text: `${event.data.name}(${event.data.arguments})`, time: event.time })
    }
  }
  return out.slice(-limit)
}

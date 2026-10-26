// 必须最先加载：让所有子进程默认不弹控制台窗口（Windows）
import './hide-windows.js'
import { resolve } from 'node:path'
import { Context, Logger } from 'koishi'
import * as qqModule from '@koishijs/plugin-adapter-qq'
import * as sqliteModule from '@koishijs/plugin-database-sqlite'
import * as serverModule from '@koishijs/plugin-server'
import * as httpModule from '@koishijs/plugin-http'
import * as silkModule from 'koishi-plugin-silk'
import { cpSync, existsSync, writeFileSync } from 'node:fs'
import { ConfigStore, ROOT } from './config.js'
import { bridge } from './bridge/index.js'
import { DshClient } from './bridge/dsh-client.js'
import { ipWatch } from './ip-watch.js'
import { acquireInstanceLock } from './instance-lock.js'
import { connectionGuard, patchQQHeartbeat } from './connection-guard.js'
import { dashboard } from './dashboard.js'
import { MemoryService } from './memory.js'
import { memoryDigest } from './memory-digest.js'
import { StickerLibrary } from './stickers/library.js'
import { stickerRoutes } from './stickers/routes.js'
import { videoRoutes } from './video/index.js'
import { CoverService, coverRoutes } from './cover/index.js'
import { ConfigAdmin } from './admin/config-tool.js'
import { adminRoutes } from './admin/routes.js'
import { ShortTermMemory, episodeSummarizer } from './short-term.js'
import { memoryRoutes } from './memory-routes.js'
import { PortraitService } from './portrait.js'
import { ActivityLog } from './activity.js'
import { openStore } from '../../shared/store.mjs'

// 这几个包是 CommonJS，从 ESM 导入时插件本体挂在 default 上
const interop = (m: any) => m.default?.default ?? m.default ?? m
const qq = interop(qqModule)
patchQQHeartbeat(qqModule)
const sqlite = interop(sqliteModule)
const server = interop(serverModule)
const silk = interop(silkModule)
const http = interop(httpModule)

// 日志带时间；SHARK_DEBUG=1 时打印 QQ 原始事件，排查收不到消息时用
for (const target of Logger.targets) target.showTime = 'MM-dd hh:mm:ss'
if (process.env.SHARK_DEBUG) Object.assign(Logger.levels, { qq: 3, bridge: 3 })

const configStore = new ConfigStore()
const config = configStore.config
acquireInstanceLock(resolve(ROOT, 'data/gateway.lock'))
const app = new Context({ prefix: ['/'] })

app.plugin(http, {})
app.plugin(sqlite, { path: resolve(ROOT, 'data/gateway.db') })
app.plugin(silk)
// 本地看板和 webhook 共用一个只监听本机的 HTTP 服务
app.plugin(server, { host: '127.0.0.1', port: config.dashboard.port })

// GROUP_AND_C2C_EVENT（1<<25）：群 @、单聊、加好友/入群事件；全量群消息同样走这个 intent，权限由平台控制
const GROUP_AND_C2C_EVENT = 1 << 25
app.plugin(qq, {
  id: config.qq.id,
  secret: config.qq.secret,
  type: config.qq.type,
  sandbox: config.qq.sandbox,
  protocol: config.qq.protocol,
  path: config.qq.webhookPath,
  intents: GROUP_AND_C2C_EVENT,
  retryWhen: [],
})

// 记忆分层第一次上线前备份一次数据库和 mem0（之后的结构升级只加列、加表）
const BACKUP_DIR = resolve(ROOT, 'data/backup/before-memory-layers')
if (!existsSync(BACKUP_DIR) && existsSync(resolve(ROOT, 'data/store.db'))) {
  for (const name of ['store.db', 'store.db-wal', 'store.db-shm', 'mem0']) {
    const from = resolve(ROOT, 'data', name)
    if (existsSync(from)) cpSync(from, resolve(BACKUP_DIR, name), { recursive: true })
  }
}
const store = openStore(resolve(ROOT, 'data/store.db'))
// 原文分段：新写入的行增量切；还没分段的老原文按同样的规则补切（长期记忆的出处由此自动映射到段）
store.setEpisodePolicy(config.memory.shortTerm)
const unsegmented = store.assignMissingEpisodes()
if (unsegmented) new Logger('episodes').info('老原文补切分段：%d 行', unsegmented)
// dsh 插件在另一个进程里，功能开关通过这个文件同步给它（网关是唯一写入方）
const FEATURES_FILE = resolve(ROOT, 'data/settings.json')
const syncFeatures = () => writeFileSync(FEATURES_FILE, JSON.stringify({ ...config.features, ownerId: config.owner?.id ?? '' }, null, 2))
syncFeatures()
configStore.onChange(syncFeatures)
app.inject(['database', 'server'], (ctx) => {
  const memory = new MemoryService(ctx, store, config.agent.model, config.memory)
  memory.backfillAnchors().catch(e => ctx.logger('memory').warn('老记忆推测出处失败：%s', (e as Error).message))
  const activity = new ActivityLog(ctx, store)
  const agent = new DshClient(ctx, config.agent, store, config.features, memory, activity, () => configStore.markApplied('dsh'), config.stickers, config.imageGen, config.cover)
  // 群友画像：每轮放进消息头，夜间由长期记忆融合
  const portraits = new PortraitService(ctx, config, store, memory, activity)
  agent.portraits = portraits
  const digest = memoryDigest(ctx, config, store, memory, activity)
  // config 工具：超级用户在聊天里改配置；要重启的等这一轮回复发出去再重启
  const admin = new ConfigAdmin(ctx, configStore, agent)
  const { quota, videos, jobs } = bridge(ctx, config, agent, store, { onMessage: digest.onMessage, onConfigChange: fn => configStore.onChange(fn), afterTurn: () => admin.afterTurn() })
  dashboard(ctx, configStore, store, agent, memory, activity, quota, portraits, videos, jobs)
  stickerRoutes(ctx, new StickerLibrary(ctx, store, config), store)
  videoRoutes(ctx, videos)
  coverRoutes(ctx, new CoverService(ctx, config))
  adminRoutes(ctx, agent, admin, jobs)
  memoryRoutes(ctx, config, store, agent, memory, new ShortTermMemory(store, config.memory), portraits)
  episodeSummarizer(ctx, config.memory, store, activity)
})
app.plugin((ctx: Context) => ipWatch(ctx, config.ipWatch), {})
app.plugin(connectionGuard, {})

app.start()

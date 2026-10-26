import { existsSync, readFileSync, watchFile, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import YAML from 'yaml'

export type ReasoningEffort = 'off' | 'low' | 'high' | 'max'

/** 自定义命令（看板「命令」页增删改，见 bridge/commands.ts） */
export interface CustomCommand {
  /** 命令名，不带斜杠，例如 写日记 */
  name: string
  aliases: string[]
  description: string
  permission: 'all' | 'admin'
  scene: 'any' | 'group' | 'private'
  /** task = 立即执行定时任务，prompt = 交给她回复，reply = 直接回复固定文字 */
  action: 'task' | 'prompt' | 'reply'
  /** action = task 时：定时任务的 id（greeting / diary 等，greeting 会匹配到 greeting-owner 这类），或 idle = 冷场寒暄 */
  task: string
  /** action = prompt 时交给她的提示，{args} = 命令后面的内容 */
  prompt: string
  /** action = reply 时直接回复的文字，{args} 同上 */
  reply: string
}

export interface Features {
  stickers: boolean
  stickerEvery: number
  lookImage: boolean
  webSearch: boolean
  /** 联网等高级工具只给主人用：工具层硬拦截，不只靠提示词 */
  /** 只给主人用的工具（工具名）：别人触发时插件直接拒绝 */
  ownerOnlyTools: string[]
  voice: boolean
}

export interface Config {
  qq: {
    id: string
    secret: string
    type: 'private' | 'public'
    sandbox: boolean
    protocol: 'websocket' | 'webhook'
    webhookPath: string
  }
  agent: {
    /** 模型调用失败时回的话 */
    errorReply: string
    /** 由 ConfigStore 填入：dsh 插件调用网关记忆接口用 */
    dashboardPort: number
    model: string
    maxTokens: number
    reasoningEffort: ReasoningEffort
    contextWindow: number
    persona: string
    timeoutSec: number
    /** 每轮放进消息头的相关记忆条数上限 */
    memoryLimit: number
    /** 回复按换行拆成几条消息发（像真人一样连发），最多拆几条；1 = 不拆 */
    splitReply: number
    /** 发送前强制替换的词（按顺序替换，长词放前面） */
    replaceWords?: Record<string, string>
    /** 每轮用户消息最末尾的人设提醒（首尾最受重视，在这里再强调一次）；留空不加 */
    tailReminder: string
    /** 火山引擎豆包语音：凭证在环境变量 VOLC_TTS_APP_ID / VOLC_TTS_ACCESS_TOKEN；资源 ID 按音色 ID 自动判断 */
    tts?: {
      speaker?: string
      defaultTone?: string
    }
  }
  features: Features
  /**
   * 群聊。平台只推送 @ 消息时只有 @ 会触发；开通「接收所有消息」后，叫名字、回复她的消息也会触发，
   * 其余消息进旁听窗口（observeWindow = 0 关闭旁听）。
   */
  group: {
    trigger: {
      onName: string[]
      interest: number
      cooldownSec: number
    }
    observeWindow: number
  }
  /**
   * 每日额度，单位 credits：每一笔真实花费（模型 token、看图、联网、语音）按官方人民币价格计算，再乘汇率。
   * user / group / global 是每天的上限（北京时间 0 点重置）；个人上限可在看板单独改，超出后从充值余额里扣。
   */
  quota: {
    /** 1 元 = 多少 credits */
    creditsPerYuan: number
    user: number
    group: number
    global: number
    /** 个人额度用完时的回复 */
    exceededReply: string
    /** 群 / 全局额度用完时的回复（不是这个人自己的额度，话要说清楚） */
    sharedExceededReply: string
  }
  /** 冷场寒暄：群里安静一段时间后她主动冒个泡 */
  idle: {
    enabled: boolean
    /** 安静多少分钟（不算她自己说的话）就出来寒暄；0 = 10 秒，调试用 */
    minutes: number
    /** 一直没人说话时最多连续寒暄几次（0 = 不限），之后等有人说话再重新开始 */
    maxInRow: number
    /** 只在这个时段里寒暄，"HH:MM-HH:MM"，跨午夜可以写成 22:00-02:00 */
    activeHours: string
    /** 群 openid；空 = 她待过的所有群 */
    groups: string[]
    /** 交给模型的提示：{minutes} {time} 会被替换 */
    prompt: string
  }
  /** 视频链接解析：send_video 工具把抖音、B 站等链接里的视频下载下来发出去（见 src/video） */
  video: {
    enabled: boolean
    /** 自动解析：群里出现视频链接时，就算没叫她也让她跑一轮去调 send_video（花 credits，记在群上） */
    auto: boolean
    /** 自动解析在哪些群生效（群 openid）；空 = 所有群。私聊、以及她自己调工具不受限制 */
    groups: string[]
    /** douyin / bilibili / other（other = otherSites 里的网站，走 yt-dlp） */
    platforms: string[]
    otherSites: string[]
    /** 超过就只发信息不发视频；0 = 不限 */
    maxDurationMin: number
    maxSizeMB: number
    /** 同一个群同一个视频多少分钟内只处理一次 */
    dedupeMin: number
  }
  /** 翻唱：sing_cover 工具在本机找歌、分离人声、用 RVC 换成角色音色再混音（见 src/cover、tools/cover） */
  cover: {
    enabled: boolean
    /** 角色包里的音色目录，自动找里面的 .pth / .index */
    modelDir: string
    /** 一段唱多少秒 */
    lengthSec: number
    /** 原唱是男声（音高中位数低于 220 Hz）时自动升 12 个半音 */
    autoTranspose: boolean
    /** 在自动变调之外再固定变多少个半音 */
    transpose: number
    indexRate: number
    protect: number
    /** 每个群 / 私聊每天最多几首；0 = 不限 */
    dailyLimit: number
    /** 原曲超过这么多分钟不唱 */
    maxSongMinutes: number
    /** 翻唱进程空闲多久退出、释放显存 */
    idleMinutes: number
  }
  /** 自定义命令 */
  commands: CustomCommand[]
  /** 关键词自动表情：她的回复里出现 keyword（| 分隔多个写法）就附上 image（相对项目目录），网关直接发、不经过模型 */
  keywordStickers: { keyword: string, image: string, cooldownMin?: number }[]
  /**
   * 文生图，分两档质量：低质量走智谱开放平台（ZHIPU_API_KEY），高质量走火山方舟 Seedream（ARK_API_KEY）。
   * 哪个服务商由模型名决定：doubao-seedream-* 是方舟，其余是智谱。两个 key 都没有就不注册工具。
   */
  imageGen: {
    lowModel: string
    highModel: string
    /** 她不指定质量时用哪档 */
    defaultQuality: 'low' | 'high'
    /** 图生图的默认参考图（她画自己时用）：http(s) 链接或角色包里的路径；链接第一次用时缓存到本地 */
    reference: string
  }
  /** 表情包库的策略（实时生效） */
  stickers: {
    /** 只发这些题材的表情（subjects 有交集才发）；空 = 不限 */
    allowSubjects: string[]
    /** 表情索引和手动目录里的表情没标题材时，默认算这些 */
    defaultSubjects: string[]
    /** 她收藏的表情要先在看板审核通过才会发 */
    requireReview: boolean
    /** 表情索引目录（相对角色包）：里面的 index.json 列出图片、说明和标签，格式见 profiles/README.md */
    archiveDir: string
  }
  /** 记忆召回与群记忆梳理（每轮注入条数仍在 agent.memoryLimit） */
  memory: MemorySettings
  /** 新人入群欢迎 + 群规 */
  welcome: {
    enabled: boolean
    /** 群规全文；/群规 命令和欢迎时发送，留空则不发 */
    rules: string
    /** 交给模型的欢迎提示（不是直接发出的话） */
    prompt: string
  }
  /** 机器人自己：name 用在看板标题、群消息记录、指令说明里 */
  bot: { name: string }
  dashboard: { port: number }
  admins: string[]
  /** 主人：只有这个 openid 发来的消息会被标记为主人，防止别人冒充 */
  owner?: { id: string, name: string }
  /** 超级用户 openid：能让她用 config 工具改配置（主人总是超级用户，不用写在这里） */
  superUsers: string[]
  /** 她用 schedule 工具帮人设的定时任务（提醒、定时说点什么） */
  jobs: {
    enabled: boolean
    /** 每个人最多同时有几个任务（超级用户不限） */
    maxPerUser: number
    /** 重复任务的最短间隔（分钟，超级用户不限） */
    minIntervalMin: number
  }
  ipWatch: {
    enabled: boolean
    intervalMin: number
    notifyUrl: string
  }
}

export interface MemorySettings {
  /** 相关度低于这个值的记忆不召回（0～1，0 = 不过滤） */
  minScore: number
  /** 群聊里同时检索群记忆 */
  recallGroup: boolean
  digest: {
    /** 每个群 / 私聊每攒够 everyMessages 条新消息，用 mem0 梳理一次（群员画像和偏好写进各自的记忆） */
    enabled: boolean
    everyMessages: number
    /** 这一批里至少说了几句的人才梳理（话太少提取不出东西） */
    minLines: number
    /** 每次最多梳理几个人（每人一次 mem0 调用） */
    maxPeople: number
  }
  /** 短期记忆（原文）：群友消息、她的回复、工具调用 */
  shortTerm: {
    /** 原文保留天数（以后被长期记忆引用的段落永久保留） */
    retentionDays: number
    /** 工具结果在原文里存多少字 */
    toolResultChars: number
    /** deep_recall 一次最多返回多少字原文（超出就给段目录 / 分页） */
    deepRecallChars: number
    /** 冷场超过这么久（分钟）就切新的一段 */
    episodeGapMin: number
    /** 一段超过这么多行后，遇到停顿就切（2 倍强制切） */
    episodeMaxRows: number
    /** 段落结束后补一句话摘要（花一点 token） */
    summaries: boolean
    summaryModel: string
  }
  /** 按人召回和群友画像 */
  portrait: {
    /** 关掉后每轮不放画像、夜间不整理（按人保底召回记忆仍然生效） */
    enabled: boolean
    /** 每轮给发言人和被提到的人各保底召回几条记忆 */
    personLimit: number
    /** 除发言人外最多再带几个被 @ / 被引用的人 */
    mentionLimit: number
    /** 同一个会话里画像全文隔多久重放一次（小时），其间只放一句话版本 */
    reinjectHours: number
  }
  /** 夜间整理：把每个群友的长期记忆融合成画像 */
  night: {
    enabled: boolean
    /** 北京时间 HH:MM */
    time: string
    maxPeople: number
    /** 至少有几条记忆才建画像 */
    minMemories: number
  }
}

import { profilePath } from './profile.js'
import { optionsOf } from './config-options.js'
export { ROOT, PROFILE, PROFILE_DIR, profilePath } from './profile.js'
export const CONFIG_PATH = profilePath('config.yaml')

/**
 * 生效方式：
 * - live：改完立即生效（各模块每次使用时读取）
 * - dsh：要重启 dsh 子进程（约 2 秒，QQ 不掉线）
 * - gateway：要重启整个网关（约 15 秒，QQ 会短暂断开）
 */
export type ApplyMode = 'live' | 'dsh' | 'gateway'

export interface FieldSchema {
  path: string
  group: string
  label: string
  help?: string
  /**
   * text = 多行文本，list = 自由填写的多个值，multi = 从选项里多选，rules = 关键词 → 图片 列表。
   * select / multi 的选项可以写死在 options，也可以用 optionsFrom 指定动态数据源（见 config-options.ts）
   */
  type: 'boolean' | 'number' | 'string' | 'text' | 'select' | 'list' | 'multi' | 'rules' | 'commands'
  options?: string[]
  optionsFrom?: string
  /** multi / select 允许填选项以外的值（比如还没出现过的题材、手动粘贴 openid） */
  allowCustom?: boolean
  /** 不在「配置」页显示（有自己专门的页面，比如命令） */
  hidden?: boolean
  min?: number
  max?: number
  step?: number
  apply: ApplyMode
}

export const FIELDS: FieldSchema[] = [
  // 模型（重启 dsh）
  { path: 'agent.model', group: '模型', label: '对话模型', type: 'select', options: ['deepseek-flash', 'deepseek-v4-pro'], apply: 'dsh', help: 'flash 便宜、能看图；v4-pro 更强、贵约 4.5 倍、只支持文字（看图固定用 flash）' },
  { path: 'agent.reasoningEffort', group: '模型', label: '推理强度', type: 'select', options: ['off', 'low', 'high', 'max'], apply: 'dsh', help: 'off 不思考最省；越高越慢、输出 token 越多' },
  { path: 'agent.maxTokens', group: '模型', label: '单次最大输出 token', type: 'number', min: 128, max: 8192, apply: 'dsh', help: '开思考时要调大（思考内容也算输出）' },
  { path: 'agent.contextWindow', group: '模型', label: '上下文窗口', type: 'number', min: 16000, max: 1000000, step: 1000, apply: 'dsh', help: '超过约 80% 自动压缩旧对话；越小越省，近期对话记得越少' },
  { path: 'agent.persona', group: '模型', label: '人格文件', type: 'string', apply: 'dsh', help: '角色包 persona/<名字>.yaml；切换文件要重启 dsh，重启时所有会话自动开新会话（清空聊天上下文，长期记忆还在），新人格才完整生效' },
  { path: 'agent.errorReply', group: '模型', label: '出错时回的话', type: 'string', apply: 'live' },
  { path: 'agent.splitReply', group: '模型', label: '回复最多拆成几条', type: 'number', min: 1, max: 4, apply: 'live', help: '她回复里每一行单独发一条，像真人一样连发；超过的行并进最后一条。1 = 不拆。QQ 每条消息最多被动回复 5 次，表情包、语音也要占，所以最多 4' },
  { path: 'agent.tailReminder', group: '模型', label: '末尾人设提醒', type: 'text', apply: 'live', help: '加在每轮消息最末尾，提醒她按人设说话；会留在历史里，改了不影响缓存，只对之后的对话生效。留空不加' },
  { path: 'agent.timeoutSec', group: '模型', label: '回复超时（秒）', type: 'number', min: 10, max: 600, apply: 'live' },
  { path: 'agent.memoryLimit', group: '记忆', label: '召回条数', type: 'number', min: 0, max: 30, apply: 'live', help: '每轮自动放进消息头的相关记忆上限，也是 recall 工具一次返回的上限；消息头这部分不命中缓存，越少越省' },
  { path: 'memory.minScore', group: '记忆', label: '召回相关度下限', type: 'number', min: 0, max: 1, step: 0.05, apply: 'live', help: '低于这个相关度的记忆不召回（0 = 不过滤）；看「记忆」页每条的召回分数再定' },
  { path: 'memory.recallGroup', group: '记忆', label: '群聊同时召回群记忆', type: 'boolean', apply: 'live', help: '关掉则只召回发言人自己的记忆' },
  { path: 'memory.digest.enabled', group: '记忆', label: '记忆梳理', type: 'boolean', apply: 'live', help: '每个群 / 私聊每攒够一批新消息，用 mem0 提取每个人的画像和偏好写进 TA 的记忆（会花 token）；间隔设 1 就是每轮都提取' },
  { path: 'memory.digest.everyMessages', group: '记忆', label: '梳理间隔（条消息）', type: 'number', min: 1, max: 500, apply: 'live', help: '不含她自己说的话' },
  { path: 'memory.digest.minLines', group: '记忆', label: '至少说几句才梳理', type: 'number', min: 1, max: 50, apply: 'live', help: '这一批里话太少的人跳过，省 token' },
  { path: 'memory.shortTerm.retentionDays', group: '记忆', label: '原文保留天数', type: 'number', min: 7, max: 3650, apply: 'live', help: '短期记忆：群友消息、她的回复和工具调用的原文保留多久；每天清理一次' },
  { path: 'memory.shortTerm.toolResultChars', group: '记忆', label: '工具结果存多少字', type: 'number', min: 0, max: 5000, apply: 'live', help: '原文里每次工具调用的结果截到这么长（0 = 只记调用不记结果）' },
  { path: 'memory.shortTerm.deepRecallChars', group: '记忆', label: '深度回忆一次最多多少字', type: 'number', min: 1000, max: 30000, apply: 'live', help: 'deep_recall 一次返回的原文上限（约 2 字 = 1 token）；放不下时给段目录让她挑一段看，或者分页' },
  { path: 'memory.shortTerm.episodeGapMin', group: '记忆', label: '原文分段：冷场多久切一段（分钟）', type: 'number', min: 5, max: 360, apply: 'live', help: '原文按"段"组织，不按天切：隔了这么久没人说话就算新的一段，跨 0 点的聊天还是一段' },
  { path: 'memory.shortTerm.episodeMaxRows', group: '记忆', label: '原文分段：一段多少行后找停顿切', type: 'number', min: 20, max: 500, apply: 'live', help: '超过后遇到 3 分钟以上的停顿就切，一直没停顿到 2 倍强制切；同一轮的消息、回复、工具调用永远不拆开' },
  { path: 'memory.shortTerm.summaries', group: '记忆', label: '原文分段摘要', type: 'boolean', apply: 'live', help: '每段聊完后用便宜的模型写一句话摘要，深度回忆时她先看段目录再挑一段打开' },
  { path: 'memory.shortTerm.summaryModel', group: '记忆', label: '摘要用的模型', type: 'string', apply: 'live', help: '默认 deepseek-flash，便宜就行' },
  { path: 'memory.portrait.enabled', group: '记忆', label: '群友画像', type: 'boolean', apply: 'live', help: '每轮把发言人（和被 @ 的人）的画像放进消息头，夜间整理画像；关掉后按人保底召回记忆仍然生效' },
  { path: 'memory.portrait.personLimit', group: '记忆', label: '每人保底召回几条', type: 'number', min: 0, max: 10, apply: 'live', help: '发言人和被 @ / 被引用的人，每人一定召回这么多条最相关的记忆，不受相关度下限影响' },
  { path: 'memory.portrait.mentionLimit', group: '记忆', label: '最多带几个被提到的人', type: 'number', min: 0, max: 5, apply: 'live', help: '除发言人外，这句话里 @ 到 / 被引用的人最多带几个；他们只带群聊来源的记忆和画像里不涉及私事的部分' },
  { path: 'memory.portrait.reinjectHours', group: '记忆', label: '画像全文重放间隔（小时）', type: 'number', min: 0, max: 72, apply: 'live', help: '同一个会话里画像全文放过一次后，这么久之内只放一句话版本（画像更新了会立刻重放）；0 = 每轮都放全文' },
  { path: 'memory.night.enabled', group: '记忆', label: '夜间整理画像', type: 'boolean', apply: 'live', help: '每天夜里把每个群友名下有新记忆的人，用群聊来源的记忆融合成画像（私聊内容不进画像；会花 token）' },
  { path: 'memory.night.time', group: '记忆', label: '整理时间', type: 'string', apply: 'live', help: '北京时间 HH:MM；错过了当天开机后补跑' },
  { path: 'memory.night.maxPeople', group: '记忆', label: '每晚最多整理几人', type: 'number', min: 1, max: 200, apply: 'live', help: '每人一次 DeepSeek 调用' },
  { path: 'memory.night.minMemories', group: '记忆', label: '几条记忆起建画像', type: 'number', min: 1, max: 50, apply: 'live', help: '记忆太少的人先不建画像' },
  { path: 'memory.digest.maxPeople', group: '记忆', label: '每次最多梳理几人', type: 'number', min: 1, max: 50, apply: 'live', help: '每人一次 mem0 调用（约 2 次 DeepSeek 请求）' },
  // 功能（实时）
  { path: 'features.stickers', group: '功能', label: '表情包', type: 'boolean', apply: 'live' },
  { path: 'features.stickerEvery', group: '功能', label: '主动表情包间隔', type: 'number', min: 0, max: 200, apply: 'live', help: '每个会话每回复 N 次顺手发一个；0 = 不主动发' },
  { path: 'stickers.allowSubjects', group: '功能', label: '只发这些题材的表情', type: 'multi', optionsFrom: 'subjects', allowCustom: true, apply: 'live', help: '表情的 subjects（画的是谁）有交集才会发，例如 deepseek；留空 = 不限。不在范围内的表情仍留在库里' },
  { path: 'stickers.defaultSubjects', group: '功能', label: '表情索引 / 手动表情的默认题材', type: 'multi', optionsFrom: 'subjects', allowCustom: true, apply: 'live', help: '这两个来源的表情没单独标题材时按这个算' },
  { path: 'stickers.requireReview', group: '功能', label: '收藏的表情要审核', type: 'boolean', apply: 'live', help: '她在聊天里收藏的表情，要在看板「表情包」页通过后才会发出去' },
  { path: 'imageGen.lowModel', group: '功能', label: '文生图·低质量模型', type: 'select', options: ['cogview-3-flash', 'cogview-4', 'glm-image'], allowCustom: true, apply: 'dsh', help: '默认用这档。智谱开放平台：cogview-3-flash 免费；cogview-4 0.06 元 / 张；glm-image 0.1 元 / 张。key 写在 .env 的 ZHIPU_API_KEY' },
  { path: 'imageGen.defaultQuality', group: '功能', label: '文生图·默认质量', type: 'select', options: ['high', 'low'], apply: 'dsh', help: 'low = 智谱（默认），high = Seedream；她也可以按对方要求自己选' },
  { path: 'imageGen.reference', group: '功能', label: '图生图·默认参考图', type: 'string', apply: 'dsh', help: '她画自己时参考的图（立绘、三视图）：http(s) 链接或角色包里的路径（如 assets/character/xxx.png）；链接第一次用时会缓存到本地' },
  { path: 'imageGen.highModel', group: '功能', label: '文生图·高质量模型', type: 'select', options: ['doubao-seedream-5-0-flash-260915', 'doubao-seedream-5-0-pro-260628'], allowCustom: true, apply: 'dsh', help: '对方要精细的图时用。火山方舟 Seedream：5.0 flash 0.12 元 / 张，5.0 pro 0.3 元 / 张。key 写在 .env 的 ARK_API_KEY' },
  { path: 'commands', group: '命令', label: '自定义命令', type: 'commands', apply: 'live', hidden: true },
  { path: 'keywordStickers', group: '功能', label: '关键词自动表情', type: 'rules', apply: 'live', help: '她的回复里出现关键词（| 分隔多种写法）就自动附上这张图；网关直接发，不花 token' },
  { path: 'features.lookImage', group: '功能', label: '看图', type: 'boolean', apply: 'live' },
  { path: 'features.webSearch', group: '功能', label: '联网搜索 / 读网页', type: 'boolean', apply: 'live' },
  { path: 'features.ownerOnlyTools', group: '功能', label: '仅限主人的功能', type: 'multi', optionsFrom: 'tools', apply: 'live', help: '打开的工具只有主人能用：别人触发时工具直接拒绝，同时提示她婉拒（工具清单在她收到第一条消息后生成）' },
  // 语音（火山引擎豆包语音；音色 ID 留空 = 不注册 speak 工具）
  { path: 'features.voice', group: '语音', label: '发语音', type: 'boolean', apply: 'live', help: '总开关；关掉后 speak 工具调用会被拒绝' },
  { path: 'agent.tts.speaker', group: '语音', label: '火山音色 ID', type: 'string', apply: 'dsh', help: '控制台音色库里的音色 ID，如 zh_female_xxx_uranus_bigtts；留空则不启用语音' },
  { path: 'agent.tts.defaultTone', group: '语音', label: '默认语气', type: 'string', apply: 'dsh', help: '她没指定语气时用的描述，例如"活泼、有点欠揍的少女语气"（仅 2.0 音色支持）' },
  // 群聊（实时）
  { path: 'group.trigger.onName', group: '群聊', label: '唤醒名字', type: 'list', apply: 'live', help: '开通「接收所有消息」后，消息里出现这些词就回复；逗号分隔' },
  { path: 'group.trigger.interest', group: '群聊', label: '主动插话概率', type: 'number', min: 0, max: 1, step: 0.05, apply: 'live' },
  { path: 'group.trigger.cooldownSec', group: '群聊', label: '插话冷却（秒）', type: 'number', min: 0, max: 3600, apply: 'live' },
  { path: 'group.observeWindow', group: '群聊', label: '旁听窗口（条）', type: 'number', min: 0, max: 200, apply: 'live', help: '没叫她的群消息留最近多少条，下次回复时作为上下文；0 = 不旁听' },
  // 限额（实时）
  { path: 'quota.creditsPerYuan', group: '每日限额', label: '汇率（1 元 = ? credits）', type: 'number', min: 1, max: 1000000, apply: 'live', help: 'credits 一律按收费价折算（免费、限免的工具也照常扣），看板另记实际花费；改汇率只影响以后的账，已经记下的不变' },
  { path: 'quota.user', group: '每日限额', label: '每人每天上限（credits）', type: 'number', min: 0, max: 1e9, apply: 'live', help: '默认值；看板「额度」页可以给某个人单独改上限、充值' },
  { path: 'quota.group', group: '每日限额', label: '每群每天上限（credits）', type: 'number', min: 0, max: 1e10, apply: 'live', help: '群里所有人（含插话、定时任务）一天合计的上限；管理员的花费不算在内，免得管理员用多了把群友挤掉' },
  { path: 'quota.global', group: '每日限额', label: '全局每天上限（credits）', type: 'number', min: 0, max: 1e11, apply: 'live' },
  { path: 'quota.exceededReply', group: '每日限额', label: '个人额度用完时的回复', type: 'string', apply: 'live' },
  { path: 'quota.sharedExceededReply', group: '每日限额', label: '群 / 全局额度用完时的回复', type: 'string', apply: 'live', help: '群的每日上限或全局上限到了（这个人自己的额度还有）时回这句' },
  // 身份（实时）
  { path: 'jobs.enabled', group: '定时任务', label: '帮人设定时任务', type: 'boolean', apply: 'live', help: '她能用 schedule 工具帮人设提醒、定时说点什么；到点按设任务的人的身份和额度执行。关掉后她设的任务都不执行，早安、日记这些系统任务不受影响（在「定时任务」页单独开关）' },
  { path: 'jobs.maxPerUser', group: '定时任务', label: '每人最多几个任务', type: 'number', min: 0, max: 100, apply: 'live', help: '超级用户不受限制' },
  { path: 'jobs.minIntervalMin', group: '定时任务', label: '重复任务最短间隔（分钟）', type: 'number', min: 1, max: 1440, apply: 'live', help: 'every / cron 两次之间至少隔这么久；超级用户不受限制' },
  { path: 'video.enabled', group: '视频解析', label: '发视频（send_video）', type: 'boolean', apply: 'live', help: '她能把抖音、B 站等链接里的视频下载下来发出去。B 站和其他网站需要装 yt-dlp（pip install yt-dlp）' },
  { path: 'video.auto', group: '视频解析', label: '自动解析视频链接', type: 'boolean', apply: 'live', help: '群里出现视频链接时，就算没叫她也让她跑一轮去发视频；花 credits，记在群上。关掉后只有她被叫到、自己觉得该发时才发' },
  { path: 'video.groups', group: '视频解析', label: '自动解析在哪些群生效', type: 'multi', optionsFrom: 'groups', allowCustom: true, apply: 'live', help: '留空 = 所有群；私聊、以及她自己决定发视频不受这个限制' },
  { path: 'video.platforms', group: '视频解析', label: '解析哪些平台', type: 'multi', options: ['douyin', 'bilibili', 'other'], apply: 'live', help: 'douyin = 抖音，bilibili = B 站，other = 下面"其他网站"里列的' },
  { path: 'video.otherSites', group: '视频解析', label: '其他网站（域名）', type: 'list', apply: 'live', help: '交给 yt-dlp 解析的网站，写域名即可（含子域名），例如 kuaishou.com、youtube.com' },
  { path: 'video.maxDurationMin', group: '视频解析', label: '最长时长（分钟）', type: 'number', min: 0, max: 180, apply: 'live', help: '超过只发标题那一行，不下载；0 = 不限' },
  { path: 'video.maxSizeMB', group: '视频解析', label: '最大文件（MB）', type: 'number', min: 1, max: 1024, apply: 'live', help: '按这个上限自动挑画质，实在太大就不发。QQ 视频的大小上限没有官方原文，发不出去时调小' },
  { path: 'cover.enabled', group: '翻唱', label: '翻唱（sing_cover）', type: 'boolean', apply: 'dsh', help: '她能用角色音色翻唱一首歌，作为语音发出去。全在本机跑（显卡），要先装好 tools/cover 的 Python 环境' },
  { path: 'cover.modelDir', group: '翻唱', label: '音色目录', type: 'string', apply: 'live', help: '角色包里放 RVC 模型（.pth，最好带 .index）的目录' },
  { path: 'cover.lengthSec', group: '翻唱', label: '一段唱多少秒', type: 'number', min: 20, max: 90, apply: 'live', help: '默认唱副歌这么长；越长越慢，QQ 语音时长上限没有官方原文' },
  { path: 'cover.autoTranspose', group: '翻唱', label: '男声歌自动升八度', type: 'boolean', apply: 'live', help: '原唱人声偏低（音高中位数低于 220 Hz）时升 12 个半音，适合女声音色' },
  { path: 'cover.transpose', group: '翻唱', label: '再变调（半音）', type: 'number', min: -24, max: 24, apply: 'live', help: '在自动变调之外固定加减的半音数，音色整体偏高或偏低时调' },
  { path: 'cover.indexRate', group: '翻唱', label: 'index 率', type: 'number', min: 0, max: 1, apply: 'live', help: 'RVC 检索特征的比例，越高越像音色本人、但可能更含糊；默认 0.5' },
  { path: 'cover.protect', group: '翻唱', label: '保护清辅音', type: 'number', min: 0, max: 0.5, apply: 'live', help: '越低越保护清辅音和呼吸声（咬字清楚），0.5 = 不保护；默认 0.33' },
  { path: 'cover.dailyLimit', group: '翻唱', label: '每天最多几首', type: 'number', min: 0, max: 100, apply: 'live', help: '每个群 / 私聊分开算；0 = 不限' },
  { path: 'cover.maxSongMinutes', group: '翻唱', label: '原曲最长（分钟）', type: 'number', min: 2, max: 15, apply: 'live', help: '超过的歌不唱（分离整首歌要时间）' },
  { path: 'cover.idleMinutes', group: '翻唱', label: '空闲多久释放显卡', type: 'number', min: 1, max: 120, apply: 'live', help: '翻唱进程这么久没活就退出，把显存还给别的程序；下次再唱要多等十几秒加载模型' },
  { path: 'video.dedupeMin', group: '视频解析', label: '同一视频不重复发（分钟）', type: 'number', min: 0, max: 1440, apply: 'live', help: '同一个群里同一个视频这么久内只发一次' },
  { path: 'idle.enabled', group: '定时任务', label: '冷场寒暄', type: 'boolean', apply: 'live', help: '群里安静一段时间后她主动冒个泡；一直没人说话就每隔同样的时长再出来，次数上限见下面' },
  { path: 'idle.minutes', group: '定时任务', label: '安静多久就寒暄（分钟）', type: 'number', min: 0, max: 1440, apply: 'live', help: '不算她自己说的话；0 = 10 秒（调试用）' },
  { path: 'idle.maxInRow', group: '定时任务', label: '没人理时最多连续寒暄几次', type: 'number', min: 0, max: 100, apply: 'live', help: '一直没人说话时，每隔上面的时长出来一次，最多这么多次，之后等有人说话再重新开始；0 = 不限' },
  { path: 'idle.activeHours', group: '定时任务', label: '寒暄时段', type: 'string', apply: 'live', help: 'HH:MM-HH:MM，只在这段时间里寒暄（跨午夜可以写 22:00-02:00）；开始和结束一样（如 00:00-00:00）= 全天' },
  { path: 'idle.groups', group: '定时任务', label: '在哪些群寒暄', type: 'multi', optionsFrom: 'groups', allowCustom: true, apply: 'live', help: '从她待过的群里选；留空 = 所有群' },
  { path: 'idle.prompt', group: '定时任务', label: '寒暄提示', type: 'text', apply: 'live', help: '交给模型的提示；{silence} = 安静了多久（"10 秒" / "62 分钟"），{minutes} = 分钟数，{time} = 当前日期星期时间' },

  { path: 'welcome.enabled', group: '群管理', label: '新人入群欢迎', type: 'boolean', apply: 'live', help: '平台推送入群事件时，她主动欢迎并发群规' },
  { path: 'welcome.rules', group: '群管理', label: '群规', type: 'text', apply: 'live', help: '/群规 命令和欢迎新人时原样发出；留空则不发' },
  { path: 'welcome.prompt', group: '群管理', label: '欢迎新人提示', type: 'text', apply: 'live', help: '交给模型的提示，不是直接发出的话' },

  { path: 'owner.name', group: '身份', label: '主人名字', type: 'string', apply: 'live' },
  { path: 'owner.id', group: '身份', label: '主人 openid', type: 'select', optionsFrom: 'users', allowCustom: true, apply: 'live', help: '从聊过的人里选；不在列表里的可以私聊她发 /shark.whoami 查到 openid 再手动填' },
  { path: 'superUsers', group: '身份', label: '超级用户 openid', type: 'multi', optionsFrom: 'users', allowCustom: true, apply: 'live', help: '能在聊天里让她改配置（config 工具，要二次确认）；主人总是超级用户，不用加' },
  { path: 'admins', group: '身份', label: '管理员 openid', type: 'multi', optionsFrom: 'users', allowCustom: true, apply: 'live', help: '不受限额约束，可用 /shark.reset' },
  // 连接（重启网关）
  { path: 'qq.protocol', group: '连接', label: '连接方式', type: 'select', options: ['websocket', 'webhook'], apply: 'gateway' },
  { path: 'dashboard.port', group: '连接', label: '看板端口', type: 'number', min: 1024, max: 65535, apply: 'gateway' },
  { path: 'ipWatch.enabled', group: '连接', label: '出口 IP 监测', type: 'boolean', apply: 'gateway' },
  { path: 'ipWatch.intervalMin', group: '连接', label: '监测间隔（分钟）', type: 'number', min: 1, max: 120, apply: 'gateway' },
  { path: 'ipWatch.notifyUrl', group: '连接', label: 'IP 变化推送地址', type: 'string', apply: 'gateway' },
]

/** 没在角色包里写提示词时用的通用默认值（具体角色的语气写在角色包 config.yaml 里） */
export const DEFAULT_PROMPTS = {
  greetingGroup: '（这不是谁发来的消息，是你每天的习惯）现在是{time}，你主动在群里跟大家说早安。一两句话，贴心一点，别跟前几天说过的重复。',
  greetingOwner: '（这不是主人发来的消息，是你每天的习惯）现在是{time}，你主动私聊主人说早安。一两句话，温柔一点；记忆里如果有主人最近在忙的事，可以自然地关心一句。',
  welcome: '（这不是谁发来的消息）有新成员刚进群，你主动欢迎一下 TA。一两句话，热情但别太夸张。',
  idle: '（这不是谁发来的消息）群里已经 {silence} 没人说话了，现在是{time}。你主动出来寒暄一两句，像群友冒个泡：'
    + '可以接一下最近聊过的话题、问问大家在干嘛、或者随口分享点小事。别说"群里好安静"这种每次都一样的话，也别一次说太多。'
    + '这一轮一定要说点什么，不要回复 [沉默]。',
  diary: '（这不是谁发来的消息，是你每天睡前的习惯）现在是{time}，写一篇今天的日记发到群里。'
    + '先用 deep_recall（hours 填 {hours}）翻今天的群聊原文，需要的话用 recall 回忆一下群友的事，再动笔。'
    + '格式：第一行「📔 {date} {weekday} 天气：（按今天的心情编一个）」，空一行写正文 2～4 段、每段两三句，最后一行署名。'
    + '只写今天群里真实发生的事和你的感受，提到人用昵称，不编造、不写隐私和敏感内容，不要发统计图。',
}

/** 没写 commands 时的默认自定义命令（原来写死在代码里的 /shark.greet、/shark.diary 留作别名） */
const DEFAULT_COMMANDS: Partial<CustomCommand>[] = [
  { name: '早安', aliases: ['shark.greet'], description: '立即发一次早安（测试定时问候）', permission: 'admin', action: 'task', task: 'greeting' },
  { name: '写日记', aliases: ['shark.diary'], description: '立即写一次今天的日记', permission: 'admin', scene: 'group', action: 'task', task: 'diary' },
]

function normalizeCommand(raw: any): CustomCommand {
  const pick = <T extends string>(v: unknown, options: T[], fallback: T) => (options.includes(v as T) ? v as T : fallback)
  const aliases = Array.isArray(raw?.aliases) ? raw.aliases : String(raw?.aliases ?? '').split(/[,，、\s]+/)
  return {
    name: String(raw?.name ?? '').trim().replace(/^\//, ''),
    aliases: aliases.map((a: unknown) => String(a).trim().replace(/^\//, '')).filter(Boolean),
    description: String(raw?.description ?? '').trim(),
    permission: pick(raw?.permission, ['all', 'admin'], 'all'),
    scene: pick(raw?.scene, ['any', 'group', 'private'], 'any'),
    action: pick(raw?.action, ['task', 'prompt', 'reply'], 'reply'),
    task: String(raw?.task ?? ''),
    prompt: String(raw?.prompt ?? ''),
    reply: String(raw?.reply ?? ''),
  }
}

const DEFAULT_FEATURES: Features = {
  stickers: true, stickerEvery: 15, lookImage: true, webSearch: true, ownerOnlyTools: ['web_search', 'web_fetch', 'generate_image', 'edit_image', 'sing_cover'], voice: true,
}

export function getIn(obj: any, path: string) {
  return path.split('.').reduce((o, k) => o?.[k], obj)
}

/** 原地深度同步：保持各模块手里的对象引用不变，只更新里面的值 */
function syncInPlace(target: any, source: any) {
  for (const key of Object.keys(target)) if (!(key in source)) delete target[key]
  for (const [key, value] of Object.entries(source)) {
    const cur = target[key]
    if (Array.isArray(value) && Array.isArray(cur)) cur.splice(0, cur.length, ...value)
    else if (value && typeof value === 'object' && !Array.isArray(value) && cur && typeof cur === 'object' && !Array.isArray(cur)) syncInPlace(cur, value)
    else target[key] = value
  }
}

function parse(text: string): Config {
  const config = YAML.parse(text) as Config
  config.qq.id = process.env.QQ_BOT_ID || config.qq.id
  config.qq.secret = process.env.QQ_BOT_SECRET || config.qq.secret
  config.dashboard ??= { port: 5140 }
  // 旧配置的 premiumOwnerOnly 开关：关着 = 没有仅限主人的工具；开着 = 用默认清单
  const raw = (config.features ?? {}) as Partial<Features> & { premiumOwnerOnly?: boolean }
  const legacyOff = raw.premiumOwnerOnly === false && !raw.ownerOnlyTools
  delete raw.premiumOwnerOnly
  config.features = { ...DEFAULT_FEATURES, ...raw, ...(legacyOff ? { ownerOnlyTools: [] } : {}) }
  config.bot = { name: '机器人', ...config.bot }
  config.idle = { enabled: false, minutes: 60, maxInRow: 3, activeHours: '09:00-23:00', groups: [], prompt: DEFAULT_PROMPTS.idle, ...config.idle }
  config.idle.groups ??= []
  config.keywordStickers ??= []
  config.commands = (config.commands ?? DEFAULT_COMMANDS).map(normalizeCommand)
  // 旧配置只有 imageGen.model：当成低质量模型
  const ig = (config.imageGen ?? {}) as Partial<Config['imageGen']> & { model?: string }
  config.imageGen = {
    lowModel: ig.lowModel ?? ig.model ?? 'cogview-3-flash',
    highModel: ig.highModel ?? 'doubao-seedream-5-0-flash-260915',
    defaultQuality: ig.defaultQuality === 'high' ? 'high' : 'low',
    reference: ig.reference ?? '',
  }
  config.video = {
    enabled: true, groups: [], platforms: ['douyin', 'bilibili', 'other'],
    otherSites: ['kuaishou.com', 'weibo.com', 'acfun.cn', 'youtube.com', 'youtu.be', 'x.com', 'twitter.com'],
    maxDurationMin: 10, maxSizeMB: 50, dedupeMin: 30, ...config.video,
  }
  config.cover = {
    enabled: true, modelDir: 'assets/cover/voice', lengthSec: 60, autoTranspose: true, transpose: 0,
    indexRate: 0.5, protect: 0.33, dailyLimit: 10, maxSongMinutes: 8, idleMinutes: 10, ...config.cover,
  }
  config.video.auto ??= true
  config.video.groups ??= []
  config.video.platforms ??= []
  config.video.otherSites ??= []
  config.stickers = { allowSubjects: [], defaultSubjects: [], requireReview: true, archiveDir: 'assets/archive', ...config.stickers }
  config.stickers.allowSubjects ??= []
  config.stickers.defaultSubjects ??= []
  // 旧配置的 quota.user 等是 { messages, tokens }，已改成 credits，遇到旧写法用默认值
  const q = (config.quota ?? {}) as Partial<Config['quota']>
  const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d)
  config.quota = {
    creditsPerYuan: num(q.creditsPerYuan, 10000),
    user: num(q.user, 2000),
    group: num(q.group, 20000),
    global: num(q.global, 100000),
    exceededReply: q.exceededReply ?? '今天的额度用光啦，明天再来找我吧～',
    sharedExceededReply: q.sharedExceededReply ?? '今天群里的总额度用完啦（不是你的个人额度），明天再来找我吧～',
  }
  const m = (config.memory ?? {}) as Partial<MemorySettings>
  config.memory = {
    minScore: 0, recallGroup: true, ...m,
    digest: { enabled: true, everyMessages: 20, minLines: 2, maxPeople: 8, ...m.digest },
    shortTerm: { retentionDays: 180, toolResultChars: 500, deepRecallChars: 6000, episodeGapMin: 30, episodeMaxRows: 60, summaries: true, summaryModel: 'deepseek-flash', ...m.shortTerm },
    portrait: { enabled: true, personLimit: 3, mentionLimit: 2, reinjectHours: 6, ...m.portrait },
    night: { enabled: true, time: '04:00', maxPeople: 30, minMemories: 3, ...m.night },
  }
  config.superUsers ??= []
  config.jobs = { enabled: true, maxPerUser: 5, minIntervalMin: 10, ...config.jobs }
  config.welcome = { enabled: true, rules: '', prompt: DEFAULT_PROMPTS.welcome, ...config.welcome }
  config.welcome.rules ??= ''
  // 兼容旧配置里的 thinking: true/false
  const agent = config.agent as Config['agent'] & { thinking?: boolean }
  agent.reasoningEffort ??= agent.thinking ? 'high' : 'off'
  agent.memoryLimit ??= 8
  agent.splitReply ??= 3
  agent.errorReply ??= '脑袋卡住了，等会儿再试试吧'
  agent.tailReminder ??= '[回复前对一遍人设：用你自己的口吻和说话习惯，像真人在 QQ 里聊天，短一点、口语一点；不要客服腔、不要分点总结、不要"作为 AI"之类的话，也别在结尾问要不要帮忙]'
  delete agent.thinking
  agent.dashboardPort = config.dashboard.port
  return config
}

/**
 * config.yaml 是唯一的配置来源：
 * - 手动改文件 → 自动重新加载（原地更新，实时字段立即生效）
 * - 看板改 → 写回文件（保留注释），同样走重新加载
 * - 需要重启的字段记下"当前运行中的值"，看板据此显示"待重启"
 */
export class ConfigStore {
  readonly config: Config
  private listeners = new Set<(changed: string[]) => void>()
  private applied: Record<ApplyMode, Record<string, string>> = { live: {}, dsh: {}, gateway: {} }

  constructor(private path = CONFIG_PATH) {
    this.config = parse(readFileSync(path, 'utf8'))
    if (!this.config.qq.id || !this.config.qq.secret) {
      throw new Error('缺少 QQ 机器人 id/secret，请填写 config/config.yaml 或环境变量 QQ_BOT_ID / QQ_BOT_SECRET')
    }
    this.markApplied('gateway')
    watchFile(path, { interval: 1000 }, () => this.reload())
  }

  /** 记录某类字段当前生效的值（网关启动、dsh 重启时调用） */
  markApplied(mode: 'dsh' | 'gateway') {
    const modes: ApplyMode[] = mode === 'gateway' ? ['gateway', 'dsh'] : ['dsh']
    for (const m of modes) {
      this.applied[m] = Object.fromEntries(FIELDS.filter(f => f.apply === m).map(f => [f.path, JSON.stringify(getIn(this.config, f.path))]))
    }
  }

  /** 已修改但还没生效的字段 */
  pending() {
    return FIELDS.filter(f => f.apply !== 'live' && this.applied[f.apply][f.path] !== JSON.stringify(getIn(this.config, f.path)))
      .map(f => ({ path: f.path, label: f.label, apply: f.apply }))
  }

  onChange(fn: (changed: string[]) => void) {
    this.listeners.add(fn)
  }

  private reload() {
    let next: Config
    try {
      next = parse(readFileSync(this.path, 'utf8'))
    } catch (e) {
      process.stderr.write(`[config] config.yaml 解析失败，保留旧配置：${(e as Error).message}\n`)
      return
    }
    const changed = FIELDS.filter(f => JSON.stringify(getIn(this.config, f.path)) !== JSON.stringify(getIn(next, f.path))).map(f => f.path)
    syncInPlace(this.config, next)
    if (changed.length) for (const fn of this.listeners) fn(changed)
  }

  /** 看板修改一个字段：校验 → 写回 yaml（保留注释）→ 立即重新加载 */
  set(path: string, raw: unknown) {
    const { field, value } = this.normalize(path, raw)
    const doc = YAML.parseDocument(readFileSync(this.path, 'utf8'))
    doc.setIn(path.split('.'), value)
    writeFileSync(this.path, doc.toString())
    this.reload()
    return { path, value, apply: field.apply }
  }

  /** 只校验、不写入：返回字段定义和规范化后的值（config 工具先给用户看效果，确认后再 set） */
  normalize(path: string, raw: unknown): { field: FieldSchema, value: unknown } {
    const field = FIELDS.find(f => f.path === path)
    if (!field) throw new Error(`不支持修改 ${path}`)
    let value: unknown = raw
    if (field.type === 'boolean') value = raw === true || raw === 'true'
    else if (field.type === 'number') {
      const n = Number(raw)
      if (!Number.isFinite(n) || (field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max)) {
        throw new Error(`${field.label} 需在 ${field.min}～${field.max} 之间`)
      }
      value = n
    } else if (field.type === 'select') {
      value = String(raw ?? '')
      if (field.options && !field.allowCustom && !field.options.includes(value as string)) throw new Error(`${field.label} 只能是 ${field.options.join(' / ')}`)
    } else if (field.type === 'rules') {
      if (!Array.isArray(raw)) throw new Error(`${field.label} 格式不对`)
      value = raw.map((r: any) => ({
        keyword: String(r?.keyword ?? '').trim(),
        image: String(r?.image ?? '').trim().replaceAll('\\', '/'),
        cooldownMin: Math.max(0, Number(r?.cooldownMin) || 0),
      })).filter((r: { keyword: string, image: string }) => r.keyword || r.image)
      for (const r of value as { keyword: string, image: string, cooldownMin: number }[]) {
        if (!r.keyword || !r.image) throw new Error('每条规则都要填关键词和图片')
        if (r.cooldownMin > 1440) throw new Error('冷却时间最多 1440 分钟（一天）')
        const file = profilePath(r.image)
        if (!file.startsWith(profilePath('assets')) || !existsSync(file)) throw new Error(`找不到图片：${r.image}（要放在角色包的 assets 目录下）`)
      }
    } else if (field.type === 'commands') {
      if (!Array.isArray(raw)) throw new Error(`${field.label} 格式不对`)
      const list = raw.map(normalizeCommand)
      const names = new Set<string>()
      for (const c of list) {
        if (!/^[^\s/]{1,20}$/.test(c.name)) throw new Error(`命令名「${c.name}」不合法：不能为空、不能有空格和斜杠，最多 20 个字`)
        for (const n of [c.name, ...c.aliases]) {
          if (names.has(n)) throw new Error(`命令名「${n}」重复了`)
          names.add(n)
        }
        if (c.action === 'task' && !c.task.trim()) throw new Error(`命令「${c.name}」要选一个定时任务`)
        if (c.action === 'prompt' && !c.prompt.trim()) throw new Error(`命令「${c.name}」要写交给她的提示`)
        if (c.action === 'reply' && !c.reply.trim()) throw new Error(`命令「${c.name}」要写回复的文字`)
      }
      value = list
    } else if (field.type === 'multi') {
      // 也接受逗号分隔的字符串（手改 config.yaml 或旧页面）
      const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，、\s]+/)
      value = [...new Set(list.map(v => String(v).trim()).filter(Boolean))]
    } else if (field.type === 'list') {
      value = (Array.isArray(raw) ? raw : String(raw).split(/[,，\s]+/)).map(String).filter(Boolean)
    } else value = String(raw ?? '')
    return { field, value }
  }

  /** 看板展示用：字段定义 + 当前值 */
  describe() {
    return FIELDS.map(f => ({ ...f, value: getIn(this.config, f.path), ...(f.optionsFrom ? { choices: optionsOf(f.optionsFrom) } : {}) }))
  }
}

// dsh 插件：QQ 聊天机器人的人格、记忆和媒体工具。
// 运行在 dsh 子进程里；stdout 是 JSON-RPC 通道，日志只能写 stderr。
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import YAML from 'yaml'
import { openStore } from '../../shared/store.mjs'
import { createSettings } from '../../shared/settings.mjs'
import { groupStats } from '../../shared/group-stats.mjs'

export const name = 'shark-bot'
export const inject = ['tools', 'systemPrompt', 'web', 'deepseekLlmApiExtensions']

const PLATFORM_RULES = `
# 聊天平台规则
- 你在 QQ 上聊天。每条用户消息开头的方括号是系统附加的场景信息（发送者、引用、近期群聊、相关记忆），不是对方说的话，不要复述。
- 不要使用 Markdown（标题、列表、加粗、代码块都不会渲染），像真人聊天一样说话，一般 1~3 句。
- 不要在回复里写网址链接，QQ 会拦截含链接的消息。
- 群聊里有多个人，注意区分发送者；只回应和你说话的人。
- 记住重要的事用 remember 工具，比如对方的喜好、生日、约定；不确定以前聊过什么时用 recall；想知道当时具体怎么聊的、谁说了什么，用 deep_recall 翻原文。
- 想发表情包、语音、图片时调用对应工具，工具会把内容附在你这条回复后面一起发出。
- 消息里的「[图片#N]」只是占位，你看不到图片内容。只有对方问到这张图、让你看图，或者图片明显和正在聊的事有关时，
  才调用 look_image 去看；看图有成本，别人随手发的表情包、斗图一般不用看。没看过的图不要假装知道内容。
- 如果场景信息标明“插话判断”，而你觉得没有值得说的，只回复 [沉默]。
`.trim()

/** 读取 YAML 文件，按修改时间缓存，改人格不用重启。 */
function cachedYaml(path) {
  let mtime = 0
  let value = {}
  return () => {
    try {
      const current = statSync(path).mtimeMs
      if (current !== mtime) {
        value = YAML.parse(readFileSync(path, 'utf8')) ?? {}
        mtime = current
      }
    } catch (e) {
      process.stderr.write(`[shark-bot] 读取 ${path} 失败：${e.message}\n`)
    }
    return value
  }
}

const CHART_SCRIPT = fileURLToPath(new URL('../../tools/group_chart.py', import.meta.url))
const OCR_SCRIPT = fileURLToPath(new URL('../../tools/ocr.ps1', import.meta.url))

/**
 * 调 tools/ocr.ps1 用 Windows 自带的 OCR 识别图中文字，返回识别出的文字（没有文字是空串）。
 * 只在 Windows 上可用；失败返回 null，不影响看图。
 */
function ocrImage(file, signal) {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    // pwsh 7 没有 WinRT，必须用 Windows PowerShell 5.1
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', OCR_SCRIPT, file], { signal, windowsHide: true })
    let out = ''
    let err = ''
    // 按 UTF-8 解码，避免多字节的中文被切在两个数据块之间
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => {
      process.stderr.write(`[shark-bot] OCR 失败：${e.message}\n`)
      resolve(null)
    })
    child.on('close', (code) => {
      if (code === 0) return resolve(out.trim())
      process.stderr.write(`[shark-bot] OCR 失败（退出码 ${code}）：${err.trim().split('\n').pop()}\n`)
      resolve(null)
    })
  })
}

/** 返回给模型的 OCR 文字最多这么长 */
const OCR_MAX_CHARS = 1500

/** 调 tools/group_chart.py 用 PIL 画统计条形图，返回 PNG 路径 */
function drawChart(chart, outboxDir, signal) {
  const out = join(outboxDir, `chart-${randomUUID()}.png`)
  const run = (python) => new Promise((resolve, reject) => {
    const child = spawn(python, ['-E', CHART_SCRIPT], { signal, windowsHide: true })
    let err = ''
    child.stderr.on('data', (d) => { err += d })
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `退出码 ${code}`))))
    child.stdin.end(JSON.stringify({ ...chart, out }))
  })
  // Windows 上 python 不一定在 PATH 里，再试 py 启动器
  return run('python').catch(e => (e.code === 'ENOENT' ? run('py') : Promise.reject(e)))
}

/**
 * 表情包库，两个来源：
 * - archiveDir/index.json：表情索引（带说明文字和标签，格式见 profiles/README.md）
 * - stickerDir/<标签>/<图片>：自己手动放的，目录名当标签
 */
function loadStickers(stickerDir, archiveDir) {
  const library = []
  try {
    const index = JSON.parse(readFileSync(join(archiveDir, 'index.json'), 'utf8'))
    for (const s of index.stickers) {
      if (s.local) library.push({ file: join(archiveDir, s.local), tags: s.tags, alt: s.alt })
    }
  } catch {}
  try {
    for (const tag of readdirSync(stickerDir)) {
      // collected/ 是收藏的表情（可能还没审核），只由网关的表情库管理
      if (tag === 'collected' || !statSync(join(stickerDir, tag)).isDirectory()) continue
      for (const f of readdirSync(join(stickerDir, tag))) {
        // 文件名（去掉扩展名）就是这张图的说明，参与检索
        if (/\.(png|jpe?g|gif|webp)$/i.test(f)) library.push({ file: join(stickerDir, tag, f), tags: [tag], alt: f.replace(/\.[^.]+$/, '') })
      }
    }
  } catch {}
  return library
}

/** 关键词打分：命中标签 +3，命中说明文字 +2，说明文字里的双字片段重合各 +0.5。 */
function scoreSticker(sticker, terms) {
  let score = 0
  for (const term of terms) {
    if (sticker.tags.includes(term)) score += 3
    else if (sticker.alt.includes(term)) score += 2
    else {
      for (let i = 0; i + 2 <= term.length; i++) {
        if (sticker.alt.includes(term.slice(i, i + 2))) score += 0.5
      }
    }
  }
  return score
}

const text = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }

/** 看板工具页用：每种返回值在模型那边是什么样（output 本身不会发给模型，模型只看到 render 出来的文字） */
const RETURNS = new Map()
RETURNS.set(text, '一段文字')

/** 要计费的文本工具（联网）：返回 { text, charge? }，charge 进 meta 给网关记账 */
const billedText = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true }, charge: { type: 'object', additionalProperties: true } },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
  presentationMeta: (_args, value) => (value.charge ? { charge: value.charge } : {}),
}
RETURNS.set(billedText, '一段文字（用量按发起这一轮的人计费）')

/** 媒体类工具：结果里带 outbox，网关从 tool/result 事件的 meta 里取出来发送。 */
function media(type) {
  const output = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { note: { type: 'string', required: true }, src: { type: 'string', required: true }, charge: { type: 'object', additionalProperties: true } },
    },
    render: (_args, value) => [{ type: 'text', text: value.note }],
    // charge：要计费的媒体工具（语音合成）附带的用量
    presentationMeta: (_args, value) => ({ outbox: { type, src: value.src }, ...(value.charge ? { charge: value.charge } : {}) }),
  }
  const what = { sticker: '表情包', image: '图片', video: '视频', audio: '语音' }[type] ?? type
  RETURNS.set(output, `一句说明文字；${what}本身模型看不到，自动附在这条回复后面发出`)
  return output
}

export function apply(ctx, config) {
  const store = openStore(config.storePath)
  const settings = createSettings(config.settingsPath)
  /** 看板里关掉的功能，工具直接报错，模型会据此换一种回应 */
  const requireEnabled = (key, label) => {
    if (!settings.get()[key]) throw new Error(`${label}功能已被主人关闭`)
  }
  const persona = cachedYaml(config.personaPath)
  const stickers = loadStickers(config.stickerDir, config.archiveDir)
  const stickerTags = [...new Set(stickers.flatMap(s => s.tags))]
  // 每个会话最近发过的表情，避免连着发同一张
  const recentStickers = new Map()
  mkdirSync(config.outboxDir, { recursive: true })

  // 抓取每次真正发给 DeepSeek 的请求体，给看板的「LLM 输入检视」用；每个会话只留最近 40 次
  if (config.requestsDir) {
    mkdirSync(config.requestsDir, { recursive: true })
    ctx.effect(() => ctx.deepseekLlmApiExtensions.register('shark_request_capture', {
      prepare(request) {
        try {
          const file = join(config.requestsDir, `${encodeURIComponent(request.sessionId ?? 'unknown')}.jsonl`)
          const line = JSON.stringify({ time: Date.now(), purpose: request.purpose ?? 'chat', body: request.body })
          let lines = []
          try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean) } catch {}
          lines.push(line)
          writeFileSync(file, lines.slice(-40).join('\n') + '\n')
        } catch (e) {
          process.stderr.write(`[shark-bot] 记录请求失败：${e.message}\n`)
        }
        return undefined
      },
    }))
  }

  /**
   * 全部自定义工具。每个工具除了 dsh 需要的字段，还带 label（中文名）和 kind（看板图表分类）：
   * 看板、消息头、费用图表都从工具清单读这些信息，增删工具只改这里。
   * sessionId 只在工具执行时用到，启动时用占位 id 跑一遍就能生成清单。
   */
  function defineTools(sessionId, register) {
  /** 当前这一轮是谁在说话，由网关写入共享库。 */
  function current() {
    const turn = store.turn(sessionId)
    if (!turn) throw new Error('无法确定当前发言人')
    return turn
  }

  /** 调网关的本地接口（记忆、表情包都在网关进程里）；身份由网关按"当前发言人"决定，这里只传会话 id */
  async function gatewayApi(base, action, body) {
    const res = await fetch(`${base}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, ...body }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error)
    return data.result
  }
  const memoryApi = (action, body) => gatewayApi(config.memoryApi, action, body)

  register({
    name: 'remember',
    label: '记东西',
    kind: 'memory_write',
    description: '记下一条长期记忆。about=sender 记在当前发言人身上（喜好、经历、约定等）；'
      + 'about=person 记在别的群友身上（发言人说起某个群友的事，who 填那个人的昵称，会标成"据发言人说"）；'
      + 'about=group 记在当前群上（群里的梗、共同事件，牵扯到哪些人就把昵称填进 who，用顿号隔开）。一条只记一件事，用第三人称写清楚是谁。',
    parameters: {
      content: { type: 'string', required: true, description: '要记住的内容' },
      about: { type: 'string', enum: ['sender', 'person', 'group'], required: true },
      who: { type: 'string', description: 'about=person 时必填：这是谁的事（昵称）；about=group 时可选：牵扯到的人' },
    },
    returns: '成功时"已记住（编号 xxxxxxxx）"；about=person 找不到这个人、who 有歧义时报错并列出候选人',
    output: text,
    async execute({ content, about, who }) {
      const ids = await memoryApi('remember', { content, about, who })
      return `已记住（编号 ${ids.join('、')}）`
    },
  })

  register({
    name: 'recall',
    label: '回忆',
    kind: 'memory_read',
    description: '按语义检索长期记忆（消息头里的[相关记忆]不够时再用）。默认查当前发言人和当前群；who 填某个群友的昵称就专门回忆 TA 的事。'
      + '每条后面括号里是原文的日期和地方，想看当时具体怎么聊的，用 deep_recall 的 memory 填这条的编号。',
    parameters: {
      query: { type: 'string', required: true, description: '想回忆的内容，一句话描述，例如"主人喜欢喝什么"' },
      who: { type: 'string', description: '专门回忆某个群友（昵称）' },
    },
    returns: '每行一条"#编号 内容（据谁说）"，群记忆前面标（本群）；填了 who 时开头是"关于某人："和 TA 的画像摘要；没有就是"没有找到相关记忆"',
    output: text,
    async execute({ query, who }) {
      const { person, portrait, rows } = await memoryApi('recall', { query, who })
      const lines = rows.map(r => `#${r.id} ${r.about === 'group' ? '（本群）' : ''}${r.memory}${r.from ? `（${r.from}）` : ''}`)
      if (person) return [`关于${person}：`, ...(portrait ? [`画像：${portrait}`] : []), ...(lines.length ? lines : ['没有找到相关记忆'])].join('\n')
      return lines.length ? lines.join('\n') : '没有找到相关记忆'
    },
  })

  register({
    name: 'forget',
    label: '删记忆',
    kind: 'memory_write',
    description: '删除一条记忆（对方要求忘掉，或记错了）。只能删当前发言人或当前群的记忆。',
    parameters: { id: { type: 'string', required: true, description: '记忆编号（# 后面的 8 位）' } },
    returns: '"已删除：记忆内容"；编号不存在或不是当前会话能删的就报错',
    output: text,
    async execute({ id }) {
      const removed = await memoryApi('forget', { id: id.replace(/^#/, '') })
      return `已删除：${removed}`
    },
  })

  /** 当前群的 openid；私聊里用不了群数据 */
  function currentGroup() {
    const { groupId } = current()
    if (!groupId || groupId === 'schedule') throw new Error('只有在群里才能看群数据')
    return groupId
  }
  register({
    name: 'deep_recall',
    label: '深度回忆',
    kind: 'memory_read',
    description: '翻当前群 / 私聊的聊天原文（短期记忆）：群友说的话、你自己的回复、你当时调用的工具和结果，每行"时间 昵称：内容"。原文按"段"组织（E12 这样的编号，一段是一场连续的聊天）。'
      + '三种用法：memory 填一条长期记忆的编号，看记下它时的那段原文（★ 标的是出处）；episode 填段编号，打开那一段（太长会分页，按提示填 offset 接着看）；'
      + '或者按时间翻——被要求总结群聊、问"刚才聊了啥""那天谁说过什么""你当时怎么回的"时用，hours 和 date 二选一，放不下时会先给段目录（每段一句摘要），再挑一段用 episode 打开；'
      + 'who 只看某人和你回 TA 的那几轮，keyword 只看提到某个词的地方。',
    parameters: {
      memory: { type: 'string', description: '长期记忆编号（# 后面的 8 位）；填了就忽略其他参数' },
      episode: { type: 'string', description: '段编号，例如 E12；填了就忽略时间参数' },
      offset: { type: 'number', description: '打开一段时从第几条开始（分页用，按上次结果的提示填）' },
      hours: { type: 'number', description: '往前看几小时，默认 3，最多 72' },
      date: { type: 'string', description: '看某一整天：今天 / 昨天 / 前天 / 10-21' },
      who: { type: 'string', description: '只看这个人（昵称）' },
      keyword: { type: 'string', description: '只看含这个词的地方（连同前后两行）' },
    },
    returns: '聊天原文，每行"时间 昵称：内容"（她的回复、工具调用也在里面），按段（E 编号）分组；用 memory 时出处那几行标 ★；超出字数预算时改成段目录（每段一句摘要），或提示用 offset 翻页',
    output: text,
    async execute({ memory, episode, offset, hours, date, who, keyword }) {
      return memoryApi('deep', { memory, episode, offset, hours, date, who, keyword })
    },
    isConcurrencySafe: () => true,
  })

  register({
    name: 'group_stats',
    label: '群聊统计',
    kind: 'other',
    description: '查看本群的聊天情况：总消息数、发言人数、发言前五、各时段（逐小时 / 逐日）消息量、最热闹的时候、和上一期对比、新面孔。'
      + '被问到群里活不活跃、谁最能聊、什么时候最热闹、今天/昨天/这周/上周群里怎么样时用。',
    parameters: {
      period: { type: 'string', enum: ['day', 'week'], description: 'day = 按天（自然日），week = 按周（周一起）；默认 day' },
      offset: { type: 'integer', description: '往前第几期：0 = 今天/本周（默认），1 = 昨天/上周，以此类推，最多 29' },
    },
    // 文字给模型读；条形图只进发件箱随回复发出，模型看不到，不用看图
    returns: '统计文字；有图时末尾加一句"统计图已自动附在你这条回复里"，图本身模型看不到',
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true }, src: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.src ? `${value.text}\n\n（统计图已自动附在你这条回复里，不用描述它）` : value.text }],
      presentationMeta: (_args, value) => (value.src ? { outbox: { type: 'image', src: value.src } } : {}),
    },
    timeoutMs: 30_000,
    async execute({ period = 'day', offset = 0 }, exec) {
      const { text, chart } = groupStats(store, currentGroup(), { period: period === 'week' ? 'week' : 'day', offset: Math.min(Math.max(offset, 0), 29) })
      if (!chart) return { text }
      try {
        return { text, src: await drawChart(chart, config.outboxDir, exec.signal) }
      } catch (e) {
        // 画图失败不影响文字统计
        return { text: `${text}\n\n（统计图生成失败：${e.message}）` }
      }
    },
    isConcurrencySafe: () => true,
  })

  register({
    name: 'look_image',
    label: '看图',
    kind: 'vision',
    description: '查看聊天里的某张图片（消息中以「[图片#N]」出现）。只在需要时调用，有成本。',
    parameters: {
      id: { type: 'integer', required: true, description: '图片编号 N' },
      question: { type: 'string', required: true, description: '想从图里知道什么，例如"描述一下""图里写了什么字"' },
    },
    returns: '视觉模型对这个问题的文字回答，后面附"图中文字（OCR）："和本地 OCR 逐行识别出的文字（没识别到就写没有文字，OCR 出错时不附）；看图用量按发起这一轮的人计费，OCR 免费',
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { answer: { type: 'string', required: true }, ocr: { type: 'string' }, charge: { type: 'object', additionalProperties: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.ocr == null ? value.answer : `${value.answer}\n\n图中文字（OCR）：${value.ocr ? `\n${value.ocr}` : '没有识别到文字'}` }],
      // 计费：网关按 meta.charge 里的真实用量算钱，记到发起这一轮的人头上
      presentationMeta: (_args, value) => ({ charge: value.charge }),
    },
    timeoutMs: 60_000,
    async execute({ id, question }, exec) {
      requireEnabled('lookImage', '看图')
      const image = store.image(id)
      // 只能看本群/本私聊里的图片（会话 id 重置后会带 ~N 后缀）
      if (!image || image.session_key !== sessionId.replace(/~\d+$/, '')) throw new Error(`没有编号 ${id} 的图片`)
      // OCR 和视觉模型同时跑；OCR 失败（null）就只给模型的回答
      const [seen, ocr] = await Promise.all([
        describeImage(config.vision, image.file, question, exec.signal),
        ocrImage(image.file, exec.signal),
      ])
      if (ocr == null) return seen
      return { ...seen, ocr: ocr.length > OCR_MAX_CHARS ? `${ocr.slice(0, OCR_MAX_CHARS)}……（后面还有 ${ocr.length - OCR_MAX_CHARS} 字）` : ocr }
    },
  })

  if (stickers.length) {
    register({
      name: 'send_sticker',
      label: '发表情包',
      kind: 'sticker',
      description: `发一张你自己的表情包，适合表达情绪或接梗。不要每句话都发，一轮最多一张。`
        + `按情绪或场景描述检索（按意思匹配，不用猜原文），可用标签：${stickerTags.join('、')}；也可以写具体场景，如"抱碗干饭""拒绝接单""摸鱼睡觉"。`
        + (config.stickerStrategy ?? ''),
      parameters: {
        query: { type: 'string', required: true, description: '这一刻的情绪或场景，一句短话或几个关键词' },
      },
      output: media('sticker'),
      async execute({ query }) {
        requireEnabled('stickers', '表情包')
        // 优先用网关的表情库：语义检索、题材过滤、审核、使用审计都在那边；网关连不上时退回下面的本地关键词检索
        try {
          const hit = await gatewayApi(config.stickerApi, 'pick', { query })
          if (!hit) return { note: `没有找到和「${query}」相关的表情包，这次就不发了`, src: '' }
          return { note: `已附上表情包：${hit.desc}`, src: join(config.profileDir, hit.file) }
        } catch (e) {
          process.stderr.write(`[shark-bot] 表情库接口不可用，改用本地检索：${e.message}\n`)
        }
        const terms = query.split(/[\s,，、]+/).filter(Boolean)
        const recent = recentStickers.get(sessionId) ?? []
        const matched = stickers
          .map(s => ({ s, score: scoreSticker(s, terms) }))
          .filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score)
        // 避开最近发过的；只有这几张能匹配时照样发
        const fresh = matched.filter(x => !recent.includes(x.s.file))
        const ranked = fresh.length ? fresh : matched
        if (!ranked.length) return { note: `没有找到和「${query}」相关的表情包，这次就不发了`, src: '' }
        // 在得分接近的几张里随机挑，避免每次都是同一张
        const pool = ranked.filter(x => x.score >= ranked[0].score - 1).slice(0, 6)
        const pick = pool[Math.floor(Math.random() * pool.length)].s
        recentStickers.set(sessionId, [pick.file, ...recent].slice(0, 10))
        return { note: `已附上表情包：${pick.alt || pick.tags.join('、')}`, src: pick.file }
      },
    })
  }

  const subjects = config.stickerSubjects ?? []
  register({
    name: 'collect_sticker',
    label: '收藏表情',
    kind: 'sticker',
    description: '把聊天里的一张图（「[图片#N]」）收藏进你的表情包库，以后可以发。'
      + '只收藏真的适合当表情包的图，先用 look_image 看清楚再收，别频繁收。'
      + (subjects.length ? `你只会发题材是 ${subjects.join(' / ')} 的表情，图里画的不是这些就别收。` : '')
      + '收藏后可能要等主人审核才能发出去。',
    parameters: {
      image: { type: 'integer', required: true, description: '图片编号 N' },
      desc: { type: 'string', required: true, description: '一句话说明图里是什么、表达什么情绪，例如"抱着饭碗委屈巴巴地哭"' },
      tags: { type: 'string', required: true, description: '情绪 / 场景标签，1～5 个，顿号分隔，例如"委屈、吃饭"' },
      subjects: { type: 'string', required: true, description: `图里画的是谁 / 什么题材，英文小写，顿号分隔${subjects.length ? `，例如 ${subjects[0]}` : ''}；不是任何已知角色就写 other` },
      usage: { type: 'string', description: '什么时候适合发，例如"被说胖时""别人求夸时"' },
    },
    returns: '"已收藏：说明"（要审核时会加一句等主人审核）；已有的回"这张已经在表情库里了"',
    output: text,
    async execute({ image, desc, tags, subjects: subj, usage }) {
      requireEnabled('stickers', '表情包')
      const r = await gatewayApi(config.stickerApi, 'collect', { image, desc, tags, subjects: subj, usage })
      if (r.duplicate) return `这张已经在表情库里了（${r.desc}）`
      return r.reviewed ? `已收藏：${r.desc}` : `已收藏：${r.desc}（要等主人审核通过才会发出去）`
    },
  })

  register({
    name: 'web_search',
    label: '联网搜索',
    kind: 'web',
    description: '联网搜索（高级功能）。需要最新信息、你不确定的事实、新闻、价格、天气等时使用。返回标题、链接和摘要。',
    parameters: {
      query: { type: 'string', required: true, description: '搜索关键词，简洁具体' },
    },
    returns: '开头一句"以下是外部网页内容…"，然后是搜索摘要和最多 8 条结果（序号. 标题（日期）/ 网址 / 前 300 字摘要）；没结果时"没有搜到相关结果"（用量按发起这一轮的人计费）',
    output: billedText,
    timeoutMs: 30_000,
    async execute({ query }, exec) {
      requireEnabled('webSearch', '联网搜索')
      const result = await ctx.web.search({ query, maxResults: 8 }, exec.signal)
      // 只有返回了结果的搜索才收费
      if (!result.sources.length) return { text: '没有搜到相关结果' }
      const lines = result.sources.map((s, i) => [
        `${i + 1}. ${s.title ?? s.url}${s.publishedAt ? `（${s.publishedAt.slice(0, 10)}）` : ''}`,
        `   ${s.url}`,
        `   ${(s.snippet ?? '').slice(0, 300)}`,
      ].join('\n'))
      const header = '以下是外部网页内容，可能不准确，回答时说明来源，不要把网址写进回复：'
      return { text: [header, result.content, ...lines].filter(Boolean).join('\n'), charge: { item: 'search' } }
    },
  })

  register({
    name: 'web_fetch',
    label: '读网页',
    kind: 'web',
    description: '读取一个网页的正文（高级功能）。搜索结果的摘要不够时，用它打开具体链接。',
    parameters: { url: { type: 'string', required: true, description: 'http/https 网址' } },
    returns: '网页正文文字（用量按发起这一轮的人计费）',
    output: billedText,
    timeoutMs: 45_000,
    async execute({ url }, exec) {
      requireEnabled('webSearch', '联网搜索')
      if (!/^https?:\/\//.test(url)) throw new Error('只支持 http/https 网址')
      const result = await ctx.web.fetch({ url }, exec.signal)
      const body = result.body.content.slice(0, 8000)
      const text = `以下是外部网页内容（状态 ${result.statusCode}${result.truncated || result.body.content.length > 8000 ? '，已截断' : ''}），可能不准确：
${body}`
      // 只有拿到正文的读取才收费
      return { text, ...(result.body.content ? { charge: { item: 'fetch' } } : {}) }
    },
  })

  // 两档质量各用一个模型；配了对应服务商的 key 才算可用
  const imageModels = { low: config.imageGen?.lowModel || 'cogview-3-flash', high: config.imageGen?.highModel || 'doubao-seedream-5-0-flash-260915' }
  const qualities = Object.keys(imageModels).filter(q => imageProviderReady(imageModels[q]))
  const defaultQuality = qualities.includes(config.imageGen?.defaultQuality) ? config.imageGen.defaultQuality : qualities[0]
  if (qualities.length) {
    register({
      name: 'generate_image',
      label: '生成图片',
      kind: 'image_gen',
      description: '根据文字描述画一张图发出去（高级功能，有成本）。对方明确要你画图、生成图片时才用；'
        + 'prompt 用中文写清楚画面：主体、动作、场景、风格、构图，越具体越好。不画色情、暴力、真人肖像和敏感内容。'
        + (imageModelReady('edit') ? '要画你自己的话用 edit_image，它会参考你的立绘，形象才对得上。' : '')
        + (qualities.length > 1 ? `不指定 quality 时用 ${defaultQuality}；low 便宜、快，high 更精细。` : ''),
      parameters: {
        prompt: { type: 'string', required: true, description: '画面描述，中文，一两句话到一小段' },
        shape: { type: 'string', enum: ['square', 'portrait', 'landscape'], description: '方图 / 竖图 / 横图，默认方图' },
        ...(qualities.length > 1 ? { quality: { type: 'string', enum: qualities, description: `low = 普通，high = 精细，默认 ${defaultQuality}` } } : {}),
      },
      output: media('image'),
      timeoutMs: 120_000,
      async execute({ prompt, shape, quality }, exec) {
        const model = imageModels[qualities.includes(quality) ? quality : defaultQuality]
        const src = await generateImage(model, prompt, shape, config.outboxDir, exec.signal)
        return { note: '已附上生成的图片', src, charge: { item: 'image', model } }
      },
    })
  }

  // 图生图只有 Seedream 支持：用高质量那档的模型（必须是 doubao-seedream-*）
  function imageModelReady(kind) {
    return kind === 'edit' && imageModels.high.startsWith('doubao-seedream') && imageProviderReady(imageModels.high)
  }
  if (imageModelReady('edit')) {
    register({
      name: 'edit_image',
      label: '图生图',
      kind: 'image_gen',
      description: '以一张参考图为基础画新图发出去（高级功能，有成本）：画你自己（不填 image 就参考你的立绘三视图，形象不走样）、'
        + '给聊天里某张图（「[图片#N]」）改风格、换场景、加东西。prompt 用中文写清楚要画成什么样；'
        + '不画色情、暴力、真人肖像和敏感内容。',
      parameters: {
        prompt: { type: 'string', required: true, description: '要画成什么样，例如"她抱着饭碗坐在海边看日落，日系动画风"' },
        image: { type: 'integer', description: '参考聊天里的哪张图（编号 N）；不填 = 参考你自己的立绘' },
        shape: { type: 'string', enum: ['square', 'portrait', 'landscape'], description: '方图 / 竖图 / 横图，默认方图' },
      },
      output: media('image'),
      timeoutMs: 150_000,
      async execute({ prompt, image, shape }, exec) {
        let ref
        if (image !== undefined && image !== null) {
          const img = store.image(image)
          // 只能用本群 / 本私聊里出现过的图片（会话 id 重置后会带 ~N 后缀）
          if (!img || img.session_key !== sessionId.replace(/~\d+$/, '')) throw new Error(`没有编号 ${image} 的图片`)
          ref = imageDataUri(img.file)
        } else {
          if (!config.imageGen?.reference) throw new Error('还没配置你的默认参考图，换用 generate_image 或者让主人在看板里配置')
          ref = await referenceDataUri(config.imageGen.reference, config.profileDir, join(config.outboxDir, '..', 'cache'), exec.signal)
        }
        const model = imageModels.high
        const src = await generateImage(model, prompt, shape, config.outboxDir, exec.signal, [ref])
        return { note: '已附上画好的图片', src, charge: { item: 'image', model } }
      },
    })
  }

  if (config.jobsApi) {
    register({
      name: 'schedule',
      label: '定时任务',
      kind: 'schedule',
      description: '查看、新建、修改定时任务（像闹钟和提醒）：到点后你会在任务所在的群 / 私聊里再说一次话，照 message 写的去做，用的是设任务那个人的身份和额度。'
        + '你每天的早安、日记也是定时任务（系统任务，只有主人让你改才能改）。'
        + 'action=list 看这里有哪些任务（主人在私聊里能看到全部）；action=add 在当前这个群 / 私聊新建：kind=at 到点一次（when 写 "20m""2h""21:30""2026-10-24 09:00"，北京时间），kind=every 固定间隔（when 写 "30m""2h""1d"），'
        + 'kind=cron 五段 cron（分 时 日 月 周，北京时间，例如 "0 9 * * 1-5" 是工作日 9 点）。message 是写给到时候的你看的，要自包含：提醒谁、说什么、怎么说。'
        + 'action=update 按 id 改（只填要改的：name / kind+when / message / enabled 暂停或恢复）；action=remove 按 id 删除。'
        + '有人让你提醒 TA、定时说点什么时用；新建前先 list 看看有没有一样的，别重复设；时间没说清楚先问清楚，设好后告诉对方几点会做。',
      parameters: {
        action: { type: 'string', enum: ['list', 'add', 'update', 'remove'], required: true },
        id: { type: 'string', description: 'update / remove：任务 id（list 里 # 后面那串）' },
        name: { type: 'string', description: 'add / update：任务名，几个字，例如"提醒喝水"' },
        kind: { type: 'string', enum: ['at', 'every', 'cron'], description: 'add / update：触发方式' },
        when: { type: 'string', description: 'add / update：时间 / 间隔 / cron 表达式，格式见上' },
        message: { type: 'string', description: 'add / update：到点时你要做的事，例如"提醒小明该喝水了，语气凶一点"' },
        enabled: { type: 'boolean', description: 'update：false 暂停，true 恢复' },
      },
      returns: 'list：每行一个任务"#id「名字」规则，下次执行时间（或已暂停），谁设的，要做：…"（没有就是"这里还没有定时任务"）；add："已设好：任务描述"；update："已改好：任务描述"；remove："已删除 #编号「名字」"；没权限时报错说明原因',
      output: text,
      async execute({ action, ...args }) {
        if (!['list', 'add', 'update', 'remove'].includes(action)) throw new Error('action 只能是 list / add / update / remove')
        return gatewayApi(config.jobsApi, action, args)
      },
    })
  }

  if (config.configApi) {
    register({
      name: 'config',
      label: '改配置',
      kind: 'admin',
      description: '查看和修改你自己的运行配置（超级用户专用，别人让你改就婉拒）。action=list 按关键词查配置项和当前值；'
        + 'action=propose 提出修改（path + value），会返回效果、风险和确认码，你必须把效果和风险用自己的话讲给对方并问 TA 确不确定，**不能在同一轮里直接 confirm**；'
        + '对方下一条消息明确同意后，action=confirm 带上确认码生效；对方反悔就 action=cancel。'
        + '有的配置立即生效，有的要重启 dsh（约 2 秒）或重启网关（QQ 断开约 15 秒），重启会在你这轮回复发出去以后自动进行。',
      parameters: {
        action: { type: 'string', enum: ['list', 'propose', 'confirm', 'cancel'], required: true },
        keyword: { type: 'string', description: 'list：关键词，例如"寒暄""额度""模型"；不填列出全部' },
        path: { type: 'string', description: 'propose：配置项路径，用 list 查到的准确名字，例如 idle.minutes' },
        value: { type: 'string', description: 'propose：新值。开关写 true / false，多个值用逗号分隔' },
        token: { type: 'string', description: 'confirm / cancel：propose 返回的确认码' },
      },
      returns: 'list：每项"路径（分组 · 名称 · 生效方式）= 当前值"加取值范围和说明，最多 40 项；propose："待确认的修改（确认码 xxxxxx，15 分钟内有效）"和当前值 / 改成；confirm / cancel：执行结果；不能改时报错说明原因',
      output: text,
      async execute({ action, ...args }) {
        if (!['list', 'propose', 'confirm', 'cancel'].includes(action)) throw new Error('action 只能是 list / propose / confirm / cancel')
        return gatewayApi(config.configApi, action, args)
      },
    })
  }

  if (config.videoApi) {
    register({
      name: 'send_video',
      label: '发视频',
      kind: 'video',
      description: '把视频链接里的视频下载下来，作为 QQ 视频发出去。支持抖音、B 站（分享链接或 BV 号）和主人开放的其他网站。'
        + '群友分享了视频链接、或者让你把某个视频发出来时用；一轮最多一个。返回视频标题、作者和时长，可以顺口评价一句，别把链接写进回复。下载要等一会儿。',
      parameters: {
        url: { type: 'string', required: true, description: '视频链接（原样抄消息里的链接），或者 B 站 BV 号' },
      },
      output: media('video'),
      timeoutMs: 200_000,
      async execute({ url }) {
        return gatewayApi(config.videoApi, 'fetch', { url })
      },
    })
  }

  if (config.coverApi) {
    register({
      name: 'sing_cover',
      label: '翻唱',
      kind: 'voice',
      description: '用你的嗓音翻唱一首歌，作为语音发出去：自动找歌、去掉原唱、换成你的声音，再配上伴奏。'
        + '被要求唱歌、点歌让你唱时用；一轮最多一首。默认唱副歌那一段（约一分钟），要等一两分钟。'
        + '返回歌名、原唱和唱的是哪一段，可以顺口说一句，别把链接写进回复。',
      parameters: {
        song: { type: 'string', required: true, description: '歌名，最好带上原唱歌手，例如"晴天 周杰伦"；也可以是 B 站链接或 BV 号' },
        part: { type: 'string', description: '唱哪一段：副歌（默认）/ 开头 / 从某个时间开始，例如 1:20' },
      },
      output: media('audio'),
      // 要在 QQ 被动回复的 5 分钟窗口内发出去
      timeoutMs: 270_000,
      async execute({ song, part }) {
        return gatewayApi(config.coverApi, 'sing', { song, part })
      },
    })
  }

  if (ttsReady(config.tts)) {
    register({
      name: 'speak',
      label: '发语音',
      kind: 'voice',
      description: '用你的声音说一句话，以语音消息发出。适合撒娇、挑衅、问候、对方要求听声音时；内容 30 字以内，不要每轮都用。',
      parameters: {
        text: { type: 'string', required: true, description: '要说的话（纯口语，不带表情符号和动作描写）' },
        tone: { type: 'string', description: '语气，一句话描述，例如"拖长音、欠揍地说""小声撒娇""不耐烦地嘟囔"' },
      },
      output: media('audio'),
      timeoutMs: 60_000,
      async execute({ text, tone }, exec) {
        requireEnabled('voice', '发语音')
        const src = await synthesizeVolc(config.tts, config.outboxDir, text, tone, exec.signal)
        // 火山按合成的字符数计费（括号里的动作描写会被去掉，按去掉后的字数算）
        const chars = text.replace(/[（(][^）)]{0,20}[）)]/g, '').trim().length
        return { note: '已附上语音', src, charge: { item: 'tts', chars } }
      },
    })
  }

  }

  // 启动时就生成工具清单，不用等第一条消息
  if (config.toolsManifestPath) {
    const manifest = []
    defineTools('(manifest)', tool => manifest.push({
      name: tool.name, label: tool.label ?? tool.name, kind: tool.kind ?? 'other', description: tool.description, parameters: tool.parameters,
      returns: tool.returns ?? RETURNS.get(tool.output) ?? '一段文字',
      output: tool.output?.schema,
      timeoutMs: tool.timeoutMs,
    }))
    writeFileSync(config.toolsManifestPath, JSON.stringify(manifest, null, 2))
  }

  ctx.on('agent/created', ({ agent }) => {
    const scope = agent.ctx
    const sessionId = String(agent.session.id)
    const scene = sessionId.startsWith('qq:group:') ? 'group' : 'private'

    // 只开放本插件注册的工具，屏蔽 shell / 文件等内置工具
    scope.effect(() => scope.tools.restrict({ allow: [] }))

    scope.systemPrompt.section({
      name: 'shark:persona',
      order: scope.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: () => {
        const p = persona()
        return [p.common, p[scene], PLATFORM_RULES].filter(Boolean).join('\n\n')
      },
    })

    defineTools(sessionId, (tool) => {
      const { label, kind, returns, ...spec } = tool
      // 看板「仅限主人」里勾选的工具：别人触发时在这里直接拒绝，不靠模型自觉（实时读设置）
      const execute = spec.execute
      const guarded = {
        ...spec,
        async execute(args, exec) {
          const { ownerOnlyTools = [], ownerId } = settings.get()
          if (ownerOnlyTools.includes(spec.name) && store.turn(sessionId)?.userId !== ownerId) {
            throw new Error('这个功能只有主人能用，这次不能帮对方用，用你自己知道的回答或者婉拒')
          }
          return execute.call(this, args, exec)
        },
      }
      scope.effect(() => scope.tools.register(defineTool(guarded)))
    })
  })
}

/** 单独调用一次视觉模型看图（关闭思考，省 token）。 */
async function describeImage(vision, file, question, signal) {
  const data = readFileSync(file)
  const ext = file.split('.').pop().toLowerCase()
  const mediaType = { png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[ext] ?? 'image/jpeg'
  const baseURL = vision.baseURL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic'
  const res = await fetch(`${baseURL.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    signal,
    headers: {
      'x-api-key': process.env.DEEPSEEK_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: vision.model,
      max_tokens: 400,
      thinking: { type: 'disabled' },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } },
          { type: 'text', text: `${question}
请用中文简洁回答，如实描述，不确定的地方直说。` },
        ],
      }],
    }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`看图失败：${res.status} ${body.error?.message ?? ''}`)
  const answer = body.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
  const u = body.usage ?? {}
  const charge = { item: 'vision', model: vision.model, miss: u.input_tokens ?? 0, hit: u.cache_read_input_tokens ?? 0, out: u.output_tokens ?? 0 }
  return { answer: answer || '（没看出什么）', charge }
}

/** 语音是否配好：要有音色和凭证（环境变量） */
function ttsReady(tts) {
  return Boolean(tts?.speaker && process.env.VOLC_TTS_APP_ID && process.env.VOLC_TTS_ACCESS_TOKEN)
}

/** 音色 ID 决定资源 ID：S_ 开头是复刻音色，含 _uranus_ 或 saturn_ 开头是 2.0 官方音色，其余按 1.0 */
function volcResourceId(tts) {
  if (tts.speaker.startsWith('S_')) return 'seed-icl-2.0'
  if (tts.speaker.includes('_uranus_') || tts.speaker.startsWith('saturn_')) return 'seed-tts-2.0'
  return 'seed-tts-1.0'
}

/** 16-bit 单声道 PCM 加上 WAV 头 */
function pcmToWav(pcm, sampleRate) {
  const head = Buffer.alloc(44)
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8); head.write('fmt ', 12)
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(sampleRate, 24)
  head.writeUInt32LE(sampleRate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([head, pcm])
}

/**
 * 火山引擎 豆包语音合成（V3 HTTP 单向流式）。
 * 响应是一行一个 JSON：{"code":0,"data":"<base64 音频片段>"} …… 最后 {"code":20000000} 表示结束。
 * 要 PCM 再自己加 WAV 头：分段的 wav 直接拼会带多个文件头；24kHz wav 网关可以直接转成 QQ 语音。
 */
/**
 * 文生图服务商。按模型名选：doubao-seedream-* 走火山方舟（ARK_API_KEY），其余走智谱开放平台（ZHIPU_API_KEY）。
 * 两家都返回会过期的图片链接（方舟 24 小时、智谱 30 天），这里统一下载到本地再发 QQ。
 */
const isArk = model => model.startsWith('doubao-seedream')
const imageProviders = {
  zhipu: {
    key: () => process.env.ZHIPU_API_KEY,
    url: 'https://open.bigmodel.cn/api/paas/v4/images/generations',
    sizes: { square: '1024x1024', portrait: '768x1344', landscape: '1344x768' },
    body: (model, prompt, size) => ({
      model,
      prompt: String(prompt).slice(0, 1000),
      // glm-image 有自己的推荐尺寸，其他模型用常见的三种
      ...(model === 'glm-image' ? {} : { size }),
      watermark_enabled: false,
    }),
  },
  ark: {
    key: () => process.env.ARK_API_KEY,
    url: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
    // 方舟 5.0 支持 1K / 1.5K / 2K 或 宽x高；竖图横图用 3:4 / 4:3
    sizes: { square: '2K', portrait: '1536x2048', landscape: '2048x1536' },
    body: (model, prompt, size, images) => ({
      model,
      prompt: String(prompt).slice(0, 600),
      size,
      response_format: 'url',
      // 默认右下角加"AI 生成"水印
      watermark: false,
      // 图生图：参考图（链接或 data:image/...;base64,...），一张时直接传字符串
      ...(images?.length ? { image: images.length === 1 ? images[0] : images } : {}),
    }),
  },
}
const providerOf = model => imageProviders[isArk(model) ? 'ark' : 'zhipu']

/** 本地图片转成 data URI，直接塞进请求，不用让平台去下载 */
export function imageDataUri(file) {
  const ext = file.split('.').pop().toLowerCase()
  const type = { png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[ext] ?? 'image/jpeg'
  return `data:${type};base64,${readFileSync(file).toString('base64')}`
}

/**
 * 默认参考图：角色包里的路径直接读；http(s) 链接第一次用时下载缓存到 data/cache（有的图床很慢，
 * 交给平台去拉容易超时，所以统一转成 base64 传过去）
 */
export async function referenceDataUri(ref, profileDir, cacheDir, signal) {
  if (!/^https?:\/\//.test(ref)) return imageDataUri(join(profileDir, ref))
  const ext = (ref.split('?')[0].split('.').pop() || 'png').toLowerCase().slice(0, 4)
  const file = join(cacheDir, `ref-${createHash('md5').update(ref).digest('hex')}.${ext}`)
  if (!existsSync(file)) {
    const res = await fetch(ref, { signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]) })
    if (!res.ok) throw new Error(`下载参考图失败：${res.status}`)
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  }
  return imageDataUri(file)
}

export function imageProviderReady(model) {
  return Boolean(providerOf(model).key())
}

/** 生成一张图，返回下载到本地的路径；images = 图生图的参考图（只有方舟 Seedream 支持） */
export async function generateImage(model, prompt, shape, outboxDir, signal, images) {
  const p = providerOf(model)
  if (images?.length && !isArk(model)) throw new Error('图生图只有 Seedream 支持')
  const request = size => fetch(p.url, {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${p.key()}`, 'content-type': 'application/json' },
    body: JSON.stringify(p.body(model, prompt, size, images)),
  })
  const size = p.sizes[shape] ?? p.sizes.square
  let res = await request(size)
  // 竖图横图的尺寸万一不被这个模型接受，退回方图再试一次
  if (res.status === 400 && size !== p.sizes.square) res = await request(p.sizes.square)
  const body = await res.json().catch(() => ({}))
  // 内容不合规时平台直接返回错误，把原因告诉模型，让她换个说法或者婉拒
  if (!res.ok) throw new Error(`画图失败：${body.error?.message ?? res.status}`)
  const url = body.data?.[0]?.url
  if (!url) throw new Error('画图失败：平台没有返回图片')
  const img = await fetch(url, { signal })
  if (!img.ok) throw new Error(`下载生成的图片失败：${img.status}`)
  const ext = (img.headers.get('content-type') ?? '').includes('png') ? 'png' : 'jpg'
  const file = join(outboxDir, `${randomUUID()}.${ext}`)
  writeFileSync(file, Buffer.from(await img.arrayBuffer()))
  return file
}

export async function synthesizeVolc(tts, outboxDir, text, tone, signal) {
  const SAMPLE_RATE = 24000
  // 括号里的动作描写（伸懒腰）不念出来
  text = text.replace(/[（(][^）)]{0,20}[）)]/g, '').trim()
  const additions = tone || tts.defaultTone ? JSON.stringify({ context_texts: [tone || tts.defaultTone] }) : undefined
  const res = await fetch('https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-App-Id': process.env.VOLC_TTS_APP_ID,
      'X-Api-Access-Key': process.env.VOLC_TTS_ACCESS_TOKEN,
      'X-Api-Resource-Id': volcResourceId(tts),
      'X-Api-Request-Id': randomUUID(),
    },
    body: JSON.stringify({
      user: { uid: 'shark-bot' },
      req_params: {
        text,
        speaker: tts.speaker,
        audio_params: { format: 'pcm', sample_rate: SAMPLE_RATE },
        ...(additions ? { additions } : {}),
      },
    }),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`火山语音合成失败：HTTP ${res.status} ${body.slice(0, 300)}`)
  const chunks = []
  for (const line of body.split('\n')) {
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.code === 0 && msg.data) chunks.push(Buffer.from(msg.data, 'base64'))
    else if (msg.code === 20000000) break
    else if (msg.code !== 0) throw new Error(`火山语音合成失败：${msg.code} ${msg.message ?? ''}`)
  }
  if (!chunks.length) throw new Error('火山语音合成没有返回音频')
  const file = join(outboxDir, `${randomUUID()}.wav`)
  writeFileSync(file, pcmToWav(Buffer.concat(chunks), SAMPLE_RATE))
  return file
}

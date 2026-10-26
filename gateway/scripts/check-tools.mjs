// 静态检查：加载插件、收集每个工具，按 dsh 的规则检查输出 schema（不调模型、不发消息、不连 QQ）
// 用法：npm run check（在 gateway 目录）
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')
const tools = await import(pathToFileURL(resolve(root, 'gateway/node_modules/@deepseek-ai/dsh-tools/lib/index.js')).href)
const plugin = await import(pathToFileURL(resolve(root, 'gateway/dsh-plugin/index.mjs')).href)

const specs = []
const noop = () => {}
const ctx = {
  effect: noop,
  on: (event, handler) => {
    if (event !== 'agent/created') return
    // 假的 agent：只收集注册的工具定义
    handler({ agent: {
      ctx: {
        effect: fn => fn(),
        tools: { restrict: noop, register: t => specs.push(t) },
        systemPrompt: { section: noop, getSectionOrder: () => 0 },
      },
      session: { id: 'qq:group:schema-check' },
    } })
  },
  deepseekLlmApiExtensions: { register: noop },
}
const config = {
  storePath: resolve(root, 'data/store.db'), settingsPath: resolve(root, 'data/settings.json'),
  personaPath: resolve(root, 'profiles/example/persona/default.yaml'),
  stickerDir: resolve(root, 'profiles/example/assets/stickers'), archiveDir: resolve(root, 'profiles/example/assets/archive'), videoApi: 'http://127.0.0.1:1/internal/video', configApi: 'http://127.0.0.1:1/internal/config', jobsApi: 'http://127.0.0.1:1/internal/jobs',
  outboxDir: resolve(root, 'data/outbox'), tts: { speaker: 'x' },
}
process.env.VOLC_TTS_APP_ID ||= 'x'
process.env.VOLC_TTS_ACCESS_TOKEN ||= 'x'
// 有 key 才注册的工具也要检查到
process.env.ZHIPU_API_KEY ||= 'x'
process.env.ARK_API_KEY ||= 'x'
plugin.apply(ctx, config)

// dsh 运行时（dsh-cordis-host-runner）的规则：每个 object 类型都必须明确写 additionalProperties: true / false
function strictObjects(schema, path = 'output') {
  if (!schema || typeof schema !== 'object') return
  if (schema.type === 'object' && typeof schema.additionalProperties !== 'boolean') {
    throw new Error(`${path}.additionalProperties must be explicitly true or false`)
  }
  for (const [k, v] of Object.entries(schema.properties ?? {})) strictObjects(v, `${path}.properties.${k}`)
  if (schema.items) strictObjects(schema.items, `${path}.items`)
}
if (process.argv.includes('--self-test')) {
  try { strictObjects({ type: 'object', additionalProperties: false, properties: { charge: { type: 'object' } } }); console.log('自检失败：旧写法没被拦下'); process.exit(1) } catch { console.log('自检通过：旧写法会被拦下') }
}

let bad = 0
for (const t of specs) {
  try {
    // register 收到的已经是 defineTool 的结果（参数在插件加载时就校验过了），这里查输出 schema
    const schema = t.output?.schema ?? t.outputSchema ?? t.output?.jsonSchema
    if (!schema) throw new Error('找不到输出 schema，字段：' + Object.keys(t).join(','))
    tools.assertSupportedJsonSchema(schema)
    strictObjects(schema)
    console.log('ok  ', t.name)
  } catch (e) {
    bad++
    console.log('FAIL', t.name, e.message)
  }
}
console.log(`${specs.length} 个工具，${bad} 个有问题`)
process.exit(bad ? 1 : 0)

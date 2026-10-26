import '../src/hide-windows.js'
// 语音自检：用 config.yaml 里的音色合成一句话 → 转成 QQ 语音（silk），确认凭证和音色都没问题。
// 用法：npm run tts-test            （默认台词）
//      npm run tts-test -- "你好呀" "小声撒娇"
//      npm run tts-test -- "你好呀" "小声撒娇" zh_female_xxx_uranus_bigtts   （临时换个音色试听，不改配置）
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { Context } from 'koishi'
import * as silkModule from 'koishi-plugin-silk'
import { ConfigStore, ROOT } from '../src/config.js'

async function main() {
  const { config } = new ConfigStore()
  const [text = '你好呀，这是一句语音测试', tone, speaker] = process.argv.slice(2)
  const tts = { ...config.agent.tts, ...(speaker ? { speaker } : {}) }
  const missing = [
    !process.env.VOLC_TTS_APP_ID && '.env 里的 VOLC_TTS_APP_ID',
    !process.env.VOLC_TTS_ACCESS_TOKEN && '.env 里的 VOLC_TTS_ACCESS_TOKEN',
    !tts?.speaker && 'config.yaml 里的 agent.tts.speaker（音色 ID）',
  ].filter(Boolean)
  if (missing.length) {
    console.error('还没配好：\n  - ' + missing.join('\n  - '))
    process.exit(1)
  }

  const { synthesizeVolc } = await import('../dsh-plugin/index.mjs' as string)
  const outbox = resolve(ROOT, 'data/outbox')
  mkdirSync(outbox, { recursive: true })
  const t = Date.now()
  const file: string = await synthesizeVolc(tts, outbox, text, tone, AbortSignal.timeout(30_000))
  console.log(`合成成功（${Date.now() - t} ms）：${file}`)

  const silkPlugin: any = (silkModule as any).default?.default ?? (silkModule as any).default ?? silkModule
  const app = new Context()
  app.plugin(silkPlugin)
  await app.start()
  const silk = (app as any).silk
  const r = await silk.encode(readFileSync(file), 0)
  console.log(`转 QQ 语音成功：${r.data.byteLength} 字节，时长 ${(r.duration / 1000).toFixed(1)} 秒`)
  console.log('可以双击上面的 wav 文件试听；满意的话重启 dsh 就能在 QQ 里用了。')
  process.exit(0)
}

main().catch((e) => {
  console.error('失败：', e.message)
  process.exit(1)
})

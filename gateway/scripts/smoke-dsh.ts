import '../src/hide-windows.js'
// 冒烟测试：只启动 dsh 子进程（不连 QQ），验证补丁和插件能加载；有 API Key 时再跑一轮对话。
import { Context } from 'koishi'
import { resolve } from 'node:path'
import { ConfigStore, ROOT } from '../src/config.js'
import { DshClient } from '../src/bridge/dsh-client.js'
import { MemoryService } from '../src/memory.js'
import { ActivityLog } from '../src/activity.js'
import { openStore } from '../../shared/store.mjs'

async function main() {
  const ctx = new Context()
  const { config } = new ConfigStore()
  const store = openStore(resolve(ROOT, 'data/store.db'))
  const client = new DshClient(ctx, config.agent, store, config.features, new MemoryService(ctx, store, config.agent.model, config.memory), new ActivityLog(ctx, store), () => {})
  await ctx.start()
  await (client as any).harness.start()
  console.log('dsh initialized OK', client.runtime)
  if (process.env.DEEPSEEK_API_KEY) {
    const reply = await client.chat({
      sessionKey: 'qq:user:smoke', scene: 'private', reason: 'direct',
      sender: { id: 'smoke', name: '测试员', isAdmin: true, isOwner: false },
      text: '你好呀，现在几点？', observed: [],
    }, AbortSignal.timeout(60000))
    console.log(reply)
  }
  await (client as any).harness.close()
  process.exit(0)
}

main()

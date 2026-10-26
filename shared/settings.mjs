// dsh 插件读取功能开关用。真正的配置来源是角色包 config.yaml 的 features 段（外加主人 openid，高级功能硬拦截用），
// 网关在启动和配置变化时把它写到 data/settings.json；这里按修改时间缓存读取，每次调用开销很小。
import { existsSync, readFileSync, statSync } from 'node:fs'

const DEFAULTS = {
  stickers: true,
  stickerEvery: 15,
  lookImage: true,
  webSearch: true,
  ownerOnlyTools: ['web_search', 'web_fetch', 'generate_image', 'edit_image'],
  voice: true,
  ownerId: '',
}

export function createSettings(path) {
  let mtime = -1
  let cached = { ...DEFAULTS }
  return {
    get() {
      try {
        const current = existsSync(path) ? statSync(path).mtimeMs : 0
        if (current !== mtime) {
          cached = { ...DEFAULTS, ...(current ? JSON.parse(readFileSync(path, 'utf8')) : {}) }
          mtime = current
        }
      } catch (e) {
        process.stderr.write(`[settings] 读取 ${path} 失败：${e.message}\n`)
      }
      return cached
    },
  }
}

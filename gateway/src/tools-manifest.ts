import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROOT } from './config.js'
import { registerOptionSource } from './config-options.js'

/**
 * dsh 插件启动时写出的工具清单（名称、中文名、看板分类、说明、参数）。
 * 看板、消息头、费用图表都从这里读工具信息，增删工具只改插件，不用改网关。
 */
export const TOOLS_MANIFEST = resolve(ROOT, 'data/tools.json')

export interface ToolInfo {
  name: string
  label: string
  /** 看板图表分类：memory_read / memory_write / vision / web / sticker / voice / other */
  kind: string
  description: string
  parameters: Record<string, unknown>
  /** 模型收到的返回值是什么样（看板工具页用） */
  returns?: string
  /** 工具内部返回值的 schema（不发给模型） */
  output?: unknown
  timeoutMs?: number
}

let cache: { mtime: number, tools: ToolInfo[] } = { mtime: -1, tools: [] }

export function listTools(): ToolInfo[] {
  try {
    const mtime = existsSync(TOOLS_MANIFEST) ? statSync(TOOLS_MANIFEST).mtimeMs : 0
    if (mtime !== cache.mtime) cache = { mtime, tools: mtime ? JSON.parse(readFileSync(TOOLS_MANIFEST, 'utf8')) : [] }
  } catch {}
  return cache.tools
}

export const toolLabel = (name: string) => listTools().find(t => t.name === name)?.label ?? name
export const toolKind = (name: string) => listTools().find(t => t.name === name)?.kind ?? 'other'

// 看板里「从工具里选」的字段（例如仅限主人的功能）
registerOptionSource('tools', () => listTools().map(t => ({ value: t.name, label: t.label, desc: t.description.split(/[。（]/)[0] })))

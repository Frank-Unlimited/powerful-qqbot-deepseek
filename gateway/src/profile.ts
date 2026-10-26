import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/** 项目根目录（gateway 的上一级） */
export const ROOT = resolve(__dirname, '../..')

/**
 * 角色包：一个机器人"是谁"的全部内容都在 profiles/<名字>/ 里，框架代码不含任何具体角色。
 *   config.yaml   配置（QQ、模型、额度、提示词……）
 *   persona/      人格文件
 *   assets/       表情包、立绘等图片；配置里写的图片路径都相对角色包目录
 * 用哪个角色包由环境变量 SHARK_PROFILE 决定（写在 .env），默认 example。
 */
export const PROFILE = process.env.SHARK_PROFILE || 'example'
export const PROFILE_DIR = resolve(ROOT, 'profiles', PROFILE)

if (!existsSync(resolve(PROFILE_DIR, 'config.yaml'))) {
  throw new Error(`找不到角色包配置 ${resolve(PROFILE_DIR, 'config.yaml')}：检查 .env 里的 SHARK_PROFILE，或从 profiles/example 复制一份`)
}

/** 角色包内的路径 */
export const profilePath = (...parts: string[]) => resolve(PROFILE_DIR, ...parts)

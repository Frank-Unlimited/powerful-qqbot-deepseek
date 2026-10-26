import { Context, Session } from 'koishi'
import type { Config, CustomCommand } from '../config.js'

/** 看板「命令」页展示的一条命令 */
export interface CommandInfo {
  name: string
  /** 参数写法，例如 "[hours:number]"，展示用 */
  args?: string
  aliases: string[]
  description: string
  permission: 'all' | 'admin'
  scene: 'any' | 'group' | 'private'
  source: 'builtin' | 'custom'
}

const builtins: CommandInfo[] = []

export interface CommandDeps {
  config: Config
  /** 立即执行一个定时任务（早安、日记、寒暄） */
  /** 返回 false = 这里没有这个任务 / 机器人不在线 */
  runTask(taskId: string, session: Session): boolean
  /** 把一段提示交给她，像被 @ 一样回复 */
  runPrompt(session: Session, text: string): void
}

/** 权限和场景检查，返回拒绝理由；通过返回空 */
function guard(info: Pick<CommandInfo, 'permission' | 'scene'>, session: Session, config: Config) {
  if (info.permission === 'admin' && !config.admins.includes(session.userId)) return '只有管理员可以这样做哦'
  if (info.scene === 'group' && session.isDirect) return '这个要在群里用'
  if (info.scene === 'private' && !session.isDirect) return '这个要私聊用'
}

/**
 * 注册内置命令：和 ctx.command 一样，只是顺便把说明、权限、场景记下来给看板展示，并统一做权限检查。
 * 内置命令的逻辑写在代码里，看板上只读；要改说明、别名、权限的话写成自定义命令更合适。
 */
export function builtinCommand(
  ctx: Context, config: Config,
  def: { name: string, args?: string, aliases?: string[], description: string, permission?: 'all' | 'admin', scene?: 'any' | 'group' | 'private' },
  action: (session: Session, ...args: any[]) => any,
) {
  const info: CommandInfo = { aliases: [], permission: 'all', scene: 'any', ...def, source: 'builtin' }
  builtins.push(info)
  const cmd = ctx.command(def.args ? `${def.name} ${def.args}` : def.name, def.description)
  for (const alias of info.aliases) cmd.alias(alias)
  cmd.action(({ session }, ...args) => {
    if (!session) return
    return guard(info, session, config) ?? action(session, ...args)
  })
}

/**
 * 自定义命令：在角色包 config.yaml 的 commands 里（看板「命令」页增删改），三种动作：
 * - task：立即执行一个定时任务（按任务 id，例如早安 greeting / 日记 diary），或者冷场寒暄 idle
 * - prompt：把一段提示交给她回复，{args} = 命令后面跟的内容
 * - reply：直接回一段固定文字，不调模型，{args} 同上
 * 配置一改就重新注册，不用重启。
 */
export function customCommands(ctx: Context, deps: CommandDeps, onConfigChange: (fn: () => void) => void) {
  const logger = ctx.logger('commands')
  let registered: { dispose(): void }[] = []
  let last = ''

  function register() {
    const json = JSON.stringify(deps.config.commands)
    if (json === last) return
    last = json
    for (const cmd of registered) cmd.dispose()
    registered = []
    const taken = new Set(builtins.flatMap(b => [b.name, ...b.aliases]))
    for (const def of deps.config.commands) {
      const names = [def.name, ...def.aliases]
      const clash = names.find(n => taken.has(n))
      if (clash) {
        logger.warn('自定义命令 /%s 和已有命令 /%s 重名，跳过', def.name, clash)
        continue
      }
      names.forEach(n => taken.add(n))
      // [args:text] 收下命令后面的全部内容
      const cmd = ctx.command(`${def.name} [args:text]`, def.description)
      for (const alias of def.aliases) cmd.alias(alias)
      cmd.action(({ session }, args = '') => {
        if (!session) return
        const denied = guard(def, session, deps.config)
        if (denied) return denied
        return run(def, session, String(args).trim())
      })
      registered.push(cmd)
    }
    logger.info('已注册 %d 条自定义命令', registered.length)
  }

  function run(def: CustomCommand, session: Session, args: string) {
    const fill = (text: string) => text.replaceAll('{args}', args)
    if (def.action === 'reply') return fill(def.reply)
    if (def.action === 'prompt') return void deps.runPrompt(session, fill(def.prompt))
    if (!deps.runTask(def.task, session)) return '这里没有这个定时任务（在看板「定时任务」页看看），或者机器人不在线'
  }

  register()
  onConfigChange(register)
}

/** 看板用：内置 + 自定义的全部命令 */
export function listCommands(config: Config): CommandInfo[] {
  return [
    ...builtins,
    ...config.commands.map(c => ({ name: c.name, args: '[内容]', aliases: c.aliases, description: c.description, permission: c.permission, scene: c.scene, source: 'custom' as const })),
  ]
}

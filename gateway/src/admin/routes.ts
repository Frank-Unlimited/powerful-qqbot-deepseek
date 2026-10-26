/**
 * dsh 插件调用的 config / schedule 工具接口。身份一律由网关按"当前这一轮"决定（插件只传会话 id）。
 */
import type { Context } from 'koishi'
import type { AgentClient } from '../bridge/types.js'
import type { Target } from '../bridge/scheduler.js'
import type { JobStore } from '../bridge/jobs.js'
import type { ConfigAdmin } from './config-tool.js'

export function adminRoutes(ctx: Context, agent: AgentClient, admin: ConfigAdmin, jobs: JobStore) {
  const logger = ctx.logger('jobs')
  const route = (path: string, handler: (body: any) => unknown) => {
    ctx.server.post(path, async (koa: any) => {
      try {
        koa.body = { ok: true, result: await handler(koa.request.body ?? {}) }
      } catch (e) {
        koa.body = { ok: false, error: (e as Error).message }
      }
    })
  }

  route('/internal/config/list', ({ sessionId, keyword }) => admin.list(sessionId, String(keyword ?? '')))
  route('/internal/config/propose', ({ sessionId, path, value }) => admin.propose(sessionId, String(path ?? '').trim(), value))
  route('/internal/config/confirm', ({ sessionId, token }) => admin.confirm(sessionId, token))
  route('/internal/config/cancel', ({ sessionId, token }) => admin.cancel(sessionId, token))

  /** 当前这一轮的会话和发言人 */
  const turnOf = (sessionId: string) => {
    const turn = agent.currentTurn(sessionId)
    if (!turn) throw new Error('无法确定当前会话')
    const [, scene, id] = turn.sessionKey.split(':')
    const target: Target = { key: turn.sessionKey, scene: scene === 'group' ? 'group' : 'private', id }
    return { turn, target }
  }

  route('/internal/jobs/add', ({ sessionId, name, kind, when, message }) => {
    const { turn, target } = turnOf(sessionId)
    if (turn.reason === 'schedule') throw new Error('定时任务里不能再设定时任务')
    const job = jobs.add(target, turn.senderId, { name, kind, when, message })
    logger.info('%s 新建定时任务 %s', target.key, jobs.describe(job))
    return `已设好：${jobs.describe(job)}`
  })
  route('/internal/jobs/list', ({ sessionId }) => {
    const { turn, target } = turnOf(sessionId)
    const list = jobs.list(target, turn.senderId)
    // 主人在私聊里看的是所有会话的任务，要标出在哪
    const everywhere = target.scene === 'private' && jobs.isSuper(turn.senderId)
    return list.length ? list.map(j => jobs.describe(j, everywhere)).join('\n') : '这里还没有定时任务'
  })
  route('/internal/jobs/update', ({ sessionId, id, name, kind, when, message, enabled }) => {
    const { turn, target } = turnOf(sessionId)
    if (turn.reason === 'schedule') throw new Error('定时任务里不能改定时任务')
    const job = jobs.update(id, turn.senderId, target, { name, kind, when, message, enabled })
    logger.info('%s 修改定时任务 %s', target.key, jobs.describe(job, true))
    return `已改好：${jobs.describe(job, true)}`
  })
  route('/internal/jobs/remove', ({ sessionId, id }) => {
    const { turn, target } = turnOf(sessionId)
    const job = jobs.remove(id, turn.senderId, target)
    logger.info('%s 删除定时任务 #%s', target.key, job.id)
    return `已删除 #${job.id}「${job.name}」`
  })
}

import type { Config } from '../config.js'
import type { Store } from '../../../shared/store.mjs'
import { knownGroups, parseTime, type BeijingNow, type ScheduledTask } from './scheduler.js'

/** "HH:MM-HH:MM"，结束早于开始表示跨午夜；格式不对当成全天 */
function inHours(range: string, minutes: number) {
  const [a, b] = range.split('-').map(t => parseTime(t.trim()))
  // 开始等于结束（比如 00:00-00:00）= 全天
  if (a === null || b === null || a === undefined || b === undefined || a === b) return true
  return a <= b ? minutes >= a && minutes < b : minutes >= a || minutes < b
}

/**
 * 冷场寒暄：群里有一段时间没人说话（不算她自己），她主动出来冒个泡；之后还是没人说话，就每隔同样的时长再出来一次，
 * 最多连续 maxInRow 次（0 = 不限），到了上限就等有人说话再重新开始。
 * 只在活跃时段里做；主动消息发不出去就算了（过了时机再补没意义）。
 * 提示词在角色包 config.yaml 的 idle.prompt；{silence} = 安静了多久（"10 秒" / "62 分钟"），{minutes} = 分钟数，{time} = 当前日期星期时间。
 */
export function idleTask(config: Config, store: Store): ScheduledTask {
  const c = () => config.idle
  return {
    id: 'idle',
    label: '寒暄',
    fallback: false,
    split: true,
    settings: () => ({ enabled: c().enabled }),
    targets: () => (c().groups.length ? c().groups : knownGroups(store)).map(id => ({ key: `qq:group:${id}`, scene: 'group', id })),
    due(target, now, runs) {
      if (!inHours(c().activeHours, now.minutes)) return false
      const lastHuman = store.lastHumanMessageTime(target.id)
      if (!lastHuman) return false
      // 0 分钟当成 10 秒，调试用
      const wait = c().minutes > 0 ? c().minutes * 60_000 : 10_000
      // 从最后一条别人的话、或者她上次寒暄（取较晚的）开始算安静了多久
      const since = Math.max(lastHuman, runs.at(-1) ?? 0)
      if (Date.now() - since < wait) return false
      // 没人理她时最多连续寒暄几次（只数寒暄，不数她回别人的话）
      const max = c().maxInRow
      return !max || runs.filter(t => t > lastHuman).length < max
    },
    prompt(target, now: BeijingNow) {
      const lastHuman = store.lastHumanMessageTime(target.id) ?? Date.now()
      const hh = String(Math.floor(now.minutes / 60)).padStart(2, '0'), mm = String(now.minutes % 60).padStart(2, '0')
      // 不到一分钟写秒数（调试用的 10 秒），否则写分钟；写成"0 分钟"她会以为根本没冷场
      const secs = Math.round((Date.now() - lastHuman) / 1000)
      const silence = secs < 60 ? `${secs} 秒` : `${Math.round(secs / 60)} 分钟`
      return c().prompt
        .replaceAll('{silence}', silence)
        .replaceAll('{minutes}', String(Math.round(secs / 60)))
        .replaceAll('{time}', `${now.date}，${now.weekdayLabel}，${hh}:${mm}`)
    },
  }
}

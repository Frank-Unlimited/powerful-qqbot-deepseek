// 群聊情况统计：给 dsh 的 group_stats 工具用，输出给模型读的纯文本。
// 数据来自 store.group_messages；她自己的发言记为 user_id = self，只单独计数，不进排行。

const HOUR = 3600_000
const DAY = 24 * HOUR
const TZ = 8 * HOUR
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const SLOTS = [['凌晨', 0, 6], ['上午', 6, 12], ['下午', 12, 18], ['晚上', 18, 24]]

/** 北京时间的周期起止：day = 自然日，week = 周一 0 点起的自然周；offset 0 = 本期，1 = 上一期 */
export function periodRange(period, offset = 0, now = Date.now()) {
  const local = now + TZ
  const dayStart = local - (local % DAY) - TZ
  if (period === 'week') {
    const weekday = (new Date(local).getUTCDay() + 6) % 7 // 周一 = 0
    const since = dayStart - weekday * DAY - offset * 7 * DAY
    return { since, until: since + 7 * DAY }
  }
  const since = dayStart - offset * DAY
  return { since, until: since + DAY }
}

const fmtDate = t => {
  const d = new Date(t + TZ)
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日（周${WEEKDAYS[d.getUTCDay()]}）`
}
const hourOf = t => new Date(t + TZ).getUTCHours()
const pct = (n, total) => total ? `${Math.round(n / total * 100)}%` : '0%'

function summarize(rows) {
  const people = rows.filter(r => r.user_id !== 'self')
  const byUser = new Map()
  for (const r of people) {
    const u = byUser.get(r.user_id) ?? { name: r.name, count: 0, images: 0, last: 0 }
    u.count++
    if (r.name) u.name = r.name
    if (r.text.includes('[图片]')) u.images++
    u.last = r.time
    byUser.set(r.user_id, u)
  }
  return { people, byUser, self: rows.length - people.length }
}

/** 返回 { text, chart }：text 给模型读，chart 是画条形图用的数据（没有消息时为 null） */
export function groupStats(store, groupId, { period = 'day', offset = 0 } = {}, now = Date.now()) {
  const { since, until } = periodRange(period, offset, now)
  const end = Math.min(until, now)
  const rows = store.groupMessagesBetween(groupId, since, end)
  const label = period === 'week' ? `${fmtDate(since)} ~ ${fmtDate(until - DAY)}` : fmtDate(since)
  const first = store.groupFirstSeen(groupId)
  const lines = [`【${period === 'week' ? '周' : '日'}统计】${label}${until > now ? '（进行中）' : ''}`]
  if (first.since >= end) return { text: lines.concat('这段时间还没有聊天记录（群消息从开启全量消息后才开始记录）').join('\n'), chart: null }
  if (first.since > since) lines.push(`注意：群消息从 ${fmtDate(first.since)} ${new Date(first.since + TZ).toISOString().slice(11, 16)} 才开始记录，更早的没有数据`)

  const { people, byUser, self } = summarize(rows)
  const images = people.filter(r => r.text.includes('[图片]')).length
  lines.push(`总消息 ${people.length} 条（图片 ${images}），发言 ${byUser.size} 人；你自己说了 ${self} 条`)

  // 和上一期对比
  const prev = periodRange(period, offset + 1, now)
  if (first.since < prev.until) {
    const prevCount = store.groupMessagesBetween(groupId, prev.since, prev.since + (end - since)).filter(r => r.user_id !== 'self').length
    const diff = people.length - prevCount
    lines.push(`比上${period === 'week' ? '周' : '一天'}同期${diff >= 0 ? '多' : '少'} ${Math.abs(diff)} 条（上期同期 ${prevCount} 条）`)
  }

  if (!people.length) return { text: lines.join('\n'), chart: null }

  // 前五名
  const ranked = [...byUser.values()].sort((a, b) => b.count - a.count)
  lines.push('', '发言前五：')
  ranked.slice(0, 5).forEach((u, i) => {
    lines.push(`${i + 1}. ${u.name || '某人'} ${u.count} 条（${pct(u.count, people.length)}${u.images ? `，图片 ${u.images}` : ''}）`)
  })

  // 各时段
  const hours = Array(24).fill(0)
  for (const r of people) hours[hourOf(r.time)]++
  const peak = hours.indexOf(Math.max(...hours))
  lines.push('', '各时段：' + SLOTS.map(([name, a, b]) => `${name} ${hours.slice(a, b).reduce((x, y) => x + y, 0)}`).join('，'))
  lines.push(`最热闹的一小时：${peak}:00-${peak + 1}:00（${hours[peak]} 条）`)
  if (period === 'day') {
    lines.push('逐小时：' + hours.map((n, h) => n ? `${h}点 ${n}` : '').filter(Boolean).join('，'))
  }
  const days = Array(7).fill(0)
  if (period === 'week') {
    for (const r of people) days[Math.floor((r.time - since) / DAY)]++
    lines.push('逐日：' + days.map((n, i) => since + i * DAY < now ? `周${WEEKDAYS[(i + 1) % 7]} ${n}` : '').filter(Boolean).join('，'))
  }

  // 新面孔：这一期里第一次被记录到发言的人（记录开始那一期不算，否则人人都是新面孔）
  if (first.since < since) {
    const fresh = [...byUser.entries()].filter(([id]) => (first.users.get(id) ?? 0) >= since).map(([, u]) => u.name || '某人')
    if (fresh.length) lines.push('', `新面孔（第一次发言）：${fresh.join('、')}`)
  }

  const chart = {
    title: `群聊${period === 'week' ? '周报' : '日报'}`,
    subtitle: `${label}${until > now ? '（进行中）' : ''}`,
    footer: `共 ${byUser.size} 人 · ${people.length} 条消息`,
    top: ranked.slice(0, 5).map(u => ({ name: u.name || '某人', count: u.count })),
    ...(period === 'week'
      ? { bucketTitle: '每天消息量', tickEvery: 1, buckets: days.map((n, i) => ({ label: `周${WEEKDAYS[(i + 1) % 7]}`, count: n })) }
      : { bucketTitle: '每小时消息量', tickEvery: 6, buckets: hours.map((n, h) => ({ label: `${h}点`, count: n })) }),
  }
  return { text: lines.join('\n'), chart }
}

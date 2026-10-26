// 看板「活动」页：调用时间线、费用、热力图、分类费用、明细。纯 SVG，无第三方库。
// 数据：/api/activity（历史）+ /api/activity/stream（SSE 实时推送新事件）。

const KINDS = [
  { key: 'chat', label: '对话', slot: 1 },
  { key: 'memory_read', label: '记忆读', slot: 2 },
  { key: 'memory_write', label: '记忆写', slot: 3 },
  { key: 'vision', label: '看图', slot: 4 },
  { key: 'web', label: '联网搜索', slot: 5 },
  { key: 'sticker', label: '表情包', slot: 6 },
  { key: 'image_gen', label: '生图', slot: 7 },
  { key: 'other', label: '其他', slot: 8 },
]
const kindOf = k => KINDS.find(x => x.key === k) ?? KINDS[7]
const color = slot => `var(--series-${slot})`
const RANGES = { 24: { bucket: 30 * 60e3, label: '近 24 小时' }, 168: { bucket: 3 * 3600e3, label: '近 7 天' }, 720: { bucket: 24 * 3600e3, label: '近 30 天' } }
const SVGNS = 'http://www.w3.org/2000/svg'

let events = []
let hours = 24
let hidden = new Set()

const el = (tag, attrs = {}, parent) => {
  const node = document.createElementNS(SVGNS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  parent?.appendChild(node)
  return node
}
const fmtYuan = n => '¥' + (n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(n < 1 ? 3 : 2))
const fmtTime = (t, withDate) => new Date(t).toLocaleString('zh-CN', withDate
  ? { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
  : { hour: '2-digit', minute: '2-digit', hour12: false })
const escHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// ---- tooltip ----
const tip = document.createElement('div')
tip.className = 'viz-tip'
document.body.appendChild(tip)
function showTip(evt, html) {
  tip.innerHTML = html
  tip.style.display = 'block'
  const x = Math.min(evt.clientX + 14, window.innerWidth - tip.offsetWidth - 8)
  const y = Math.min(evt.clientY + 14, window.innerHeight - tip.offsetHeight - 8)
  tip.style.left = x + 'px'
  tip.style.top = y + 'px'
}
const hideTip = () => { tip.style.display = 'none' }

// ---- 分桶 ----
function buckets() {
  const { bucket } = RANGES[hours]
  const end = Math.ceil(Date.now() / bucket) * bucket
  const start = end - hours * 3600e3
  const n = Math.round((end - start) / bucket)
  const list = Array.from({ length: n }, (_, i) => ({ t: start + i * bucket, counts: {}, cost: 0, total: 0 }))
  for (const e of events) {
    const i = Math.floor((e.time - start) / bucket)
    if (i < 0 || i >= n) continue
    const k = kindOf(e.kind).key
    list[i].counts[k] = (list[i].counts[k] ?? 0) + 1
    list[i].cost += e.cost
    list[i].total++
  }
  return list
}

/** 4 格网格的上限：取"好看"的步长（1/2/2.5/5 × 10ⁿ）×4，刻度都是整齐的数 */
function niceMax(v) {
  if (v <= 0) return 4
  const raw = v / 4
  const p = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(m => m * p).find(m => m >= raw)
  return step * 4
}

/** 一个带 y 轴网格的绘图区；返回坐标换算函数 */
function frame(svg, w, h, max, fmt) {
  const m = { l: 44, r: 8, t: 8, b: 22 }
  const ih = h - m.t - m.b
  const y = v => m.t + ih - (v / max) * ih
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i
    el('line', { x1: m.l, x2: w - m.r, y1: y(v), y2: y(v), class: 'viz-grid' }, svg)
    el('text', { x: m.l - 6, y: y(v) + 4, class: 'viz-axis', 'text-anchor': 'end' }, svg).textContent = fmt(v)
  }
  return { m, y, iw: w - m.l - m.r, ih }
}

/** 上端圆角 4px、底部贴基线的柱子路径 */
function barPath(x, yTop, w, yBase, round) {
  const r = Math.min(round ? 4 : 0, w / 2, (yBase - yTop))
  return `M${x},${yBase} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + w - r} Q${x + w},${yTop} ${x + w},${yTop + r} V${yBase} Z`
}

function xLabels(svg, list, f, slotW) {
  const every = Math.ceil(list.length / 8)
  list.forEach((b, i) => {
    if (i % every) return
    el('text', { x: f.m.l + i * slotW + slotW / 2, y: f.m.t + f.ih + 16, class: 'viz-axis', 'text-anchor': 'middle' }, svg)
      .textContent = hours > 168 ? new Date(b.t).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : fmtTime(b.t, hours > 24)
  })
}

// ---- 图 1：调用时间线（按类别堆叠） ----
function drawTimeline(list) {
  const host = document.getElementById('vizTimeline')
  host.innerHTML = ''
  const w = host.clientWidth || 900, h = 220
  const svg = el('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': '各类调用次数随时间变化' }, host)
  const visible = KINDS.filter(k => !hidden.has(k.key))
  const peak = Math.max(...list.map(b => visible.reduce((s, k) => s + (b.counts[k.key] ?? 0), 0)))
  // 次数是整数：上限至少 4，保证每格是整数
  const max = Math.max(4, Math.ceil(niceMax(peak) / 4) * 4)
  const f = frame(svg, w, h, max, v => String(Math.round(v)))
  const slotW = f.iw / list.length
  const bw = Math.max(2, Math.min(18, slotW * 0.7))
  list.forEach((b, i) => {
    const x = f.m.l + i * slotW + (slotW - bw) / 2
    const stack = visible.filter(k => b.counts[k.key])
    let acc = 0
    stack.forEach((k, si) => {
      const v = b.counts[k.key]
      const y0 = f.y(acc), y1 = f.y(acc + v)
      // 段与段之间留 2px 表面色缝隙
      const top = y1 + (si < stack.length - 1 ? 0 : 0)
      el('path', { d: barPath(x, top, bw, y0 - (si > 0 ? 2 : 0), si === stack.length - 1), fill: color(k.slot) }, svg)
      acc += v
    })
    const hit = el('rect', { x: f.m.l + i * slotW, y: f.m.t, width: slotW, height: f.ih, fill: 'transparent' }, svg)
    hit.addEventListener('mousemove', evt => showTip(evt, `<b>${fmtTime(b.t, true)}</b>` + (b.total
      ? KINDS.filter(k => b.counts[k.key]).map(k => `<div><i style="background:${color(k.slot)}"></i>${k.label}　${b.counts[k.key]} 次</div>`).join('')
      : '<div class="muted">无调用</div>')))
    hit.addEventListener('mouseleave', hideTip)
  })
  xLabels(svg, list, f, slotW)
}

// ---- 图 2：每个时间段的费用 ----
function drawCost(list) {
  const host = document.getElementById('vizCost')
  host.innerHTML = ''
  const w = host.clientWidth || 900, h = 160
  const svg = el('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': '各时间段费用' }, host)
  const max = niceMax(Math.max(...list.map(b => b.cost)))
  const f = frame(svg, w, h, max, v => '¥' + (max < 0.1 ? v.toFixed(3) : v.toFixed(2)))
  const slotW = f.iw / list.length
  const bw = Math.max(2, Math.min(18, slotW * 0.7))
  list.forEach((b, i) => {
    const x = f.m.l + i * slotW + (slotW - bw) / 2
    if (b.cost > 0) el('path', { d: barPath(x, Math.min(f.y(b.cost), f.y(0) - 1), bw, f.y(0), true), fill: color(1) }, svg)
    const hit = el('rect', { x: f.m.l + i * slotW, y: f.m.t, width: slotW, height: f.ih, fill: 'transparent' }, svg)
    hit.addEventListener('mousemove', evt => showTip(evt, `<b>${fmtTime(b.t, true)}</b><div>费用 ${fmtYuan(b.cost)}</div><div class="muted">${b.total} 次调用</div>`))
    hit.addEventListener('mouseleave', hideTip)
  })
  xLabels(svg, list, f, slotW)
}

// ---- 图 3：星期 × 小时热力图（近 28 天，标出高峰计费时段） ----
const SEQ = ['--seq-100', '--seq-200', '--seq-300', '--seq-400', '--seq-500', '--seq-600', '--seq-700']
function drawHeatmap(all) {
  const host = document.getElementById('vizHeat')
  host.innerHTML = ''
  const since = Date.now() - 28 * 86400e3
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0))
  for (const e of all) {
    if (e.time < since) continue
    const d = new Date(e.time + 8 * 3600e3) // 北京时间
    grid[(d.getUTCDay() + 6) % 7][d.getUTCHours()]++
  }
  const max = Math.max(1, ...grid.flat())
  const w = host.clientWidth || 900
  const cell = Math.max(10, Math.min(28, (w - 50) / 24))
  const h = cell * 7 + 26
  const svg = el('svg', { width: 50 + cell * 24, height: h, role: 'img', 'aria-label': '近 28 天每周各时段的调用次数' }, host)
  const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
  days.forEach((d, r) => {
    el('text', { x: 40, y: r * cell + cell / 2 + 4, class: 'viz-axis', 'text-anchor': 'end' }, svg).textContent = d
    for (let c = 0; c < 24; c++) {
      const v = grid[r][c]
      const step = v === 0 ? null : SEQ[Math.min(SEQ.length - 1, Math.floor((v / max) * (SEQ.length - 1) + 0.0001))]
      const peak = r < 5 && ((c >= 9 && c < 12) || (c >= 14 && c < 18))
      const rect = el('rect', {
        x: 50 + c * cell + 1, y: r * cell + 1, width: cell - 2, height: cell - 2, rx: 3,
        fill: step ? `var(${step})` : 'var(--seq-empty)',
        class: peak ? 'viz-peak' : '',
      }, svg)
      rect.addEventListener('mousemove', evt => showTip(evt, `<b>${days[r]} ${c}:00–${c + 1}:00</b><div>${v} 次调用（近 28 天合计）</div><div class="muted">${peak ? '高峰计费时段' : '低谷计费时段（半价）'}</div>`))
      rect.addEventListener('mouseleave', hideTip)
    }
  })
  for (let c = 0; c < 24; c += 3) el('text', { x: 50 + c * cell + cell / 2, y: 7 * cell + 16, class: 'viz-axis', 'text-anchor': 'middle' }, svg).textContent = c
}

// ---- 图 4：各类别费用与次数 ----
function drawBreakdown(range) {
  const host = document.getElementById('vizBreak')
  const rows = KINDS.map(k => {
    const list = range.filter(e => kindOf(e.kind).key === k.key)
    return { ...k, count: list.length, cost: list.reduce((s, e) => s + e.cost, 0) }
  }).filter(r => r.count)
  const max = Math.max(...rows.map(r => r.cost), 1e-9)
  host.innerHTML = rows.length ? rows.map(r => `
    <div class="viz-hrow">
      <span class="viz-hlabel"><i style="background:${color(r.slot)}"></i>${r.label}</span>
      <span class="viz-htrack"><span class="viz-hbar" style="width:${Math.max(0.5, (r.cost / max) * 100)}%;background:${color(r.slot)}"></span></span>
      <span class="viz-hval">${r.cost > 0 ? fmtYuan(r.cost) : '—'} · ${r.count} 次</span>
    </div>`).join('') : '<p class="muted">这段时间没有调用</p>'
}

// ---- 统计卡片、图例、明细表 ----
function drawStats(range) {
  const cost = range.reduce((s, e) => s + e.cost, 0)
  const chat = range.filter(e => e.kind === 'chat')
  const miss = chat.reduce((s, e) => s + e.miss, 0), hit = chat.reduce((s, e) => s + e.hit, 0)
  const month = cost * (30 * 24 / hours)
  document.getElementById('vizStats').innerHTML = [
    ['模型调用', `${chat.length} 次`],
    ['工具调用', `${range.filter(e => e.kind !== 'chat' && !e.auto).length} 次`],
    ['费用', fmtYuan(cost)],
    ['缓存命中率', hit + miss ? `${Math.round(hit / (hit + miss) * 100)}%` : '-'],
    ['按此速度每月', fmtYuan(month)],
  ].map(([k, v]) => `<div class="card stat"><span class="muted">${k}</span><b>${v}</b></div>`).join('')
}

function drawLegend() {
  const host = document.getElementById('vizLegend')
  host.innerHTML = KINDS.map(k => `<button class="viz-legend ${hidden.has(k.key) ? 'off' : ''}" data-kind="${k.key}"><i style="background:${color(k.slot)}"></i>${k.label}</button>`).join('')
}

function drawTable(range) {
  const rows = range.slice(-150).reverse()
  document.getElementById('vizTable').innerHTML = '<tr><th>时间</th><th>会话</th><th>类别</th><th>详情</th><th>输入（未命中/命中）</th><th>输出</th><th>费用</th></tr>'
    + rows.map(e => `<tr><td>${fmtTime(e.time, true)}</td><td class="muted">${escHtml((e.session_key ?? '').replace('qq:group:', '群 ').replace('qq:user:', '私聊 ').slice(0, 14))}</td>
      <td><i class="viz-dot" style="background:${color(kindOf(e.kind).slot)}"></i>${kindOf(e.kind).label}${e.auto ? ' <span class="muted">自动</span>' : ''}</td>
      <td class="muted">${escHtml(e.detail ?? '')}</td><td>${e.miss || e.hit ? `${e.miss.toLocaleString()} / ${e.hit.toLocaleString()}` : ''}</td>
      <td>${e.out || ''}</td><td>${e.cost ? fmtYuan(e.cost) : ''}</td></tr>`).join('')
}

function render() {
  const since = Date.now() - hours * 3600e3
  const range = events.filter(e => e.time >= since)
  const list = buckets()
  drawStats(range)
  drawLegend()
  drawTimeline(list)
  drawCost(list)
  drawHeatmap(events)
  drawBreakdown(range)
  drawTable(range)
  document.getElementById('vizUpdated').textContent = '更新于 ' + fmtTime(Date.now(), true)
}

async function load() {
  // 热力图固定看 28 天，所以至少取 28 天的数据
  const res = await fetch('/api/activity?hours=' + Math.max(hours, 24 * 28))
  events = await res.json()
  render()
}

// ---- 实时：SSE 推送新事件；断线自动重连；另每分钟重画一次让时间轴前进 ----
function live() {
  const dot = document.getElementById('vizLive')
  const es = new EventSource('/api/activity/stream')
  let timer
  es.onopen = () => { dot.className = 'viz-live on'; dot.title = '实时连接中' }
  es.onerror = () => { dot.className = 'viz-live'; dot.title = '连接断开，正在重连' }
  es.onmessage = (msg) => {
    events.push(JSON.parse(msg.data))
    clearTimeout(timer)
    timer = setTimeout(() => document.querySelector('#activity.active') && render(), 300)
  }
  setInterval(() => document.querySelector('#activity.active') && render(), 60_000)
}

export function initActivity() {
  document.getElementById('vizRange').onchange = (e) => { hours = Number(e.target.value); load() }
  document.getElementById('vizLegend').onclick = (e) => {
    const k = e.target.closest('[data-kind]')?.dataset.kind
    if (!k) return
    hidden.has(k) ? hidden.delete(k) : hidden.add(k)
    render()
  }
  document.getElementById('vizTableToggle').onclick = () => {
    const t = document.getElementById('vizTableWrap')
    t.style.display = t.style.display === 'none' ? 'block' : 'none'
  }
  window.addEventListener('resize', () => document.querySelector('#activity.active') && render())
  // ?nolive=1：截图 / 调试时不建立实时连接
  if (!new URLSearchParams(location.search).has('nolive')) live()
  return load
}

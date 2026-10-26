// 网关进程和 dsh 进程共用的 SQLite 存储（WAL 模式下两个进程可同时读写）。
// 放记忆、用户画像、会话别名、当前发言人；限额走 Koishi 自己的数据库。
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function openStore(path) {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,          -- user:<openid> | group:<openid>
      content TEXT NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope);
    CREATE TABLE IF NOT EXISTS profiles (
      user_id TEXT PRIMARY KEY,
      name TEXT,                    -- 最近一次看到的昵称
      call_name TEXT,               -- 她对这个人的称呼
      updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      key TEXT PRIMARY KEY,         -- qq:group:<openid> | qq:user:<openid>
      generation INTEGER NOT NULL   -- 重置会话时自增，对应新的 dsh 会话 id
    );
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,    -- 只允许在发图的那个群/私聊里查看
      file TEXT NOT NULL,           -- 本地文件（QQ 图片链接会过期，收到时就下载）
      sender TEXT,                  -- 发图人昵称
      created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS images_session ON images(session_key);
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time INTEGER NOT NULL,
      session_key TEXT,
      kind TEXT NOT NULL,           -- chat / memory_read / memory_write / vision / web / sticker / image_gen / image_send / voice / other
      detail TEXT,                  -- 工具名等
      auto INTEGER NOT NULL DEFAULT 0,  -- 1 = 网关自动触发（如每轮的记忆检索），0 = 模型主动调用
      miss INTEGER NOT NULL DEFAULT 0,  -- 未命中缓存的输入 token
      hit INTEGER NOT NULL DEFAULT 0,   -- 命中缓存的输入 token
      out INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,     -- 元，按发生时刻的峰谷价估算
      source_ref TEXT UNIQUE            -- 回填用的去重键（dsh 事件 id）
    );
    CREATE INDEX IF NOT EXISTS activity_time ON activity(time);
    CREATE TABLE IF NOT EXISTS group_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT,                    -- 发言时的群昵称
      text TEXT NOT NULL,           -- 纯文本，图片为「[图片]」
      time INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS group_messages_group_time ON group_messages(group_id, time);
    -- credits 账本：每一笔真实花费（模型、看图、联网、语音）一行，只增不改
    CREATE TABLE IF NOT EXISTS credit_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time INTEGER NOT NULL,
      day TEXT NOT NULL,            -- 北京时间日期 YYYY-MM-DD，每日上限按它算
      user_id TEXT,                 -- 谁触发的；插话、定时任务等没有发起人时为空
      group_id TEXT,
      session_key TEXT,
      turn TEXT NOT NULL,           -- 同一轮对话的几笔共用一个 id
      item TEXT NOT NULL,           -- chat / vision / search / fetch / tts
      detail TEXT,
      yuan REAL NOT NULL,           -- 人民币费用
      credits REAL NOT NULL,        -- 按当时汇率折算
      bonus REAL NOT NULL DEFAULT 0 -- 其中从充值余额里扣的部分
    );
    CREATE INDEX IF NOT EXISTS credit_ledger_user ON credit_ledger(user_id, day);
    CREATE INDEX IF NOT EXISTS credit_ledger_group ON credit_ledger(group_id, day);
    CREATE INDEX IF NOT EXISTS credit_ledger_day ON credit_ledger(day);
    -- 每个人的额度设置：每日上限（空 = 用配置里的默认值）、充值余额
    CREATE TABLE IF NOT EXISTS credit_accounts (
      user_id TEXT PRIMARY KEY,
      daily_limit REAL,
      balance REAL NOT NULL DEFAULT 0
    );
    -- 充值和上限修改的记录（审计用）
    CREATE TABLE IF NOT EXISTS credit_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,           -- topup = 充值，limit = 改每日上限
      amount REAL,                  -- 充值数额 / 新上限（空 = 恢复默认）
      note TEXT
    );
    -- 表情包使用审计：每发一次记一行（用于排序、找出从没用过的表情）
    CREATE TABLE IF NOT EXISTS sticker_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sticker_id TEXT NOT NULL,
      session_key TEXT,
      user_id TEXT,
      query TEXT,                   -- 她检索时写的描述
      time INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sticker_uses_sticker ON sticker_uses(sticker_id);
    CREATE TABLE IF NOT EXISTS memory_recalls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,      -- mem0 记忆 id
      session_key TEXT,             -- 在哪个会话里被召回
      user_id TEXT,                 -- 当时的发言人
      via TEXT NOT NULL,            -- auto = 每轮自动检索，tool = 她主动用 recall 工具
      query TEXT,
      score REAL,
      time INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_recalls_memory ON memory_recalls(memory_id);
    CREATE TABLE IF NOT EXISTS turns (
      session_id TEXT PRIMARY KEY,  -- dsh 会话 id
      user_id TEXT NOT NULL,
      group_id TEXT,
      updated INTEGER NOT NULL
    );
  `)
  migrate(db)
  return new Store(db)
}

/** 只加不改的结构升级；两个进程可能同时启动，重复加列报错直接忽略 */
function migrate(db) {
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)
  const add = (sql) => {
    try {
      db.exec(sql)
      return true
    } catch {
      return false
    }
  }
  // 短期记忆：群消息表扩成"原文"，她的回复、工具调用也记进来
  if (!has('group_messages', 'kind') && add("ALTER TABLE group_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'msg'")) {
    db.exec("UPDATE group_messages SET kind = 'reply' WHERE user_id = 'self'")
  }
  if (!has('group_messages', 'turn')) add('ALTER TABLE group_messages ADD COLUMN turn TEXT')
  if (!has('group_messages', 'meta')) add('ALTER TABLE group_messages ADD COLUMN meta TEXT')
  // 原文分段：每行属于哪一段（episodes.id）
  if (!has('group_messages', 'episode')) add('ALTER TABLE group_messages ADD COLUMN episode INTEGER')
  db.exec(`
    CREATE INDEX IF NOT EXISTS group_messages_turn ON group_messages(turn);
    CREATE INDEX IF NOT EXISTS group_messages_episode ON group_messages(episode);
    -- 原文分段：一段连续的聊天（冷场就切、太长找停顿切、同一轮不拆，不按天切）
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat TEXT NOT NULL,
      start INTEGER NOT NULL,       -- 第一行时间
      end INTEGER NOT NULL,         -- 最后一行时间
      rows INTEGER NOT NULL DEFAULT 0,
      summary TEXT,                 -- 一句话摘要（段落结束后补）
      summarized INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS episodes_chat_end ON episodes(chat, end);
    -- 长期记忆说的是谁（user:<openid> 名下的记忆隐含是这个人，不写这张表）
    CREATE TABLE IF NOT EXISTS memory_subjects (
      memory_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (memory_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS memory_subjects_user ON memory_subjects(user_id);
    -- 长期记忆的出处：对应原文（group_messages）里的一段
    CREATE TABLE IF NOT EXISTS memory_anchors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,
      chat TEXT NOT NULL,           -- 原文所在会话：群 openid / user:<openid>
      from_id INTEGER NOT NULL,
      to_id INTEGER NOT NULL,
      focus TEXT,                   -- 重点看谁的发言
      turn TEXT,                    -- 她在哪一轮记下的（这一轮结束时把 to_id 延到这一轮最后一行）
      guessed INTEGER NOT NULL DEFAULT 0, -- 1 = 旧记忆按时间推测的出处
      created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_anchors_memory ON memory_anchors(memory_id);
    CREATE INDEX IF NOT EXISTS memory_anchors_turn ON memory_anchors(turn);
    -- 群友画像：夜间由长期记忆融合而成，看板可改、可锁定、可回滚
    CREATE TABLE IF NOT EXISTS portraits (
      user_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,           -- JSON：{ sections: { key: { text, sources, locked } }, summary }
      version INTEGER NOT NULL,
      updated INTEGER NOT NULL,
      by TEXT NOT NULL,             -- night 夜间整理 / dashboard 看板修改 / rollback 回滚
      watermark INTEGER NOT NULL DEFAULT 0 -- 整理时看过的最新记忆时间
    );
    CREATE TABLE IF NOT EXISTS portrait_history (
      user_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      data TEXT NOT NULL,
      time INTEGER NOT NULL,
      by TEXT NOT NULL,
      note TEXT,
      PRIMARY KEY (user_id, version)
    );
  `)
}

export class Store {
  constructor(db) {
    this.db = db
  }

  remember(scope, content) {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO memories (scope, content, created) VALUES (?, ?, ?)')
      .run(scope, content, Date.now())
    return Number(lastInsertRowid)
  }

  forget(scopes, id) {
    const marks = scopes.map(() => '?').join(',')
    return this.db.prepare(`DELETE FROM memories WHERE id = ? AND scope IN (${marks})`).run(id, ...scopes).changes > 0
  }

  /** 最近的记忆，按时间倒序。 */
  recent(scope, limit) {
    return this.db
      .prepare('SELECT id, scope, content, created FROM memories WHERE scope = ? ORDER BY id DESC LIMIT ?')
      .all(scope, limit)
  }

  /** 关键词检索：任一关键词命中即可，命中词越多越靠前。 */
  search(scopes, keywords, limit) {
    const words = keywords.filter(Boolean).slice(0, 8)
    if (!words.length || !scopes.length) return []
    const marks = scopes.map(() => '?').join(',')
    const score = words.map(() => '(content LIKE ?)').join(' + ')
    return this.db.prepare(`
      SELECT id, scope, content, created, (${score}) AS hits FROM memories
      WHERE scope IN (${marks}) AND hits > 0
      ORDER BY hits DESC, id DESC LIMIT ?
    `).all(...words.map(w => `%${w}%`), ...scopes, limit)
  }

  // ---- 活动日志（看板图表用）----

  /** 写入一条活动，返回带 id 的记录；source_ref 重复（回填过）时返回 undefined。 */
  logActivity(a) {
    const row = {
      time: a.time ?? Date.now(), session_key: a.sessionKey ?? null, kind: a.kind, detail: a.detail ?? null,
      auto: a.auto ? 1 : 0, miss: a.miss ?? 0, hit: a.hit ?? 0, out: a.out ?? 0, cost: a.cost ?? 0, source_ref: a.sourceRef ?? null,
    }
    const res = this.db.prepare(`
      INSERT OR IGNORE INTO activity (time, session_key, kind, detail, auto, miss, hit, out, cost, source_ref)
      VALUES (:time, :session_key, :kind, :detail, :auto, :miss, :hit, :out, :cost, :source_ref)
    `).run(row)
    return res.changes ? { id: Number(res.lastInsertRowid), ...row } : undefined
  }

  activitySince(since) {
    return this.db.prepare('SELECT * FROM activity WHERE time >= ? ORDER BY time').all(since)
  }

  activityCount() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM activity').get().n
  }

  // ---- 看板用 ----

  listMemories(scope) {
    return scope
      ? this.db.prepare('SELECT * FROM memories WHERE scope = ? ORDER BY id DESC').all(scope)
      : this.db.prepare('SELECT * FROM memories ORDER BY id DESC').all()
  }

  updateMemory(id, content) {
    return this.db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(content, id).changes > 0
  }

  deleteMemory(id) {
    return this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0
  }

  listProfiles() {
    return this.db.prepare('SELECT * FROM profiles ORDER BY updated DESC').all()
  }

  clearCallName(userId) {
    this.db.prepare('UPDATE profiles SET call_name = NULL, updated = ? WHERE user_id = ?').run(Date.now(), userId)
  }

  /** 所有聊过的会话：键、当前 dsh 会话 id、最近发言人和时间。 */
  listSessions() {
    const turns = this.db.prepare('SELECT * FROM turns ORDER BY updated DESC').all()
    const seen = new Map()
    for (const t of turns) {
      const key = t.session_id.replace(/~\d+$/, '')
      if (seen.has(key)) continue
      seen.set(key, { key, sessionId: this.sessionId(key), lastUserId: t.user_id, groupId: t.group_id, updated: t.updated })
    }
    return [...seen.values()]
  }

  profile(userId) {
    return this.db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId)
  }

  touchProfile(userId, name) {
    this.db.prepare(`
      INSERT INTO profiles (user_id, name, updated) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, updated = excluded.updated
    `).run(userId, name || null, Date.now())
  }

  setCallName(userId, callName) {
    this.db.prepare(`
      INSERT INTO profiles (user_id, call_name, updated) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET call_name = excluded.call_name, updated = excluded.updated
    `).run(userId, callName, Date.now())
  }

  sessionId(key) {
    const row = this.db.prepare('SELECT generation FROM sessions WHERE key = ?').get(key)
    return row && row.generation > 0 ? `${key}~${row.generation}` : key
  }

  resetSession(key) {
    this.db.prepare(`
      INSERT INTO sessions (key, generation) VALUES (?, 1)
      ON CONFLICT(key) DO UPDATE SET generation = generation + 1
    `).run(key)
    return this.sessionId(key)
  }

  addImage(sessionKey, file, sender) {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO images (session_key, file, sender, created) VALUES (?, ?, ?, ?)')
      .run(sessionKey, file, sender ?? null, Date.now())
    return Number(lastInsertRowid)
  }

  image(id) {
    return this.db.prepare('SELECT * FROM images WHERE id = ?').get(id)
  }

  /** 清理过期图片记录，返回被删除的文件路径，由调用方删文件。 */
  pruneImages(olderThanMs) {
    const cutoff = Date.now() - olderThanMs
    const rows = this.db.prepare('SELECT file FROM images WHERE created < ?').all(cutoff)
    this.db.prepare('DELETE FROM images WHERE created < ?').run(cutoff)
    return rows.map(r => r.file)
  }

  /** 网关在每轮开始前写入当前发言人，dsh 工具据此知道“我”是谁。 */
  setTurn(sessionId, userId, groupId) {
    this.db.prepare(`
      INSERT INTO turns (session_id, user_id, group_id, updated) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET user_id = excluded.user_id, group_id = excluded.group_id, updated = excluded.updated
    `).run(sessionId, userId, groupId ?? null, Date.now())
  }

  // ---- 群消息记录（全量消息模式下每条都记，用于发言榜和总结） ----

  /** 记一行原文，返回行 id。extra：kind（msg 群友消息 / reply 她的回复 / tool 工具调用）、turn（轮次）、meta（对象，存成 JSON） */
  logGroupMessage(groupId, userId, name, text, time = Date.now(), extra = {}) {
    const { lastInsertRowid } = this.db.prepare('INSERT INTO group_messages (group_id, user_id, name, text, time, kind, turn, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(groupId, userId, name || null, text, time, extra.kind ?? 'msg', extra.turn ?? null, extra.meta ? JSON.stringify(extra.meta) : null)
    const id = Number(lastInsertRowid)
    if (this.episodePolicy) this.assignEpisode({ id, group_id: groupId, time, turn: extra.turn ?? null })
    return id
  }

  // ---- 原文分段 ----

  /**
   * 分段规则（网关设置；dsh 进程不写原文，不用设）：{ episodeGapMin, episodeMaxRows }，读的是配置对象本身，改了实时生效
   */
  setEpisodePolicy(policy) {
    this.episodePolicy = policy
  }

  /**
   * 给一行原文分段：同一轮跟着这一轮已有的行走；否则接在这个会话最近一段后面，
   * 冷场超过 gap、或者段太长遇到 3 分钟以上停顿（2 倍长度强制）就开新段。
   */
  assignEpisode(row) {
    const { episodeGapMin = 30, episodeMaxRows = 60 } = this.episodePolicy ?? {}
    let episode = row.turn
      ? this.db.prepare('SELECT episode FROM group_messages WHERE turn = ? AND episode IS NOT NULL AND id != ? LIMIT 1').get(row.turn, row.id)?.episode
      : undefined
    if (!episode) {
      const last = this.db.prepare('SELECT * FROM episodes WHERE chat = ? ORDER BY end DESC, id DESC LIMIT 1').get(row.group_id)
      const gap = last ? row.time - last.end : Infinity
      const split = !last || gap > episodeGapMin * 60_000
        || (last.rows >= episodeMaxRows && gap >= 3 * 60_000)
        || last.rows >= episodeMaxRows * 2
      episode = split
        ? Number(this.db.prepare('INSERT INTO episodes (chat, start, end, rows) VALUES (?, ?, ?, 0)').run(row.group_id, row.time, row.time).lastInsertRowid)
        : last.id
    }
    this.db.prepare('UPDATE episodes SET rows = rows + 1, start = MIN(start, ?), end = MAX(end, ?), summarized = 0 WHERE id = ?').run(row.time, row.time, episode)
    this.db.prepare('UPDATE group_messages SET episode = ? WHERE id = ?').run(episode, row.id)
    return episode
  }

  /** 还没分段的行（老原文、旧版写的）按时间顺序补切；返回补了多少行 */
  assignMissingEpisodes() {
    const rows = this.db.prepare('SELECT id, group_id, time, turn FROM group_messages WHERE episode IS NULL ORDER BY time, id').all()
    this.db.exec('BEGIN')
    try {
      for (const r of rows) this.assignEpisode(r)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return rows.length
  }

  episode(id) {
    return this.db.prepare('SELECT * FROM episodes WHERE id = ?').get(id)
  }

  episodeRows(id) {
    return this.db.prepare('SELECT * FROM group_messages WHERE episode = ? ORDER BY time, id').all(id)
  }

  /** 和 [since, until) 有重叠的段（完整的段，不按时间截断），按时间正序 */
  episodesBetween(chat, since, until) {
    return this.db.prepare('SELECT * FROM episodes WHERE chat = ? AND end >= ? AND start < ? ORDER BY start, id').all(chat, since, until)
  }

  /** 每段里说过话的人（不含她自己） */
  episodePeople(id) {
    return this.db.prepare("SELECT DISTINCT name FROM group_messages WHERE episode = ? AND user_id != 'self' AND name IS NOT NULL").all(id).map(r => r.name)
  }

  /** 一条长期记忆出处所在的段：有重点人物的取 TA 的发言所在段，否则取区间里所有行所在段 */
  episodesOfAnchor(a) {
    const focus = a.focus ? this.db.prepare("SELECT DISTINCT episode FROM group_messages WHERE group_id = ? AND id BETWEEN ? AND ? AND user_id = ? AND episode IS NOT NULL").all(a.chat, a.from_id, a.to_id, a.focus) : []
    const rows = focus.length ? focus : this.db.prepare('SELECT DISTINCT episode FROM group_messages WHERE group_id = ? AND id BETWEEN ? AND ? AND episode IS NOT NULL').all(a.chat, a.from_id, a.to_id)
    return rows.map(r => r.episode)
  }

  /** 某会话里早于 before 开始的段，新到旧（看板分页浏览） */
  episodesBefore(chat, before = Number.MAX_SAFE_INTEGER, limit = 20) {
    return this.db.prepare('SELECT * FROM episodes WHERE chat = ? AND start < ? ORDER BY start DESC, id DESC LIMIT ?').all(chat, before, limit)
  }

  /** 同一会话里的上一段 / 下一段 */
  episodeNeighbors(id) {
    const e = this.episode(id)
    if (!e) return { prev: null, next: null }
    const prev = this.db.prepare('SELECT id FROM episodes WHERE chat = ? AND (start < ? OR (start = ? AND id < ?)) ORDER BY start DESC, id DESC LIMIT 1').get(e.chat, e.start, e.start, id)
    const next = this.db.prepare('SELECT id FROM episodes WHERE chat = ? AND (start > ? OR (start = ? AND id > ?)) ORDER BY start, id LIMIT 1').get(e.chat, e.start, e.start, id)
    return { prev: prev?.id ?? null, next: next?.id ?? null }
  }

  episodeCount(chat) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE chat = ?').get(chat).n
  }

  /** 已经结束（最后一行早于 before）、还没摘要的段 */
  unsummarizedEpisodes(before, limit = 20) {
    return this.db.prepare('SELECT * FROM episodes WHERE summarized = 0 AND end < ? ORDER BY end LIMIT ?').all(before, limit)
  }

  setEpisodeSummary(id, summary) {
    this.db.prepare('UPDATE episodes SET summary = ?, summarized = 1 WHERE id = ?').run(summary, id)
  }

  /** 触发这一轮的那条消息补记轮次 */
  tagTurn(id, turn) {
    this.db.prepare('UPDATE group_messages SET turn = ? WHERE id = ?').run(turn, id)
  }

  /** 原文：[since, until) 内某个会话的全部行（含她的回复和工具调用），按时间正序，最多取最近的 limit 条 */
  transcript(groupId, since, until = Number.MAX_SAFE_INTEGER, limit = 2000) {
    return this.db.prepare('SELECT * FROM (SELECT * FROM group_messages WHERE group_id = ? AND time >= ? AND time < ? ORDER BY time DESC, id DESC LIMIT ?) ORDER BY time, id')
      .all(groupId, since, until, limit)
  }

  /** 原文：按行 id 区间取（长期记忆的锚点），按时间正序 */
  transcriptRange(groupId, fromId, toId) {
    return this.db.prepare('SELECT * FROM group_messages WHERE group_id = ? AND id >= ? AND id <= ? ORDER BY time, id').all(groupId, fromId, toId)
  }

  /** 有原文的会话、条数和最近一条的时间（看板选会话用） */
  /** 最近的工具调用（原文里 kind = tool 的行），看板工具页取每个工具的真实调用样例 */
  recentToolCalls(limit = 2000) {
    return this.db.prepare("SELECT * FROM group_messages WHERE kind = 'tool' ORDER BY id DESC LIMIT ?").all(limit)
  }

  transcriptChats() {
    return this.db.prepare('SELECT group_id AS chat, MAX(time) AS last, COUNT(*) AS count FROM group_messages GROUP BY group_id ORDER BY last DESC').all()
  }

  /** 原文：一段区间，前后各多给 pad 行上下文 */
  transcriptAround(groupId, fromId, toId, pad = 3) {
    const before = this.db.prepare('SELECT * FROM group_messages WHERE group_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(groupId, fromId, pad).reverse()
    const after = this.db.prepare('SELECT * FROM group_messages WHERE group_id = ? AND id > ? ORDER BY id LIMIT ?').all(groupId, toId, pad)
    return [...before, ...this.transcriptRange(groupId, fromId, toId), ...after]
  }

  /** 这一轮在原文里的位置：触发消息（没有就取会话最新一行）往前最多 before 行、30 分钟内 → 当前最后一行 */
  turnWindow(groupId, turn, before = 10) {
    const last = this.db.prepare('SELECT MAX(id) AS id FROM group_messages WHERE group_id = ?').get(groupId).id
    if (!last) return null
    const trigger = (turn && this.db.prepare("SELECT id, time FROM group_messages WHERE turn = ? AND kind = 'msg' ORDER BY id LIMIT 1").get(turn))
      ?? this.db.prepare('SELECT id, time FROM group_messages WHERE id = ?').get(last)
    const rows = this.db.prepare('SELECT id FROM group_messages WHERE group_id = ? AND id <= ? AND time >= ? ORDER BY id DESC LIMIT ?')
      .all(groupId, trigger.id, trigger.time - 30 * 60_000, before + 1)
    return { fromId: rows.length ? rows[rows.length - 1].id : trigger.id, toId: last }
  }

  /** 某个会话里近 since 以来说过话的人（不含她自己），名字取最近一次 */
  peopleInChat(groupId, since = 0) {
    return this.db.prepare(`
      SELECT user_id AS id, MAX(time) AS last,
        (SELECT name FROM group_messages g2 WHERE g2.group_id = g.group_id AND g2.user_id = g.user_id AND g2.name IS NOT NULL ORDER BY time DESC LIMIT 1) AS name
      FROM group_messages g WHERE group_id = ? AND time >= ? AND user_id != 'self' GROUP BY user_id
    `).all(groupId, since)
  }

  // ---- 长期记忆的归属人和出处 ----

  setSubjects(memoryId, userIds) {
    this.db.prepare('DELETE FROM memory_subjects WHERE memory_id = ?').run(memoryId)
    const stmt = this.db.prepare('INSERT OR IGNORE INTO memory_subjects (memory_id, user_id) VALUES (?, ?)')
    for (const id of new Set(userIds)) stmt.run(memoryId, id)
  }

  /** 全部归属关系（看板、按人汇总用） */
  allSubjects() {
    return this.db.prepare('SELECT memory_id AS memoryId, user_id AS userId FROM memory_subjects').all()
  }

  /** 挂到某人身上的记忆 id（不含 user:<TA> 名下的，那些按作用域查） */
  memoriesAbout(userId) {
    return this.db.prepare('SELECT memory_id FROM memory_subjects WHERE user_id = ?').all(userId).map(r => r.memory_id)
  }

  addAnchor({ memoryId, chat, fromId, toId, focus, turn, guessed }) {
    this.db.prepare('INSERT INTO memory_anchors (memory_id, chat, from_id, to_id, focus, turn, guessed, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(memoryId, chat, fromId, toId, focus ?? null, turn ?? null, guessed ? 1 : 0, Date.now())
  }

  /** 一轮结束（工具调用、回复都记进原文后）把这一轮记下的记忆的出处延到这一轮的最后一行 */
  closeAnchors(turn) {
    this.db.prepare('UPDATE memory_anchors SET to_id = MAX(to_id, (SELECT MAX(id) FROM group_messages WHERE turn = ?)) WHERE turn = ? AND EXISTS (SELECT 1 FROM group_messages WHERE turn = ?)')
      .run(turn, turn, turn)
  }

  /** 按记忆 id 或前缀（给模型看的 8 位短 id）查出处，新到旧 */
  anchorsOf(memoryId) {
    return this.db.prepare('SELECT * FROM memory_anchors WHERE memory_id LIKE ? ORDER BY id DESC').all(`${memoryId}%`)
  }

  /** 全部出处（看板用） */
  allAnchors() {
    return this.db.prepare('SELECT * FROM memory_anchors ORDER BY id').all()
  }

  deleteMemoryLinks(memoryId) {
    this.db.prepare('DELETE FROM memory_subjects WHERE memory_id = ?').run(memoryId)
    this.db.prepare('DELETE FROM memory_anchors WHERE memory_id = ?').run(memoryId)
  }

  // ---- 群友画像 ----

  portrait(userId) {
    const row = this.db.prepare('SELECT * FROM portraits WHERE user_id = ?').get(userId)
    return row ? { ...row, data: JSON.parse(row.data) } : undefined
  }

  listPortraits() {
    return this.db.prepare('SELECT * FROM portraits ORDER BY updated DESC').all().map(r => ({ ...r, data: JSON.parse(r.data) }))
  }

  /** 存一个新版本（版本号 +1，同时写历史）；watermark 不传就沿用旧的 */
  savePortrait(userId, data, by, note = null, watermark) {
    const old = this.db.prepare('SELECT version, watermark FROM portraits WHERE user_id = ?').get(userId)
    const version = (old?.version ?? 0) + 1
    const now = Date.now()
    const json = JSON.stringify(data)
    this.db.exec('BEGIN')
    try {
      this.db.prepare(`
        INSERT INTO portraits (user_id, data, version, updated, by, watermark) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, version = excluded.version, updated = excluded.updated, by = excluded.by, watermark = excluded.watermark
      `).run(userId, json, version, now, by, watermark ?? old?.watermark ?? 0)
      this.db.prepare('INSERT INTO portrait_history (user_id, version, data, time, by, note) VALUES (?, ?, ?, ?, ?, ?)').run(userId, version, json, now, by, note)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return version
  }

  portraitHistory(userId) {
    return this.db.prepare('SELECT * FROM portrait_history WHERE user_id = ? ORDER BY version DESC').all(userId).map(r => ({ ...r, data: JSON.parse(r.data) }))
  }

  /** 某会话里哪些天有原文（北京时间日期，新到旧） */
  transcriptDays(groupId, limit = 60) {
    return this.db.prepare("SELECT DISTINCT date(time / 1000 + 8 * 3600, 'unixepoch') AS day FROM group_messages WHERE group_id = ? ORDER BY day DESC LIMIT ?")
      .all(groupId, limit).map(r => r.day)
  }

  /** 发言榜：[since, until) 内每人的发言条数，名字取最近一次的群昵称；exclude 一般是机器人自己。 */
  groupRank(groupId, since, until = Number.MAX_SAFE_INTEGER, exclude = '', limit = 10) {
    return this.db.prepare(`
      SELECT user_id AS userId, COUNT(*) AS count,
        (SELECT name FROM group_messages g2 WHERE g2.group_id = g.group_id AND g2.user_id = g.user_id AND g2.name IS NOT NULL ORDER BY time DESC LIMIT 1) AS name
      FROM group_messages g WHERE group_id = ? AND time >= ? AND time < ? AND user_id != ?
      GROUP BY user_id ORDER BY count DESC LIMIT ?
    `).all(groupId, since, until, exclude, limit)
  }

  groupTotals(groupId, since, exclude = '') {
    return this.db.prepare('SELECT COUNT(*) AS messages, COUNT(DISTINCT user_id) AS speakers FROM group_messages WHERE group_id = ? AND time >= ? AND user_id != ?')
      .get(groupId, since, exclude)
  }

  /** since 之后的群消息，按时间正序，最多取最近的 limit 条。 */
  groupHistory(groupId, since, limit = 300) {
    return this.db.prepare("SELECT * FROM (SELECT * FROM group_messages WHERE group_id = ? AND time >= ? AND kind != 'tool' ORDER BY time DESC LIMIT ?) ORDER BY time")
      .all(groupId, since, limit)
  }

  /** [since, until) 内的全部群消息（统计用，按时间正序）。 */
  groupMessagesBetween(groupId, since, until) {
    return this.db.prepare("SELECT user_id, name, text, time FROM group_messages WHERE group_id = ? AND time >= ? AND time < ? AND kind != 'tool' ORDER BY time")
      .all(groupId, since, until)
  }

  /** 每个人在这个群里第一次被记录到发言的时间，以及整个群最早一条记录的时间。 */
  groupFirstSeen(groupId) {
    const users = this.db.prepare('SELECT user_id, MIN(time) AS first FROM group_messages WHERE group_id = ? GROUP BY user_id').all(groupId)
    return { since: Math.min(...users.map(u => u.first), Date.now()), users: new Map(users.map(u => [u.user_id, u.first])) }
  }

  /** id 之后的群消息（记忆梳理用，不含她自己）。 */
  groupMessagesAfter(groupId, afterId, limit = 200) {
    return this.db.prepare("SELECT * FROM group_messages WHERE group_id = ? AND id > ? AND user_id != 'self' ORDER BY id LIMIT ?")
      .all(groupId, afterId, limit)
  }

  countGroupMessagesAfter(groupId, afterId) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM group_messages WHERE group_id = ? AND id > ? AND user_id != 'self'").get(groupId, afterId).n
  }

  // ---- credits ----

  /**
   * 记一轮的费用。超出今日上限的部分先从充值余额里扣（余额不够就记成欠，余额可以是负数，下次充值补上）。
   * rows: [{ time, item, detail, yuan, credits }]；limit 是这个人今天的上限，Infinity = 不限（管理员）。
   */
  chargeTurn({ day, userId, groupId, sessionKey, turn, limit }, rows) {
    if (!rows.length) return
    const total = rows.reduce((n, r) => n + r.credits, 0)
    this.db.exec('BEGIN')
    try {
      let overflow = 0
      if (userId && Number.isFinite(limit)) {
        const before = this.creditsSpent({ userId, day })
        overflow = Math.max(0, before + total - limit) - Math.max(0, before - limit)
        if (overflow > 0) {
          this.db.prepare('INSERT INTO credit_accounts (user_id, balance) VALUES (?, 0) ON CONFLICT(user_id) DO NOTHING').run(userId)
          this.db.prepare('UPDATE credit_accounts SET balance = balance - ? WHERE user_id = ?').run(overflow, userId)
        }
      }
      const stmt = this.db.prepare(`
        INSERT INTO credit_ledger (time, day, user_id, group_id, session_key, turn, item, detail, yuan, credits, bonus)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const r of rows) {
        // 从余额扣的部分按比例摊到每一笔，方便对账
        const bonus = total ? overflow * r.credits / total : 0
        stmt.run(r.time, day, userId ?? null, groupId ?? null, sessionKey ?? null, turn, r.item, r.detail ?? null, r.yuan, r.credits, bonus)
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /** 某人 / 某群 / 全局在某天花了多少 credits；filter 为空对象 = 全局 */
  creditsSpent({ userId, groupId, day, excludeUsers = [] }) {
    const where = ['day = ?'], args = [day]
    if (userId) { where.push('user_id = ?'); args.push(userId) }
    if (groupId) { where.push('group_id = ?'); args.push(groupId) }
    // 不算这些人花的（管理员不受限，他们的花费不该挤占群额度）
    if (excludeUsers.length) { where.push(`(user_id IS NULL OR user_id NOT IN (${excludeUsers.map(() => '?').join(',')}))`); args.push(...excludeUsers) }
    return this.db.prepare(`SELECT COALESCE(SUM(credits), 0) AS n FROM credit_ledger WHERE ${where.join(' AND ')}`).get(...args).n
  }

  creditAccount(userId) {
    return this.db.prepare('SELECT * FROM credit_accounts WHERE user_id = ?').get(userId) ?? { user_id: userId, daily_limit: null, balance: 0 }
  }

  /** 充值：只加余额，不碰已花掉的账 */
  topUp(userId, credits, note = '') {
    this.db.prepare('INSERT INTO credit_accounts (user_id, balance) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET balance = balance + excluded.balance')
      .run(userId, credits)
    this.db.prepare("INSERT INTO credit_adjustments (time, user_id, kind, amount, note) VALUES (?, ?, 'topup', ?, ?)").run(Date.now(), userId, credits, note)
  }

  /** 改每日上限；null = 恢复默认 */
  setDailyLimit(userId, limit, note = '') {
    this.db.prepare('INSERT INTO credit_accounts (user_id, daily_limit) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET daily_limit = excluded.daily_limit')
      .run(userId, limit)
    this.db.prepare("INSERT INTO credit_adjustments (time, user_id, kind, amount, note) VALUES (?, ?, 'limit', ?, ?)").run(Date.now(), userId, limit, note)
  }

  /** 某天按人、按群汇总：credits、人民币、几轮对话 */
  creditsByDay(day) {
    return this.creditsByRange(day, day)
  }

  /** [from, to] 这些天（含两端，YYYY-MM-DD）按人、按群汇总；用于历史统计 */
  creditsByRange(from, to) {
    const sum = 'COALESCE(SUM(credits), 0) AS credits, COALESCE(SUM(yuan), 0) AS yuan, COUNT(DISTINCT turn) AS turns'
    const where = 'day >= ? AND day <= ?'
    return {
      users: this.db.prepare(`SELECT user_id AS id, ${sum} FROM credit_ledger WHERE ${where} AND user_id IS NOT NULL GROUP BY user_id`).all(from, to),
      groups: this.db.prepare(`SELECT group_id AS id, ${sum} FROM credit_ledger WHERE ${where} AND group_id IS NOT NULL GROUP BY group_id`).all(from, to),
      global: this.db.prepare(`SELECT ${sum}, COUNT(DISTINCT day) AS days FROM credit_ledger WHERE ${where}`).get(from, to),
      byItem: this.db.prepare(`SELECT item, COALESCE(SUM(credits), 0) AS credits, COALESCE(SUM(yuan), 0) AS yuan, COUNT(*) AS count FROM credit_ledger WHERE ${where} GROUP BY item`).all(from, to),
    }
  }

  /** 最早有账的那天（没有记录时为空） */
  creditFirstDay() {
    return this.db.prepare('SELECT MIN(day) AS day FROM credit_ledger').get().day ?? null
  }

  /** 有记录的日期（新到旧） */
  creditDays(limit = 30) {
    return this.db.prepare('SELECT DISTINCT day FROM credit_ledger ORDER BY day DESC LIMIT ?').all(limit).map(r => r.day)
  }

  /** 设置过上限或余额的人 */
  creditAccounts() {
    return this.db.prepare('SELECT * FROM credit_accounts').all()
  }

  /** 某人的账本明细（新到旧） */
  creditLedgerOf(userId, limit = 100) {
    return this.db.prepare('SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit)
  }

  creditAdjustmentsOf(userId, limit = 50) {
    return this.db.prepare('SELECT * FROM credit_adjustments WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit)
  }

  // ---- 表情包使用审计 ----

  logStickerUse(stickerId, sessionKey, userId, query) {
    this.db.prepare('INSERT INTO sticker_uses (sticker_id, session_key, user_id, query, time) VALUES (?, ?, ?, ?, ?)')
      .run(stickerId, sessionKey ?? null, userId ?? null, query ?? null, Date.now())
  }

  /** 每张表情发过几次、最近一次时间 */
  stickerUseStats() {
    return this.db.prepare('SELECT sticker_id AS stickerId, COUNT(*) AS count, MAX(time) AS last FROM sticker_uses GROUP BY sticker_id').all()
  }

  /** 某个会话最近发过的表情（新到旧），挑图时避开 */
  recentStickers(sessionKey, limit = 10) {
    return this.db.prepare('SELECT sticker_id FROM sticker_uses WHERE session_key = ? ORDER BY id DESC LIMIT ?').all(sessionKey, limit).map(r => r.sticker_id)
  }

  stickerUsesOf(stickerId, limit = 50) {
    return this.db.prepare('SELECT * FROM sticker_uses WHERE sticker_id = ? ORDER BY id DESC LIMIT ?').all(stickerId, limit)
  }

  // ---- 记忆召回审计 ----

  logRecalls(rows) {
    const stmt = this.db.prepare('INSERT INTO memory_recalls (memory_id, session_key, user_id, via, query, score, time) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const now = Date.now()
    for (const r of rows) stmt.run(r.memoryId, r.sessionKey ?? null, r.userId ?? null, r.via, r.query ?? null, r.score ?? null, now)
  }

  /** 每条记忆的召回次数、最近一次召回时间、涉及几个会话 */
  recallStats() {
    return this.db.prepare(`
      SELECT memory_id AS memoryId, COUNT(*) AS count, MAX(time) AS last, COUNT(DISTINCT session_key) AS sessions
      FROM memory_recalls GROUP BY memory_id
    `).all()
  }

  recallsOf(memoryId, limit = 100) {
    return this.db.prepare('SELECT * FROM memory_recalls WHERE memory_id = ? ORDER BY time DESC LIMIT ?').all(memoryId, limit)
  }

  /** 群里最后一条别人说的话（不算她自己）是什么时候；没有记录返回 null */
  lastHumanMessageTime(groupId) {
    return this.db.prepare("SELECT MAX(time) AS t FROM group_messages WHERE group_id = ? AND user_id != 'self'").get(groupId).t ?? null
  }

  /** 这个人在这个群里有没有说过话（新人判断用）。 */
  hasSpoken(groupId, userId) {
    return Boolean(this.db.prepare('SELECT 1 FROM group_messages WHERE group_id = ? AND user_id = ? LIMIT 1').get(groupId, userId))
  }

  /** 清理过期原文：按段整段删；段里只要有一行被长期记忆引用，整段永久保留 */
  pruneGroupMessages(olderThanMs) {
    const cutoff = Date.now() - olderThanMs
    const kept = `
      SELECT DISTINCT g.episode FROM group_messages g JOIN memory_anchors a ON a.chat = g.group_id AND g.id BETWEEN a.from_id AND a.to_id
      WHERE g.episode IS NOT NULL`
    const changes = this.db.prepare(`
      DELETE FROM group_messages WHERE time < ?
        AND NOT EXISTS (SELECT 1 FROM memory_anchors a WHERE a.chat = group_messages.group_id AND group_messages.id BETWEEN a.from_id AND a.to_id)
        AND (episode IS NULL OR (episode NOT IN (${kept}) AND episode IN (SELECT id FROM episodes WHERE end < ?)))
    `).run(cutoff, cutoff).changes
    if (changes) this.db.prepare('DELETE FROM episodes WHERE id NOT IN (SELECT DISTINCT episode FROM group_messages WHERE episode IS NOT NULL)').run()
    return changes
  }

  turn(sessionId) {
    return this.db.prepare('SELECT user_id AS userId, group_id AS groupId FROM turns WHERE session_id = ?').get(sessionId)
  }
}

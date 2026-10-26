export interface Memory {
  id: number
  scope: string
  content: string
  created: number
}

export interface Profile {
  user_id: string
  name: string | null
  call_name: string | null
  updated: number
}

export interface Activity {
  id: number
  time: number
  session_key: string | null
  kind: string
  detail: string | null
  auto: number
  miss: number
  hit: number
  out: number
  cost: number
  source_ref: string | null
}

export interface ActivityInput {
  time?: number
  sessionKey?: string
  kind: string
  detail?: string
  auto?: boolean
  miss?: number
  hit?: number
  out?: number
  cost?: number
  sourceRef?: string
}

export interface PortraitSection {
  text: string
  /** 用到的长期记忆短 id */
  sources: string[]
  locked: boolean
}

export interface PortraitData {
  sections: Record<string, PortraitSection>
  summary: string
}

export interface PortraitRow {
  user_id: string
  data: PortraitData
  version: number
  updated: number
  by: string
  watermark: number
}

/** 长期记忆的出处：原文里的一段 */
export interface MemoryAnchor {
  id: number
  memory_id: string
  chat: string
  from_id: number
  to_id: number
  focus: string | null
  turn: string | null
  guessed: 0 | 1
  created: number
}

export interface GroupMessage {
  id: number
  group_id: string
  user_id: string
  name: string | null
  text: string
  time: number
  /** msg 群友消息 / reply 她的回复 / tool 工具调用 */
  kind: 'msg' | 'reply' | 'tool'
  /** 轮次：触发消息、她的回复、这一轮的工具调用共用 */
  turn: string | null
  /** JSON：工具名、参数、结果，回复的触发原因和媒体 */
  meta: string | null
  /** 属于哪一段（episodes.id） */
  episode: number | null
}

/** 原文的一段：一段连续的聊天 */
export interface Episode {
  id: number
  chat: string
  start: number
  end: number
  rows: number
  summary: string | null
  summarized: 0 | 1
}

export interface CreditAccount {
  user_id: string
  /** 每日上限；null = 用配置里的默认值 */
  daily_limit: number | null
  /** 充值余额（超出每日上限后从这里扣，可能为负） */
  balance: number
}

export interface CreditSum {
  id: string
  credits: number
  yuan: number
  turns: number
}

export interface CreditLedgerRow {
  id: number
  time: number
  day: string
  user_id: string | null
  group_id: string | null
  session_key: string | null
  turn: string
  item: string
  detail: string | null
  yuan: number
  credits: number
  bonus: number
}

export declare function openStore(path: string): Store

export declare class Store {
  remember(scope: string, content: string): number
  forget(scopes: string[], id: number): boolean
  recent(scope: string, limit: number): Memory[]
  search(scopes: string[], keywords: string[], limit: number): Memory[]
  profile(userId: string): Profile | undefined
  touchProfile(userId: string, name: string): void
  setCallName(userId: string, callName: string): void
  sessionId(key: string): string
  resetSession(key: string): string
  addImage(sessionKey: string, file: string, sender?: string): number
  image(id: number): { id: number, session_key: string, file: string, sender: string | null, created: number } | undefined
  pruneImages(olderThanMs: number): string[]
  logActivity(a: ActivityInput): Activity | undefined
  logGroupMessage(groupId: string, userId: string, name: string, text: string, time?: number, extra?: { kind?: GroupMessage['kind'], turn?: string, meta?: Record<string, unknown> }): number
  tagTurn(id: number, turn: string): void
  transcript(groupId: string, since: number, until?: number, limit?: number): GroupMessage[]
  transcriptRange(groupId: string, fromId: number, toId: number): GroupMessage[]
  recentToolCalls(limit?: number): GroupMessage[]
  transcriptChats(): { chat: string, last: number, count: number }[]
  transcriptDays(groupId: string, limit?: number): string[]
  transcriptAround(groupId: string, fromId: number, toId: number, pad?: number): GroupMessage[]
  turnWindow(groupId: string, turn: string | undefined, before?: number): { fromId: number, toId: number } | null
  peopleInChat(groupId: string, since?: number): { id: string, last: number, name: string | null }[]
  setSubjects(memoryId: string, userIds: string[]): void
  allSubjects(): { memoryId: string, userId: string }[]
  memoriesAbout(userId: string): string[]
  addAnchor(a: { memoryId: string, chat: string, fromId: number, toId: number, focus?: string, turn?: string, guessed?: boolean }): void
  closeAnchors(turn: string): void
  anchorsOf(memoryId: string): MemoryAnchor[]
  allAnchors(): MemoryAnchor[]
  deleteMemoryLinks(memoryId: string): void
  setEpisodePolicy(policy: { episodeGapMin: number, episodeMaxRows: number }): void
  assignMissingEpisodes(): number
  episode(id: number): Episode | undefined
  episodeRows(id: number): GroupMessage[]
  episodesBetween(chat: string, since: number, until: number): Episode[]
  episodePeople(id: number): string[]
  episodesOfAnchor(a: MemoryAnchor): number[]
  unsummarizedEpisodes(before: number, limit?: number): Episode[]
  episodesBefore(chat: string, before?: number, limit?: number): Episode[]
  episodeNeighbors(id: number): { prev: number | null, next: number | null }
  episodeCount(chat: string): number
  setEpisodeSummary(id: number, summary: string): void
  portrait(userId: string): PortraitRow | undefined
  listPortraits(): PortraitRow[]
  savePortrait(userId: string, data: PortraitData, by: string, note?: string | null, watermark?: number): number
  portraitHistory(userId: string): { user_id: string, version: number, data: PortraitData, time: number, by: string, note: string | null }[]
  groupRank(groupId: string, since: number, until?: number, exclude?: string, limit?: number): { userId: string, count: number, name: string | null }[]
  groupTotals(groupId: string, since: number, exclude?: string): { messages: number, speakers: number }
  groupHistory(groupId: string, since: number, limit?: number): GroupMessage[]
  groupMessagesBetween(groupId: string, since: number, until: number): Pick<GroupMessage, 'user_id' | 'name' | 'text' | 'time'>[]
  groupFirstSeen(groupId: string): { since: number, users: Map<string, number> }
  groupMessagesAfter(groupId: string, afterId: number, limit?: number): GroupMessage[]
  countGroupMessagesAfter(groupId: string, afterId: number): number
  chargeTurn(
    turn: { day: string, userId?: string, groupId?: string, sessionKey?: string, turn: string, limit: number },
    rows: { time: number, item: string, detail?: string, yuan: number, credits: number }[],
  ): void
  creditsSpent(filter: { userId?: string, groupId?: string, day: string, excludeUsers?: string[] }): number
  creditAccount(userId: string): CreditAccount
  topUp(userId: string, credits: number, note?: string): void
  setDailyLimit(userId: string, limit: number | null, note?: string): void
  creditsByDay(day: string): {
    users: CreditSum[]
    groups: CreditSum[]
    global: Omit<CreditSum, 'id'>
    byItem: { item: string, credits: number, yuan: number, count: number }[]
  }
  creditsByRange(from: string, to: string): {
    users: CreditSum[]
    groups: CreditSum[]
    global: Omit<CreditSum, 'id'> & { days: number }
    byItem: { item: string, credits: number, yuan: number, count: number }[]
  }
  creditFirstDay(): string | null
  creditDays(limit?: number): string[]
  creditAccounts(): CreditAccount[]
  creditLedgerOf(userId: string, limit?: number): CreditLedgerRow[]
  creditAdjustmentsOf(userId: string, limit?: number): { id: number, time: number, user_id: string, kind: 'topup' | 'limit', amount: number | null, note: string | null }[]
  logStickerUse(stickerId: string, sessionKey?: string, userId?: string, query?: string): void
  stickerUseStats(): { stickerId: string, count: number, last: number }[]
  recentStickers(sessionKey: string, limit?: number): string[]
  stickerUsesOf(stickerId: string, limit?: number): { id: number, sticker_id: string, session_key: string | null, user_id: string | null, query: string | null, time: number }[]
  logRecalls(rows: { memoryId: string, sessionKey?: string, userId?: string, via: 'auto' | 'tool', query?: string, score?: number }[]): void
  recallStats(): { memoryId: string, count: number, last: number, sessions: number }[]
  recallsOf(memoryId: string, limit?: number): { id: number, memory_id: string, session_key: string | null, user_id: string | null, via: string, query: string | null, score: number | null, time: number }[]
  lastHumanMessageTime(groupId: string): number | null
  hasSpoken(groupId: string, userId: string): boolean
  pruneGroupMessages(olderThanMs: number): number
  activitySince(since: number): Activity[]
  activityCount(): number
  listMemories(scope?: string): Memory[]
  updateMemory(id: number, content: string): boolean
  deleteMemory(id: number): boolean
  listProfiles(): Profile[]
  clearCallName(userId: string): void
  listSessions(): { key: string, sessionId: string, lastUserId: string, groupId: string | null, updated: number }[]
  setTurn(sessionId: string, userId: string, groupId?: string): void
  turn(sessionId: string): { userId: string, groupId: string | null } | undefined
}

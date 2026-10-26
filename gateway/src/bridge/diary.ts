import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { profilePath } from '../config.js'

/** 日记存档到角色包 diary/<日期>.md（跟着角色包的私有仓库走）；同一天多个群写在同一个文件里。日记本身是一个定时任务（见 jobs.ts） */
export function saveDiary(date: string, groupId: string, text: string) {
  const dir = profilePath('diary')
  mkdirSync(dir, { recursive: true })
  const file = profilePath('diary', `${date}.md`)
  const header = existsSync(file) ? '\n\n---\n\n' : ''
  appendFileSync(file, `${header}<!-- 群 ${groupId} -->\n\n${text.trim()}\n`)
}

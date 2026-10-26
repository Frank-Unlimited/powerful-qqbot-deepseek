export interface Settings {
  stickers: boolean
  stickerEvery: number
  lookImage: boolean
  webSearch: boolean
  ownerOnlyTools: string[]
  voice: boolean
  /** 主人 openid（来自 config.owner.id） */
  ownerId: string
}

export declare function createSettings(path: string): {
  get(): Settings
}

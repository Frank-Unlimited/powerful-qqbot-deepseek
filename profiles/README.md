# 角色包

一个机器人"是谁"的全部内容都在 `profiles/<名字>/` 里，框架代码不含任何具体角色：

```
profiles/<名字>/
├─ config.yaml          配置：QQ、模型、额度、触发方式、各种提示词……
├─ persona/<人格>.yaml   人格（config.yaml 的 agent.persona 选用哪一个）
└─ assets/
   ├─ stickers/<标签>/   表情包，文件名即说明
   ├─ archive/           （可选）表情索引：index.json + 图片，目录名可在 stickers.archiveDir 改
   ├─ stickers/collected/  机器人收藏、看板导入的表情（自动生成）
   └─ character/avatar.png  （可选）看板头像
```

用哪个角色包由 `.env` 里的 `SHARK_PROFILE` 决定，默认 `example`。

- `example/` 是随仓库发布的示例。
- 其余目录都被 `.gitignore` 忽略：自己的角色包建议单独建一个私有 git 仓库（在角色包目录里 `git init` 即可），
  和框架的版本互不干扰，也不会误把人格、配置、表情包推到公开仓库。
- 配置里所有图片路径（如关键词表情的 `image`）都相对角色包目录。

## 表情索引格式

`stickers.archiveDir` 目录（默认 `assets/archive`）下放一个 `index.json`，适合成批导入别处整理好的表情：

```json
{
  "stickers": [
    { "local": "send/xxx.png", "alt": "抱着饭碗委屈巴巴地哭", "tags": ["委屈", "吃饭"] }
  ]
}
```

`local` 是相对这个目录的图片路径，`alt` 是说明（参与语义检索），`tags` 是标签。

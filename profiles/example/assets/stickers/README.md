表情包库：每个子目录是一个标签，目录里放图片（png / jpg / gif / webp），文件名就是图片说明（参与检索）。
例：assets/stickers/开心/抱着饭碗转圈.png、assets/stickers/害羞/捂脸.gif
目录名会作为 send_sticker 工具的可选标签告诉模型；增删图片或目录后重启 dsh 生效。

另一种来源是「表情索引」：在 config.yaml 的 stickers.archiveDir 目录（默认 assets/archive）放一个 index.json
列出图片和说明，适合成批导入别处整理好的表情，格式见 profiles/README.md。也可以在本地看板「表情包」页直接导入图片。

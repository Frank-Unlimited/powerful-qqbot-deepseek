# 翻唱进程（sing_cover 工具的后端）

网关第一次用到翻唱时启动 `worker.py`，空闲 `cover.idleMinutes` 分钟后自己退出、释放显存。设计见 `docs/spec-cover.md`。

## 安装

要 NVIDIA 显卡。50 系显卡要 CUDA 12.8 版 PyTorch，下面这条已经指定好了。需要 [uv](https://docs.astral.sh/uv/)。

```
uv venv --python 3.12 tools/cover/.venv
uv pip install --python tools/cover/.venv/Scripts/python.exe "ultimate-rvc[cuda]==0.6.0" --extra-index-url https://download.pytorch.org/whl/cu128 --index-strategy unsafe-best-match
```

装完约 6 GB。第一次翻唱时会自动下载公共权重（人声分离模型 BS-Roformer、RMVPE、ContentVec，约 1 GB）到 `tools/cover/models/`，第一次要多等一会儿。`.venv/` 和 `models/` 都不进 git。

## 音色

RVC v2 模型（`.pth`，最好带 `.index`）放进角色包的 `cover.modelDir`（默认 `assets/cover/voice`），目录里第一个 `.pth` 就是音色。可以在 Hugging Face 上搜 RVC v2 模型（例如 [sxndypz/rvc-v2-models](https://huggingface.co/sxndypz/rvc-v2-models)），用唱歌素材训练的模型唱歌更稳；注意模型的许可证和声音版权。

## 中间文件

都在 `data/cache/cover/`：`songs/` 下载的原曲（上限 1 GB），`stems/` 分离出的人声和伴奏（留最近 30 首），`out/` 发出去的 wav（1 小时后删）。

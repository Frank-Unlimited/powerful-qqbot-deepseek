"""
翻唱进程：网关第一次用到时启动，空闲 --idle 秒后自己退出，把显存还给别的程序。

POST /sing  {audio, out, model, index, cache_dir, part, at, length, auto_transpose, transpose, index_rate, protect, ffmpeg}
  1. 整首分离人声 / 伴奏（按文件缓存在 cache_dir）
  2. 选一段：chorus = 人声能量最集中的 length 秒，start = 人声第一次出现，at = 从指定秒数开始
  3. 只把这一段人声用 RVC 换成角色音色（原唱偏低时自动升 12 个半音）
  4. 和伴奏混音、加一点混响、淡入淡出、统一响度，输出 wav
  返回 {ok, start, end, transpose} 或 {ok: false, error}
GET /health

只用来在本机给网关调用，监听 127.0.0.1。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CACHE = ROOT / "data" / "cache" / "cover"

# Ultimate RVC 的公共权重（RMVPE、ContentVec、分离模型）下载到 tools/cover/models，中间文件放 data/cache/cover
os.environ.setdefault("URVC_MODELS_DIR", str(HERE / "models"))
os.environ.setdefault("URVC_AUDIO_DIR", str(CACHE / "urvc-audio"))
os.environ.setdefault("URVC_TEMP_DIR", str(CACHE / "urvc-temp"))
os.environ.setdefault("URVC_CONFIG_DIR", str(CACHE / "urvc-config"))

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402

# 人声分离模型：BS-Roformer（audio-separator 自动下载到 SEPARATOR_DIR）
SEPARATOR_MODEL = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"
SEPARATOR_DIR = HERE / "models" / "audio_separator"
# 原唱人声音高中位数低于这个就当男声，升一个八度
LOW_VOICE_HZ = 220.0

last_used = time.time()
lock = threading.Lock()
_converter = None


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def download(url: str, dst: Path, tries: int = 5):
    """断点续传下载，断了自动接着下"""
    import requests

    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".part")
    log(f"下载 {url}")
    for attempt in range(tries):
        try:
            have = tmp.stat().st_size if tmp.exists() else 0
            headers = {"Range": f"bytes={have}-"} if have else {}
            with requests.get(url, stream=True, timeout=60, headers=headers) as r:
                if r.status_code == 416:  # 已经下完
                    break
                r.raise_for_status()
                if have and r.status_code != 206:  # 服务器不支持续传，从头来
                    have = 0
                total = have + int(r.headers.get("content-length", 0))
                with tmp.open("ab" if have else "wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
            if not total or tmp.stat().st_size >= total:
                break
        except Exception as e:  # noqa: BLE001
            log(f"下载中断（第 {attempt + 1} 次）：{e}")
            if attempt == tries - 1:
                raise
    tmp.replace(dst)


def ensure_weights():
    """RMVPE 只在 Ultimate RVC 自己的初始化里下载、ContentVec 用 wget 下载断了不重试，这里先补齐"""
    from ultimate_rvc.common import RVC_MODELS_DIR

    base = "https://huggingface.co/JackismyShephard/ultimate-rvc/resolve/main/Resources"
    root = Path(RVC_MODELS_DIR)
    for rel in ("predictors/rmvpe.pt", "embedders/contentvec/pytorch_model.bin", "embedders/contentvec/config.json"):
        if not (root / rel).exists():
            download(f"{base}/{rel}", root / rel)


def converter():
    """RVC 推理器（加载一次，常驻到进程退出）"""
    global _converter
    if _converter is None:
        from ultimate_rvc.rvc.infer.infer import VoiceConverter

        ensure_weights()
        _converter = VoiceConverter()
    return _converter


def free_gpu():
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def separate(audio: Path, cache_dir: Path) -> tuple[Path, Path]:
    """整首分离，返回 (人声, 伴奏) 的 wav；同一个文件只分离一次"""
    st = audio.stat()
    key = hashlib.sha1(f"{audio.resolve()}|{st.st_size}|{int(st.st_mtime)}|{SEPARATOR_MODEL}".encode()).hexdigest()[:16]
    vocals, inst = cache_dir / f"{key}-vocals.wav", cache_dir / f"{key}-inst.wav"
    if vocals.exists() and inst.exists():
        return vocals, inst
    cache_dir.mkdir(parents=True, exist_ok=True)
    from audio_separator.separator import Separator

    sep = Separator(model_file_dir=str(SEPARATOR_DIR), output_dir=str(cache_dir), output_format="WAV", sample_rate=44100, use_autocast=True)
    sep.load_model(SEPARATOR_MODEL)
    primary = sep.model_instance.primary_stem_name
    secondary = sep.model_instance.secondary_stem_name
    names = {primary: f"{key}-{primary.lower()}", secondary: f"{key}-{secondary.lower()}"}
    sep.separate(str(audio), custom_output_names=names)
    del sep
    free_gpu()
    stems = {s.lower(): cache_dir / f"{names[s]}.wav" for s in (primary, secondary)}
    voc = stems.get("vocals")
    other = next((p for name, p in stems.items() if name != "vocals"), None)
    if voc is None or other is None or not voc.exists() or not other.exists():
        raise RuntimeError(f"分离结果不完整：{list(stems)}")
    voc.replace(vocals)
    other.replace(inst)
    # 只留最近 30 首的分离结果
    olds = sorted(cache_dir.glob("*.wav"), key=lambda p: p.stat().st_mtime)
    for p in olds[:-60]:
        p.unlink(missing_ok=True)
    return vocals, inst


def frame_rms(mono: np.ndarray, sr: int, hop_sec: float = 0.5) -> np.ndarray:
    hop = int(sr * hop_sec)
    n = len(mono) // hop
    if n == 0:
        return np.zeros(1)
    frames = mono[: n * hop].reshape(n, hop)
    return np.sqrt((frames**2).mean(axis=1) + 1e-12)


def pick_segment(vocals: np.ndarray, sr: int, part: str, at: float | None, length: float) -> tuple[float, float]:
    """在人声上选一段 [start, end) 秒"""
    mono = vocals.mean(axis=1) if vocals.ndim > 1 else vocals
    total = len(mono) / sr
    length = min(length, total)
    hop = 0.5
    rms = frame_rms(mono, sr, hop)
    loud = np.percentile(rms, 95) if rms.size else 0
    if part == "at" and at is not None:
        start = max(0.0, min(float(at), total - length))
    elif part == "start":
        voiced = np.nonzero(rms > loud * 0.2)[0]
        start = max(0.0, (voiced[0] * hop - 1.0) if voiced.size else 0.0)
        start = min(start, total - length)
    else:
        # 副歌：跳过前 20 秒（太短的歌不跳），找人声能量总和最大的窗口
        win = max(1, int(length / hop))
        skip = int(20 / hop) if total > length + 40 else 0
        last = len(rms) - win
        if last <= skip:
            start = max(0.0, (total - length) / 2)
        else:
            sums = np.convolve(rms, np.ones(win), mode="valid")
            best = skip + int(np.argmax(sums[skip : last + 1]))
            # 往前 4 秒内找最安静的地方开始，避免从半句开头
            lo = max(0, best - int(4 / hop))
            quiet = lo + int(np.argmin(rms[lo : best + 1]))
            start = quiet * hop
    return start, min(total, start + length)


def median_pitch(mono: np.ndarray, sr: int) -> float | None:
    """有声部分的音高中位数（Hz）"""
    import librosa

    y = librosa.resample(mono.astype(np.float32), orig_sr=sr, target_sr=16000)
    f0 = librosa.yin(y, fmin=70, fmax=1000, sr=16000, frame_length=1024)
    rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=256)[0][: len(f0)]
    voiced = f0[: len(rms)][rms > np.percentile(rms, 60)]
    return float(np.median(voiced)) if voiced.size else None


def to_stereo(x: np.ndarray) -> np.ndarray:
    return np.stack([x, x], axis=1) if x.ndim == 1 else x


def sing(req: dict) -> dict:
    audio = Path(req["audio"])
    cache_dir = Path(req["cache_dir"])
    work = CACHE / "work"
    work.mkdir(parents=True, exist_ok=True)
    ffmpeg = req["ffmpeg"]
    # audio-separator 直接调 PATH 里的 ffmpeg，本机不一定装了，用网关带的那份
    ff_dir = str(Path(ffmpeg).parent)
    if ff_dir not in os.environ.get("PATH", "").split(os.pathsep):
        os.environ["PATH"] = ff_dir + os.pathsep + os.environ.get("PATH", "")

    t0 = time.time()
    vocals_path, inst_path = separate(audio, cache_dir)
    t1 = time.time()
    vocals, sr = sf.read(vocals_path, always_2d=True)
    inst, sr2 = sf.read(inst_path, always_2d=True)
    if sr2 != sr:
        raise RuntimeError("人声和伴奏采样率不一致")
    start, end = pick_segment(vocals, sr, req.get("part", "chorus"), req.get("at"), float(req.get("length", 60)))
    a, b = int(start * sr), int(end * sr)
    seg_vocals, seg_inst = vocals[a:b], inst[a:b]

    transpose = int(req.get("transpose", 0))
    if req.get("auto_transpose", True):
        hz = median_pitch(seg_vocals.mean(axis=1), sr)
        log(f"原唱音高中位数 {hz and round(hz)} Hz")
        if hz is not None and hz < LOW_VOICE_HZ:
            transpose += 12

    tag = f"{int(time.time() * 1000)}"
    seg_in = work / f"{tag}-vocals.wav"
    seg_out = work / f"{tag}-converted.wav"
    sf.write(seg_in, seg_vocals, sr)
    converter().convert_audio(
        audio_input_path=str(seg_in),
        audio_output_path=str(seg_out),
        model_path=req["model"],
        index_path=req.get("index") or "",
        pitch=transpose,
        f0_method="rmvpe",
        index_rate=float(req.get("index_rate", 0.5)),
        volume_envelope=1.0,
        protect=float(req.get("protect", 0.33)),
        embedder_model="contentvec",
    )
    free_gpu()
    t2 = time.time()

    # 混音：换好的人声加一点混响，伴奏压低 2 dB
    import librosa
    from pedalboard import Pedalboard, Reverb

    conv, csr = sf.read(seg_out, always_2d=False)
    if conv.ndim > 1:
        conv = conv.mean(axis=1)
    if csr != sr:
        conv = librosa.resample(conv.astype(np.float32), orig_sr=csr, target_sr=sr)
    n = min(len(conv), len(seg_inst))
    voice = Pedalboard([Reverb(room_size=0.15, wet_level=0.2, dry_level=0.8, damping=0.7)])(conv[:n].astype(np.float32), sr)
    mix = to_stereo(voice) + seg_inst[:n] * (10 ** (-2 / 20))
    peak = np.abs(mix).max()
    if peak > 0.99:
        mix = mix * (0.99 / peak)
    mixed = work / f"{tag}-mix.wav"
    sf.write(mixed, mix.astype(np.float32), sr)

    # 淡入淡出 + 响度统一；输出 24 kHz 单声道 wav：QQ 适配器只能把这种 wav 直接转成 silk（和 TTS 一样），mp3 发不出去
    dur = n / sr
    fade = min(1.5, dur / 4)
    out = Path(req["out"])
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-i", str(mixed),
         "-af", f"afade=t=in:st=0:d={fade},afade=t=out:st={max(0, dur - fade)}:d={fade},loudnorm=I=-16:TP=-1.5:LRA=11",
         "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", str(out)],
        check=True,
    )
    for p in (seg_in, seg_out, mixed):
        p.unlink(missing_ok=True)
    log(f"分离 {t1 - t0:.1f}s，换音色 {t2 - t1:.1f}s，混音 {time.time() - t2:.1f}s")
    return {"ok": True, "start": round(start, 1), "end": round(end, 1), "transpose": transpose}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code: int, body: dict):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"ok": True})
        self.reply(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        global last_used
        if self.path != "/sing":
            return self.reply(404, {"ok": False, "error": "not found"})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)))
            with lock:
                last_used = time.time()
                result = sing(req)
                last_used = time.time()
            self.reply(200, result)
        except Exception as e:
            traceback.print_exc()
            msg = str(e)
            if "out of memory" in msg.lower():
                msg = "显卡被占满了，等会儿再唱"
            self.reply(200, {"ok": False, "error": msg[:300]})
            free_gpu()


def idle_watch(idle: int):
    while True:
        time.sleep(15)
        if not lock.locked() and time.time() - last_used > idle:
            log(f"空闲 {idle} 秒，退出")
            os._exit(0)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=5141)
    p.add_argument("--idle", type=int, default=600)
    args = p.parse_args()
    threading.Thread(target=idle_watch, args=(args.idle,), daemon=True).start()
    server = HTTPServer(("127.0.0.1", args.port), Handler)
    log(f"翻唱进程就绪 127.0.0.1:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()

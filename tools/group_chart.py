"""群聊统计条形图：group_stats 工具调用，画好的 PNG 随回复一起发到 QQ（模型看不到这张图）。

输入（stdin，JSON）：
  title, subtitle, footer        标题、副标题、底注
  top: [{name, count}]           发言前五（横向条形）
  buckets: [{label, count}]      各时段消息量（竖向柱形：按天 24 小时 / 按周 7 天）
  bucketTitle                    柱形图小标题
  tickEvery                      x 轴每隔几个柱子标一次（24 小时用 6）
  out                            输出 PNG 路径
用法：python tools/group_chart.py < data.json
"""
import json
import math
import sys

from PIL import Image, ImageDraw, ImageFont

S = 2  # 按 2 倍像素画，手机上看着清楚
W = 540
PAD = 24
FONT = r'C:\Windows\Fonts\msyh.ttc'
FONT_BOLD = r'C:\Windows\Fonts\msyhbd.ttc'

# 和看板一致的浅色主题；单一系列只用一种蓝
SURFACE = '#ffffff'
TEXT = '#1b2430'
MUTED = '#6b7685'
GRID = '#e6e9ee'
BAR = '#2a64c5'


def font(size, bold=False):
    try:
        return ImageFont.truetype(FONT_BOLD if bold else FONT, size * S)
    except OSError:
        return ImageFont.truetype(r'C:\Windows\Fonts\simhei.ttf', size * S)


def nice_max(v):
    """坐标轴上限取整到 1/2/5 × 10^n"""
    if v <= 0:
        return 1
    exp = 10 ** math.floor(math.log10(v))
    for m in (1, 2, 5, 10):
        if v <= m * exp:
            return m * exp
    return 10 * exp


def bar_h(d, x0, y0, x1, y1):
    """横向条：右端 4px 圆角，左端（基线）方角"""
    r = min(4 * S, (x1 - x0) // 2, (y1 - y0) // 2)
    d.rounded_rectangle((x0, y0, x1, y1), radius=r, fill=BAR)
    d.rectangle((x0, y0, min(x0 + r, x1), y1), fill=BAR)


def bar_v(d, x0, y0, x1, y1):
    """竖向柱：顶端 4px 圆角，底端（基线）方角"""
    r = min(4 * S, (x1 - x0) // 2, (y1 - y0) // 2)
    d.rounded_rectangle((x0, y0, x1, y1), radius=r, fill=BAR)
    d.rectangle((x0, max(y1 - r, y0), x1, y1), fill=BAR)


def fit(d, text, f, width):
    """太长的名字截断加省略号"""
    if d.textlength(text, font=f) <= width:
        return text
    while text and d.textlength(text + '…', font=f) > width:
        text = text[:-1]
    return text + '…'


def main():
    # 中文 Windows 上 stdin 默认按 GBK 解码，会把 UTF-8 的中文读成乱码，这里直接按字节读
    data = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    top = data.get('top') or []
    buckets = data.get('buckets') or []

    f_title, f_sub, f_label, f_small = font(17, True), font(12), font(13), font(11)
    row, name_w = 30, 120
    plot_h = 150
    h = PAD + 26 + 20 + 18  # 标题 + 副标题 + 间距
    if top:
        h += 22 + row * len(top) + 14
    if buckets:
        h += 22 + plot_h + 26 + 10
    h += 22 + PAD  # 底注

    img = Image.new('RGB', (W * S, h * S), SURFACE)
    d = ImageDraw.Draw(img)
    y = PAD
    d.text((PAD * S, y * S), data.get('title', ''), font=f_title, fill=TEXT)
    y += 28
    d.text((PAD * S, y * S), data.get('subtitle', ''), font=f_sub, fill=MUTED)
    y += 20 + 18

    if top:
        d.text((PAD * S, y * S), '发言前五', font=f_label, fill=TEXT)
        y += 22
        vmax = max(t['count'] for t in top)
        x_base = PAD + name_w
        value_room = 56  # 条形末端的数值标签
        span = W - PAD - x_base - value_room
        for t in top:
            cy = y + row / 2
            d.text((PAD * S, cy * S), fit(d, t['name'] or '某人', f_label, (name_w - 10) * S), font=f_label, fill=TEXT, anchor='lm')
            length = max(span * t['count'] / vmax, 3)
            thick = 16  # 不超过 24px，留出呼吸感
            bar_h(d, x_base * S, int((cy - thick / 2) * S), int((x_base + length) * S), int((cy + thick / 2) * S))
            d.text(((x_base + length + 6) * S, cy * S), f"{t['count']} 条", font=f_small, fill=MUTED, anchor='lm')
            y += row
        y += 14

    if buckets:
        d.text((PAD * S, y * S), data.get('bucketTitle', '各时段消息量'), font=f_label, fill=TEXT)
        y += 22
        counts = [b['count'] for b in buckets]
        vmax = nice_max(max(counts))
        axis_w = 30
        x0, x1 = PAD + axis_w, W - PAD
        top_y, base_y = y + 8, y + plot_h
        # 网格线：0 / 一半 / 上限，1px 实线
        for i in range(3):
            v = vmax * i / 2
            gy = base_y - (base_y - top_y) * i / 2
            d.line((x0 * S, gy * S, x1 * S, gy * S), fill=GRID, width=1 * S)
            label = f'{v:g}' if v < 1000 else f'{v / 1000:g}K'
            d.text(((x0 - 6) * S, gy * S), label, font=f_small, fill=MUTED, anchor='rm')
        slot = (x1 - x0) / len(buckets)
        thick = min(24, slot - 4)  # 柱子之间至少留 4px 空隙
        peak = counts.index(max(counts))
        every = data.get('tickEvery') or 1
        for i, b in enumerate(buckets):
            cx = x0 + slot * (i + 0.5)
            if b['count']:
                bh = max((base_y - top_y) * b['count'] / vmax, 2)
                bar_v(d, int((cx - thick / 2) * S), int((base_y - bh) * S), int((cx + thick / 2) * S), int(base_y * S))
                if i == peak:  # 只标最高的那根
                    d.text((cx * S, (base_y - bh - 4) * S), str(b['count']), font=f_small, fill=TEXT, anchor='ms')
            if i % every == 0 or i == len(buckets) - 1 and every == 1:
                d.text((cx * S, (base_y + 6) * S), b['label'], font=f_small, fill=MUTED, anchor='mt')
        y = base_y + 26 + 10

    d.text((PAD * S, (h - PAD - 4) * S), data.get('footer', ''), font=f_small, fill=MUTED, anchor='ls')
    img.save(data['out'], optimize=True)
    print(data['out'])


if __name__ == '__main__':
    main()

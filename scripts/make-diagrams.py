#!/usr/bin/env python3
"""Generate Writer's architecture diagrams as light/dark SVG pairs.

One source of truth for both themes: run `python3 scripts/make-diagrams.py`
after editing, and commit the regenerated files in docs/.
"""
import os

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'docs')

THEMES = {
    'light': dict(
        canvas='#f2efe9', panel='#fffdf9', ink='#1c1b18', soft='#6f6a60',
        faint='#a39d90', line='#d8d2c6', seal='#b3432b', chip='#faf7f1',
        accent_bg='#fdf4f1',
    ),
    'dark': dict(
        canvas='#131210', panel='#1d1b17', ink='#e8e3d7', soft='#a49d8e',
        faint='#7d7565', line='#39352d', seal='#c05b45', chip='#242119',
        accent_bg='#251c19',
    ),
}

UI = ("-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', "
      "'Hiragino Sans GB', 'Microsoft YaHei', sans-serif")
MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"


def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


class Svg:
    def __init__(self, w, h, t):
        self.w, self.h, self.t = w, h, t
        self.parts = []

    def rect(self, x, y, w, h, fill=None, stroke=None, rx=10, dash=None, sw=1):
        f = fill or 'none'
        s = f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ''
        d = f' stroke-dasharray="{dash}"' if dash else ''
        self.parts.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{f}"{s}{d}/>')

    def text(self, x, y, s, size=14, fill=None, weight=400, anchor='start',
             font=UI, spacing=None, opacity=None):
        fill = fill or self.t['ink']
        ls = f' letter-spacing="{spacing}"' if spacing else ''
        op = f' opacity="{opacity}"' if opacity else ''
        self.parts.append(
            f'<text x="{x}" y="{y}" font-family="{font}" font-size="{size}" '
            f'font-weight="{weight}" fill="{fill}" text-anchor="{anchor}"{ls}{op}>{esc(s)}</text>')

    def line(self, x1, y1, x2, y2, stroke=None, sw=1.4, dash=None, marker=True):
        stroke = stroke or self.t['faint']
        d = f' stroke-dasharray="{dash}"' if dash else ''
        m = ' marker-end="url(#arrow)"' if marker else ''
        self.parts.append(
            f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{stroke}" '
            f'stroke-width="{sw}" stroke-linecap="round"{d}{m}/>')

    def path(self, d, stroke=None, sw=1.4, dash=None, marker=True, fill='none'):
        stroke = stroke or self.t['faint']
        da = f' stroke-dasharray="{dash}"' if dash else ''
        m = ' marker-end="url(#arrow)"' if marker else ''
        self.parts.append(
            f'<path d="{d}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}" '
            f'stroke-linecap="round"{da}{m}/>')

    def vlabel(self, x, cy, s, size=12):
        """Tier label set vertically along the left margin, so it can never
        collide with the arrows crossing between tiers."""
        self.parts.append(
            f'<text transform="rotate(-90 {x} {cy})" x="{x}" y="{cy}" '
            f'font-family="{UI}" font-size="{size}" fill="{self.t["faint"]}" '
            f'text-anchor="middle" letter-spacing="0.16em">{esc(s)}</text>')

    def render(self):
        t = self.t
        return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" width="{self.w}" height="{self.h}" role="img">
<defs>
<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
<path d="M 0 1 L 9 5 L 0 9 z" fill="{t['faint']}"/>
</marker>
<marker id="arrow-seal" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
<path d="M 0 1 L 9 5 L 0 9 z" fill="{t['seal']}"/>
</marker>
</defs>
<rect width="{self.w}" height="{self.h}" fill="{t['canvas']}"/>
{chr(10).join(self.parts)}
</svg>
'''


def box(s, x, y, w, h, title, sub=None, mono_title=False, accent=False, note=None):
    t = s.t
    s.rect(x, y, w, h, fill=t['accent_bg'] if accent else t['panel'],
           stroke=t['seal'] if accent else t['line'])
    cy = y + (h / 2 + 5 if not sub else h / 2 - 4)
    s.text(x + 18, cy, title, size=14.5, weight=500,
           font=MONO if mono_title else UI, fill=t['seal'] if accent else t['ink'])
    if sub:
        s.text(x + 18, y + h / 2 + 17, sub, size=12.5, fill=t['soft'])
    if note:
        s.text(x + w - 18, y + h / 2 + 5, note, size=12.5, fill=t['faint'], anchor='end')


# --------------------------------------------------------------- diagram 1

def architecture(theme):
    t = THEMES[theme]
    s = Svg(980, 620, t)
    X, W = 80, 840          # tier container
    IX, IW = 110, 780       # inner content

    def group(y, h, label):
        s.rect(X, y, W, h, fill='none', stroke=t['line'], rx=14, dash='5 5')
        s.vlabel(50, y + h / 2, label)

    # Tier 1 — browser
    group(54, 132, '浏览器')
    bw = (IW - 2 * 30) // 3
    for i, (title, sub) in enumerate([
        ('编辑器  /', 'A4 画布 · 自动保存 · 幽灵补全'),
        ('归档  /archive', '分类陈列 · 关键词检索'),
        ('阅读  /d/:id', '排版正文 · 决策轨迹 · 下载'),
    ]):
        box(s, IX + i * (bw + 30), 90, bw, 72, title, sub)

    cols = [IX + bw // 2, IX + bw + 30 + bw // 2, IX + 2 * (bw + 30) + bw // 2]

    # Tier 1 -> 2
    for x, label in zip(cols, ('保存 / 补全', '列表 / 检索', '服务端渲染')):
        s.line(x, 186, x, 232)
        s.text(x + 12, 213, label, size=12, fill=t['faint'])

    # Tier 2 — worker
    group(236, 128, 'Cloudflare Worker')
    s.text(X + W - 20, 357, 'writer.genedai.md', size=11.5, fill=t['faint'],
           anchor='end', font=MONO)
    cw = (IW - 3 * 20) // 4
    for i, (title, sub) in enumerate([
        ('API 路由', '文档 CRUD · 检索'),
        ('访问控制', '可选密钥 · 常量比较'),
        ('Markdown SSR', '零依赖渲染器'),
        ('Cron 认领', '每 10 分钟巡检'),
    ]):
        box(s, IX + i * (cw + 20), 272, cw, 68, title, sub)

    # Tier 2 -> 3
    for x in cols:
        s.line(x, 364, x, 412)
    s.text(cols[1] + 12, 392, '读写 / 调用 / 派发', size=12, fill=t['faint'])

    # Tier 3 — platform
    group(416, 140, '数据与计算')
    specs = [
        ('D1', '文档目录 · 状态 · 检索', False),
        ('R2', 'Markdown 文件空间', False),
        ('Workers AI', 'Qwen3 输入补全', False),
        ('Workflows', '归档 Agent 流水线', True),
    ]
    xs = []
    for i, (title, sub, accent) in enumerate(specs):
        x = IX + i * (cw + 20)
        xs.append(x)
        box(s, x, 452, cw, 72, title, sub, accent=accent)

    # The agent writes the finished document back into D1 and R2.
    wf_x, d1_x = xs[3] + cw / 2, xs[0] + cw / 2
    s.path(f'M {wf_x} 524 L {wf_x} 566 L {d1_x} 566 L {d1_x} 528',
           stroke=t['seal'], dash='4 4')
    s.parts[-1] = s.parts[-1].replace('url(#arrow)', 'url(#arrow-seal)')
    s.text((wf_x + d1_x) / 2, 587, 'Agent 写回目录与文件', size=12,
           fill=t['seal'], anchor='middle')

    return s.render()


# --------------------------------------------------------------- diagram 2

def agent(theme):
    t = THEMES[theme]
    s = Svg(980, 760, t)

    # What starts a run
    for i, label in enumerate(['点击「完成」 / ⌘⏎', '静置 5 分钟', 'Cron 认领遗留草稿']):
        x = 110 + i * 260
        s.rect(x, 30, 230, 46, fill=t['chip'], stroke=t['line'], rx=23)
        s.text(x + 115, 58, label, size=13, fill=t['soft'], anchor='middle')
        s.line(x + 115, 76, x + 115, 112)

    # Workflow container
    s.rect(90, 116, 800, 572, fill=t['panel'], stroke=t['line'], rx=16)
    s.text(118, 148, 'WriterPipeline', size=14.5, weight=500, font=MONO)
    s.text(258, 148, '· Workflow 实例（每篇文档一个，可断点续跑）', size=12.5, fill=t['soft'])

    sx, sw_ = 122, 736
    flow_x = sx + 60

    box(s, sx, 172, sw_, 46, 'step  load-document', mono_title=True,
        note='从 D1 读取草稿')
    s.line(flow_x, 218, flow_x, 236)

    # The reasoning loop
    s.rect(sx, 238, sw_, 302, fill=t['accent_bg'], stroke=t['seal'], rx=12)
    s.text(sx + 18, 266, 'step  agent-turn ×N', size=14.5, weight=500,
           font=MONO, fill=t['seal'])
    s.text(sx + sw_ - 18, 266, '每轮都是一个独立重试的 step', size=12.5,
           fill=t['faint'], anchor='end')

    # Model
    mx, mcx = sx + 30, sx + 155
    s.rect(mx, 292, 250, 84, fill=t['panel'], stroke=t['line'], rx=10)
    s.text(mcx, 320, 'Kimi K2.6', size=15, weight=500, anchor='middle')
    s.text(mcx, 341, '262k 上下文 · 原生工具调用', size=12, fill=t['soft'], anchor='middle')
    s.text(mcx, 362, '不可用时自动降级 Qwen3', size=11.5, fill=t['faint'], anchor='middle')

    # Tools
    tools = [
        ('list_categories', '查看现有分类体系，保持归类一致'),
        ('search_archive', '检索相似旧文作参考'),
        ('finish', '提交 标题 / 分类 / 标签 / 摘要 / 排版'),
    ]
    tx, tw = sx + 420, 286
    for i, (name, desc) in enumerate(tools):
        y = 286 + i * 54
        last = i == len(tools) - 1
        s.rect(tx, y, tw, 46, fill=t['panel'],
               stroke=t['seal'] if last else t['line'], rx=10)
        s.text(tx + 16, y + 20, name, size=13, weight=500, font=MONO,
               fill=t['seal'] if last else t['ink'])
        s.text(tx + 16, y + 36, desc, size=11, fill=t['soft'])
        s.path(f'M {mx + 254} 334 C {mx + 310} 334, {mx + 320} {y + 23}, {tx - 8} {y + 23}')

    # Results feed back into the next turn
    s.path(f'M {tx + tw / 2} 448 C {tx + tw / 2} 492, {mcx} 492, {mcx} 382')
    s.text(mcx + 150, 512, '工具结果回填后继续推理，最多 6 轮，直到调用 finish',
           size=12, fill=t['faint'], anchor='middle')

    s.line(flow_x, 540, flow_x, 558)
    box(s, sx, 560, sw_, 46, 'step  persist', mono_title=True,
        note='写回 D1 · 校验兜底 · 保存决策轨迹')
    s.line(flow_x, 606, flow_x, 624)
    box(s, sx, 626, sw_, 46, 'step  store-file', mono_title=True,
        note='镜像为 R2 中的 Markdown 文件')

    s.text(490, 722,
           '任一步骤失败自动重试并从断点续跑 · Agent 整体失败退回启发式归档 · 用户内容永不丢失',
           size=12.5, fill=t['soft'], anchor='middle')

    return s.render()


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for name, fn in (('architecture', architecture), ('agent', agent)):
        for theme in THEMES:
            path = os.path.join(OUT, f'{name}-{theme}.svg')
            with open(path, 'w') as f:
                f.write(fn(theme))
            print('wrote', os.path.relpath(path, os.path.dirname(OUT)))

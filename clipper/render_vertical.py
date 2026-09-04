#!/usr/bin/env python3
"""Lay a full 16:9 clip out on a 9:16 canvas, itech.cuts style.

The whole source frame stays visible (no crop). Behind it sits a blurred,
darkened copy of the same footage. A headline sits in the band above the
video and captions sit in the band below it, both inside the middle of the
screen so app UI (description, buttons, profile) never covers them.

Text is rendered with Pillow into transparent PNGs and composited with
ffmpeg's overlay filter, so it works with any ffmpeg build (no drawtext
needed).

Usage:
  python render_vertical.py in.mp4 out.mp4 --headline "TEXT" [--sub "TEXT"]
                            [--captions captions.txt] [--brand "@itech.cuts"]

captions.txt: one caption per line, START END TEXT (seconds)
  0.0 2.4 First Cybercab ride. Let's go.
"""

import argparse
import subprocess
import tempfile
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1920
VIDEO_H = 608                       # 1080 x 608 is 16:9
VIDEO_Y = (H - VIDEO_H) // 2        # 656, centred vertically
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
GOLD = (255, 210, 63, 255)
WHITE = (255, 255, 255, 255)


def ffmpeg_bin():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return "ffmpeg"


def text_png(lines, size, path, font=FONT_BOLD, color=WHITE, stroke=6,
             gap=12, box=False):
    """Render centred lines of text onto a transparent full-width PNG."""
    f = ImageFont.truetype(font, size)
    lh = size + gap
    h = lh * len(lines) + 2 * stroke + (48 if box else 0)
    img = Image.new("RGBA", (W, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if box:
        d.rounded_rectangle([40, 0, W - 40, h], radius=24, fill=(0, 0, 0, 140))
    y = stroke + (24 if box else 0)
    for line in lines:
        tw = d.textlength(line, font=f)
        d.text(((W - tw) / 2, y), line, font=f, fill=color,
               stroke_width=stroke, stroke_fill=(0, 0, 0, 220))
        y += lh
    img.save(path)
    return h


def read_captions(path):
    caps = []
    if not path:
        return caps
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        raw = raw.strip()
        if not raw or raw.startswith("#"):
            continue
        a, b, text = raw.split(None, 2)
        caps.append((float(a), float(b), text))
    return caps


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src"); ap.add_argument("out")
    ap.add_argument("--headline", required=True)
    ap.add_argument("--sub", default="")
    ap.add_argument("--captions", help="captions.txt: START END TEXT per line")
    ap.add_argument("--brand", default="@itech.cuts")
    ap.add_argument("--already-vertical", action="store_true",
                    help="source is already 1080x1920 with the 16:9 frame centred "
                         "(e.g. vidIQ output); only add the text overlays")
    a = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="render_"))
    overlays = []   # (png path, y, enable-expression or None)

    # Headline: big gold, up to 3 lines, sitting just above the video.
    head_lines = textwrap.wrap(a.headline.upper(), 18)[:3]
    p = tmp / "head.png"
    h = text_png(head_lines, 84, p, color=GOLD)
    head_y = VIDEO_Y - 48 - h
    overlays.append((p, head_y, None))

    # Sub line: smaller white, above the headline.
    if a.sub:
        p = tmp / "sub.png"
        h = text_png(textwrap.wrap(a.sub, 36)[:2], 44, p, font=FONT, stroke=4)
        overlays.append((p, head_y - 24 - h, None))

    # Captions: below the video, still in the middle band.
    for i, (start, end, text) in enumerate(read_captions(a.captions)):
        p = tmp / f"cap{i:03d}.png"
        text_png(textwrap.wrap(text, 26)[:2], 62, p)
        overlays.append((p, VIDEO_Y + VIDEO_H + 56, f"between(t,{start},{end})"))

    if a.brand:
        p = tmp / "brand.png"
        text_png([a.brand], 40, p, font=FONT, color=(255, 255, 255, 220), stroke=3)
        overlays.append((p, H - 330, None))

    # Filter graph: blurred cover background + full-frame foreground + overlays.
    inputs = ["-i", a.src]
    for p, _, _ in overlays:
        inputs += ["-i", str(p)]
    if a.already_vertical:
        graph = [f"[0:v]scale={W}:{H}[v0]"]
    else:
        graph = [
            f"[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
            f"boxblur=30:6,eq=brightness=-0.25[bg]",
            f"[0:v]scale={W}:-2[fg]",
            "[bg][fg]overlay=(W-w)/2:(H-h)/2[v0]",
        ]
    for i, (_, y, enable) in enumerate(overlays, start=1):
        en = f":enable='{enable}'" if enable else ""
        graph.append(f"[v{i-1}][{i}:v]overlay=0:{y}{en}[v{i}]")
    last = f"[v{len(overlays)}]"

    cmd = [ffmpeg_bin(), "-y", *inputs, "-filter_complex", ";".join(graph),
           "-map", last, "-map", "0:a?", "-c:v", "libx264", "-preset", "medium",
           "-crf", "19", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
           "-movflags", "+faststart", a.out]
    print("  $ ffmpeg ... ->", a.out)
    subprocess.run(cmd, check=True, capture_output=True)
    print("wrote", a.out)


if __name__ == "__main__":
    main()

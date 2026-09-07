"""Remove the bottom-left 'AI生成' watermark by mirroring the clean
bottom-right corner patch onto it. Saves cleaned copies to branding/clean/."""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).parent
OUT = ROOT / "clean"
OUT.mkdir(exist_ok=True)

FILES = [
    "concept-retro-badge.png",
    "series-retro-reading.png",
    "series-retro-tea.png",
    "series-retro-hello.png",
    "series-retro-sleep.png",
]

# watermark occupies roughly x 0-120, y 955-1024 in a 1024px image; use a
# slightly larger patch to be safe
PATCH_W, PATCH_H = 170, 90

for name in FILES:
    img = Image.open(ROOT / name).convert("RGB")
    w, h = img.size
    pw = min(PATCH_W, w // 2)
    ph = min(PATCH_H, h // 2)
    # clean patch from bottom-right corner, mirrored horizontally so any
    # paper gradient/vignette direction matches the left side
    patch = img.crop((w - pw, h - ph, w, h)).transpose(Image.FLIP_LEFT_RIGHT)
    img.paste(patch, (0, h - ph))
    out = OUT / name
    img.save(out)
    print(f"cleaned -> {out}")

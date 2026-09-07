"""Derive web favicon sizes and in-app brand assets from the cleaned retro
badge series. Outputs:
  public/favicon.png (32)  public/apple-touch-icon.png (180)
  src/assets/brand/panda-badge.png (256)  panda-hello/tea/reading/sleep.png (512)
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
CLEAN = ROOT / "branding" / "clean"
PUBLIC = ROOT / "public"
ASSETS = ROOT / "src" / "assets" / "brand"
ASSETS.mkdir(parents=True, exist_ok=True)

badge = Image.open(CLEAN / "concept-retro-badge.png").convert("RGB")
w, h = badge.size
# Crop tight to the circular badge: the outer ring sits ~2% from each edge.
inset = round(w * 0.028)
square = badge.crop((inset, inset, w - inset, h - inset))

square.resize((32, 32), Image.LANCZOS).save(PUBLIC / "favicon.png")
square.resize((180, 180), Image.LANCZOS).save(PUBLIC / "apple-touch-icon.png")
square.resize((256, 256), Image.LANCZOS).save(ASSETS / "panda-badge.png")

for name in ["hello", "tea", "reading", "sleep"]:
    src = Image.open(CLEAN / f"series-retro-{name}.png").convert("RGB")
    src.resize((512, 512), Image.LANCZOS).save(ASSETS / f"panda-{name}.png")

print("favicon.png, apple-touch-icon.png -> public/")
print("panda-badge/hello/tea/reading/sleep.png -> src/assets/brand/")

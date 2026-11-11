"""Render store assets with headless Chrome + Pillow (dev-only, not part of the extension).

    python webstore/render.py            # icons -> public/icon/*.png, promo -> webstore/promo-440x280.png
    python webstore/render.py --check    # also write a preview sheet to webstore/out/preview.png

Needs: Google Chrome, Python 3, Pillow (pip install pillow).
"""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "webstore"
OUT = WEB / "out"
ICONS = ROOT / "public" / "icon"

CHROME_CANDIDATES = [
    os.environ.get("CHROME", ""),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    shutil.which("google-chrome") or "",
    shutil.which("chromium") or "",
]


def chrome() -> str:
    for c in CHROME_CANDIDATES:
        if c and Path(c).exists():
            return c
    sys.exit("Chrome not found; set CHROME=/path/to/chrome")


def shot(src: Path, w: int, h: int, dest: Path, profile: str) -> Image.Image:
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [chrome(), "--headless=new", "--disable-gpu", "--hide-scrollbars",
         "--default-background-color=00000000", f"--user-data-dir={profile}",
         f"--window-size={w},{h}", f"--screenshot={dest}", src.as_uri()],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    img = Image.open(dest).convert("RGBA")
    if img.size != (w, h):
        sys.exit(f"{src.name}: expected {w}x{h}, got {img.size}")
    return img


def main() -> None:
    OUT.mkdir(exist_ok=True)
    ICONS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as profile:
        big = shot(WEB / "icon.svg", 512, 512, OUT / "icon-512.png", profile)
        small = shot(WEB / "icon-small.svg", 512, 512, OUT / "icon-small-512.png", profile)
        tiny = shot(WEB / "icon-16.svg", 512, 512, OUT / "icon-16-512.png", profile)
        big.resize((128, 128), Image.LANCZOS).save(ICONS / "128.png")
        for size in (48, 32):
            small.resize((size, size), Image.LANCZOS).save(ICONS / f"{size}.png")
        tiny.resize((16, 16), Image.BOX).save(ICONS / "16.png")
        shot(WEB / "promo-440x280.html", 440, 280, OUT / "promo-raw.png", profile).convert("RGB").save(WEB / "promo-440x280.png")

    if "--check" in sys.argv:
        sheet = Image.new("RGBA", (128 + 48 + 32 + 16 + 50, 140), (255, 255, 255, 255))
        x = 10
        for size in (128, 48, 32, 16):
            im = Image.open(ICONS / f"{size}.png")
            sheet.alpha_composite(im, (x, 6))
            x += size + 10
        sheet.save(OUT / "preview.png")
    print("icons:", sorted(p.name for p in ICONS.iterdir()))
    print("out:", sorted(p.name for p in OUT.iterdir()))


if __name__ == "__main__":
    main()

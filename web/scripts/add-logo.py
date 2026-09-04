#!/usr/bin/env python3
"""Put a brand logo into the app, whatever format it arrived in.

    python3 scripts/add-logo.py <file> [match-key]

App Store and web downloads turn up as AVIF, WEBP, HEIC or PNG depending on where
they came from, and only some of those are safe to ship. This normalises anything
raster to a PNG capped at 512px (alpha kept), passes SVG through untouched, drops
it in public/logos, and adds the BUNDLED_LOGOS entry in src/lib/tokens.ts so the
badge picks it up with no field to fill in.

The match key is what gets looked for inside the lowercased campaign name, so
"bounty" matches the campaign actually called "Regen (Bounty)". It defaults to the
file's own name.

Safe to run twice: an existing entry for the same key is left alone.
"""
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOGOS = ROOT / "public" / "logos"
TOKENS = ROOT / "src" / "lib" / "tokens.ts"
MAX_EDGE = 512


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def normalise(src: Path, key: str) -> str:
    """Write the logo into public/logos and return its public path."""
    LOGOS.mkdir(parents=True, exist_ok=True)

    if src.suffix.lower() == ".svg":
        out = LOGOS / f"{key}.svg"
        shutil.copyfile(src, out)
        return f"/logos/{out.name}"

    try:
        from PIL import Image
    except ImportError:
        sys.exit("Pillow is needed to convert a raster logo: python3 -m pip install pillow")

    try:
        im = Image.open(src)
    except Exception as e:  # noqa: BLE001 - the message matters more than the type
        sys.exit(
            f"Could not read {src.name}: {e}\n"
            "If it is AVIF or HEIC, this needs Pillow 11.3 or newer."
        )

    # keep transparency where there is any, so a mark on a dark badge still works
    im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
    if max(im.size) > MAX_EDGE:
        im.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)

    out = LOGOS / f"{key}.png"
    im.save(out, "PNG", optimize=True)
    print(f"wrote {out.relative_to(ROOT)}  {im.size[0]}x{im.size[1]}  {out.stat().st_size // 1024}kb")
    return f"/logos/{out.name}"


def register(key: str, public_path: str) -> None:
    s = TOKENS.read_text()
    if f"match: '{key}'" in s:
        print(f"tokens.ts already matches '{key}', left as is")
        return

    anchor = "const BUNDLED_LOGOS: Logo[] = [\n"
    if anchor not in s:
        sys.exit("Could not find BUNDLED_LOGOS in src/lib/tokens.ts, add the entry by hand")

    # An app icon is square and should fill the badge, letting the circle crop it;
    # a wordmark is wide and has to be contained or its ends get cut off. Raster
    # downloads are nearly always the icon, SVGs nearly always the wordmark, so
    # that is the guess. Flip `fit` by hand if a logo comes out wrong.
    fit = "contain" if public_path.endswith(".svg") else "cover"
    s = s.replace(anchor, f"{anchor}  {{ match: '{key}', src: '{public_path}', fit: '{fit}' }},\n", 1)
    TOKENS.write_text(s)
    print(f"registered '{key}' in src/lib/tokens.ts")


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)

    src = Path(sys.argv[1]).expanduser()
    if not src.is_file():
        sys.exit(f"No such file: {src}")

    key = slug(sys.argv[2]) if len(sys.argv) > 2 else slug(src.stem)
    if not key:
        sys.exit("Could not work out a match key, pass one as the second argument")

    register(key, normalise(src, key))
    print("\nNow: npm run build && ./deploy-ugcbeasts.sh")


if __name__ == "__main__":
    main()

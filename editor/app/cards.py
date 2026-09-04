"""Generate a dating app style profile card (1080x1920) from a photo + name.

Reads like the real thing at TikTok glance speed: iPhone status bar, serif name,
rounded photo card with the like button, and a prompt card peeking from the bottom.
"""
import os

from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1080, 1920
SUPP = "/System/Library/Fonts/Supplemental"

_fonts = {}


def _font(path, size):
    key = (path, size)
    if key not in _fonts:
        _fonts[key] = ImageFont.truetype(path, size)
    return _fonts[key]


FONT_DIR = os.path.join(os.path.dirname(__file__), "..", "fonts")

# the real app's UI font is Modern Era (licensed); Inter is the closest free match
_UI_WEIGHTS = {
    "regular": ["Inter-Regular.ttf", "Arial.ttf"],
    "medium": ["Inter-Medium.ttf", "Arial.ttf"],
    "semibold": ["Inter-SemiBold.ttf", "Arial Bold.ttf"],
    "bold": ["Inter-Bold.ttf", "Arial Bold.ttf"],
}


def ui(size, weight="regular"):
    for name in _UI_WEIGHTS[weight]:
        for base in (FONT_DIR, SUPP):
            path = os.path.join(base, name)
            if os.path.exists(path):
                return _font(path, size)
    return _font(os.path.join(SUPP, "Arial.ttf"), size)


def serif(size, bold=True):
    name = "Georgia Bold.ttf" if bold else "Georgia.ttf"
    path = os.path.join(SUPP, name)
    if os.path.exists(path):
        return _font(path, size)
    return ui(size, "bold" if bold else "regular")


def sans(size, bold=False):
    return ui(size, "bold" if bold else "regular")


INK = (26, 26, 26)
GREY = (110, 110, 116)
LINE = (232, 232, 236)


def _cover(img, w, h, focus_y=0.5):
    """Cover-crop; focus_y biases which part of a tall image survives (0 = top)."""
    iw, ih = img.size
    s = max(w / iw, h / ih)
    img = img.resize((int(iw * s + 0.5), int(ih * s + 0.5)), Image.LANCZOS)
    x = (img.width - w) // 2
    y = int((img.height - h) * min(max(focus_y, 0.0), 1.0))
    return img.crop((x, y, x + w, y + h))


def _face_box(img):
    """Largest face (cx, cy, width) in a PIL image, or None. OpenCV's bundled Haar
    cascade first (offline), then a person-cutout head estimate as fallback."""
    import numpy as np
    rgb = np.array(img.convert("RGB"))
    try:
        import cv2
        cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        faces = cascade.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=6,
                                         minSize=(max(24, rgb.shape[1] // 20),) * 2)
        if len(faces):
            x, y, w, h = max(faces, key=lambda f: f[2])
            return (x + w / 2, y + h / 2, float(w))
    except Exception:
        pass
    try:
        from . import cutout
        a = cutout.person_alpha(rgb)
        ys, xs = np.where(a > 128)
        if len(ys) > 500:
            top, bot = int(ys.min()), int(ys.max())
            band = ys < top + max(20, int((bot - top) * 0.16))
            bx = xs[band]
            if len(bx):
                w = float(np.percentile(bx, 90) - np.percentile(bx, 10))
                return (float(bx.mean()), float(top + (bot - top) * 0.10), max(60.0, w))
    except Exception:
        pass
    return None


def _heart_sticker(size):
    """Glossy red heart like the emoji sticker (drawn supersampled for smooth edges)."""
    s = size * 3
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    red = (238, 34, 58, 255)
    r = s * 0.27
    d.ellipse((s * 0.05, s * 0.10, s * 0.05 + 2 * r, s * 0.10 + 2 * r), fill=red)
    d.ellipse((s * 0.95 - 2 * r, s * 0.10, s * 0.95, s * 0.10 + 2 * r), fill=red)
    d.polygon([(s * 0.062, s * 0.44), (s * 0.938, s * 0.44), (s * 0.5, s * 0.95)], fill=red)
    d.polygon([(s * 0.16, s * 0.28), (s * 0.84, s * 0.28), (s * 0.5, s * 0.62)], fill=red)
    # shine
    hl = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(hl).ellipse((s * 0.16, s * 0.17, s * 0.44, s * 0.36), fill=(255, 255, 255, 130))
    img.alpha_composite(hl.rotate(18, center=(s * 0.3, s * 0.26)))
    return img.resize((size, size), Image.LANCZOS)


def _rounded(img, radius):
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, img.width, img.height), radius=radius, fill=255)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out




def collage(paths, w=1080, h=1920, count=4, gap=0, radius=0, bg=(255, 255, 255)):
    """A grid of photos filling the frame, for a hook that shows several shots at
    once rather than one background. Lays out as square a grid as the count allows
    (4 becomes 2x2) and cover crops each cell, biased upward so faces survive."""
    n = max(1, min(int(count or 1), len(paths) or 1))
    cols = 1 if n == 1 else (2 if n <= 4 else 3)
    rows = -(-n // cols)  # ceiling divide
    out = Image.new("RGB", (w, h), bg)
    cw = (w - gap * (cols + 1)) // cols
    ch = (h - gap * (rows + 1)) // rows
    for i, path in enumerate(list(paths)[:n]):
        try:
            img = Image.open(path).convert("RGB")
        except Exception:
            continue
        r, c = divmod(i, cols)
        cell = _cover(img, cw, ch, focus_y=0.4)
        x, y = gap + c * (cw + gap), gap + r * (ch + gap)
        if radius:
            out.paste(cell, (x, y), _rounded(cell.convert("RGBA"), radius).split()[-1])
        else:
            out.paste(cell, (x, y))
    return out


def _fade(d):
    """Faint fade to grey at the bottom like the real screens."""
    for y in range(H // 2, H):
        v = 255 - int(14 * (y - H / 2) / (H / 2))
        d.line((0, y, W, y), fill=(v, v, v + 1))


def profile_card(photo_path, name, age=None, prompt_label="The way to win me over is",
                 prompt_answer="good banter and better food", time_str=None):
    """Profile screen in the same clean style as the likes screen: Inter, no status bar,
    no floating buttons or badges."""
    canvas = Image.new("RGBA", (W, H), (255, 255, 255, 255))
    d = ImageDraw.Draw(canvas)
    _fade(d)

    title = name if not age else f"{name}, {age}"
    d.text((60, 74), title, font=ui(88, "bold"), fill=(16, 16, 18))

    photo = _rounded(_cover(Image.open(photo_path).convert("RGB"), 960, 1330), 36)
    canvas.alpha_composite(photo, (60, 230))

    # prompt card peeking from the bottom
    d.rounded_rectangle((60, 1620, 1020, H + 40), radius=40, fill=(255, 255, 255))
    d.text((120, 1678), prompt_label, font=ui(40), fill=GREY)
    words = prompt_answer.split()
    lines, cur = [], ""
    f = ui(58, "semibold")
    for w_ in words:
        trial = (cur + " " + w_).strip()
        if d.textlength(trial, font=f) > 860 and cur:
            lines.append(cur)
            cur = w_
        else:
            cur = trial
    lines.append(cur)
    for i, line in enumerate(lines[:2]):
        d.text((120, 1756 + i * 82), line, font=f, fill=(18, 18, 20))
    return canvas.convert("RGB")


def like_card(photo_path, name, message="majestic ahhh", top_photo_path=None,
              pronouns="she/her/hers", prompt_q="Would you rather",
              prompt_a="give me all your money", header="All (50+)",
              time_str="11:33", cover_face=False):
    """The 'liked your photo with a comment' screen, cleaned for video use:
    no status bar, no floating buttons, Inter (closest to the app's Modern Era)."""
    canvas = Image.new("RGBA", (W, H), (255, 255, 255, 255))
    d = ImageDraw.Draw(canvas)
    _fade(d)

    d.text((60, 70), header, font=ui(46, "semibold"), fill=INK)
    # undo arrow, light grey, top right
    grey = (206, 206, 209)
    d.arc((958, 84, 1016, 138), 250, 155, fill=grey, width=9)
    d.polygon([(942, 106), (972, 92), (968, 124)], fill=grey)

    # the photo of you they liked, cropped strip
    strip = (60, 150, 1020, 430)
    if top_photo_path:
        photo = _rounded(_cover(Image.open(top_photo_path).convert("RGB"),
                                strip[2] - strip[0], strip[3] - strip[1], focus_y=0.18), 30)
        canvas.alpha_composite(photo, (strip[0], strip[1]))
    else:
        d.rounded_rectangle(strip, radius=30, fill=(228, 229, 232))

    # comment bubble overlapping the strip's bottom left
    bub_f = ui(44)
    msg = message.strip() or "..."
    bw = int(d.textlength(msg, font=bub_f))
    bx0, by0 = 48, strip[3] - 62
    bx1, by1 = bx0 + bw + 66, by0 + 102
    d.rounded_rectangle((bx0, by0, bx1, by1), radius=32, fill=(246, 232, 226))
    d.polygon([(bx0 + 14, by1 - 10), (bx0 + 64, by1 - 10), (bx0 + 4, by1 + 40)],
              fill=(246, 232, 226))
    d.text((bx0 + 34, by0 + 26), msg, font=bub_f, fill=(43, 36, 34))

    # name + menu dots + pronouns
    d.text((58, by1 + 44), name, font=ui(100, "bold"), fill=(16, 16, 18))
    for i in range(3):
        d.ellipse((938 + i * 30, by1 + 106, 938 + i * 30 + 13, by1 + 119), fill=(90, 92, 96))
    d.text((60, by1 + 178), pronouns, font=ui(43), fill=(26, 26, 30))

    # her photo
    py0 = by1 + 262
    ph = 1580 - py0
    girl = _cover(Image.open(photo_path).convert("RGB"), 960, ph)
    if cover_face:
        face = _face_box(girl)
        if face:
            cx, cy, fw = face
            hs = int(min(max(150, fw * 2.1), girl.width * 0.5))
            canvas_h = _heart_sticker(hs)
            girl = girl.convert("RGBA")
            girl.alpha_composite(canvas_h, (int(cx - hs / 2), int(cy - hs / 2 - fw * 0.12)))
    canvas.alpha_composite(_rounded(girl.convert("RGB"), 36), (60, py0))

    # prompt card peeking from the bottom
    d.rounded_rectangle((60, 1628, 1020, H + 60), radius=40, fill=(255, 255, 255))
    d.text((120, 1676), prompt_q, font=ui(52, "bold"), fill=(18, 18, 20))
    d.rounded_rectangle((112, 1758, 968, 1980), radius=28, outline=(216, 216, 220), width=3)
    d.text((152, 1786), prompt_a, font=ui(42), fill=(70, 70, 74))
    return canvas.convert("RGB")


def match_card(photo_path, name, time_str=None):
    """Simple 'you matched' style screen in the same clean style."""
    canvas = Image.new("RGBA", (W, H), (255, 255, 255, 255))
    d = ImageDraw.Draw(canvas)
    _fade(d)
    photo = _rounded(_cover(Image.open(photo_path).convert("RGB"), 960, 1440), 36)
    canvas.alpha_composite(photo, (60, 110))
    banner = f"You matched with {name}"
    f = ui(56, "semibold")
    bw = d.textlength(banner, font=f)
    bx = (W - bw) / 2
    d.rounded_rectangle((bx - 54, 1650, bx + bw + 54, 1786), radius=68, fill=(16, 16, 18))
    d.text((bx, 1684), banner, font=f, fill=(255, 255, 255))
    return canvas.convert("RGB")

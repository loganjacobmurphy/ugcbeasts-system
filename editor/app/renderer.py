"""Compose the final video: background per scene + person cutout + word captions."""
import bisect
import math
import os

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from . import cutout
from .matte import split_pack
from .media import SourceFrames, StreamEncoder, concat_speech
from .pipeline import Timeline

W, H = 1080, 1920
FPS = 30
FONT_DIR = os.path.join(os.path.dirname(__file__), "..", "fonts")

# Proxima Nova is a paid font and isn't on the machine; drop any of these into fonts/
# and captions pick it up automatically. Semibold first: Logan wants the weight under
# Black/heavy. Fallback chain steps down through the Montserrat weights we have.
CAPTION_FONT_CANDIDATES = [
    # TikTok's own Display cut (pulled from TikTok Studio on this Mac): the optical
    # size the app uses for on-video text. Proxima and Montserrat remain as fallbacks.
    "TikTok-Display-Medium.otf",
    "TikTok-Text-Medium.otf",
    "ProximaNova-Semibold.otf", "Proxima Nova Semibold.otf", "ProximaNova-Semibold.ttf",
    "ProximaNova-Bold.otf", "Proxima Nova Bold.otf", "ProximaNova-Bold.ttf",
    "ProximaNova.otf", "Proxima Nova.otf", "ProximaNova.ttf",
    "MontserratSemiBold.ttf",
    "Montserrat-Bold.ttf",
]
CAPTION_FONT_FALLBACK = "MontserratBlack.ttf"

_fonts = {}


def _caption_font_file():
    for name in CAPTION_FONT_CANDIDATES:
        if os.path.exists(os.path.join(FONT_DIR, name)):
            return name
    return CAPTION_FONT_FALLBACK


def font(size, name="MontserratBlack.ttf"):
    key = (name, size)
    if key not in _fonts:
        _fonts[key] = ImageFont.truetype(os.path.join(FONT_DIR, name), size)
    return _fonts[key]


def ease_out(p):
    p = min(max(p, 0.0), 1.0)
    return 1 - (1 - p) ** 3


def cover_pil(img, w=W, h=H):
    """Scale + center-crop a PIL image to fill w x h."""
    iw, ih = img.size
    s = max(w / iw, h / ih)
    nw, nh = int(iw * s + 0.5), int(ih * s + 0.5)
    img = img.resize((nw, nh), Image.LANCZOS)
    x, y = (nw - w) // 2, (nh - h) // 2
    return img.crop((x, y, x + w, y + h))


def cover_np(frame, w=W, h=H):
    fh, fw = frame.shape[:2]
    s = max(w / fw, h / fh)
    nw, nh = int(fw * s + 0.5), int(fh * s + 0.5)
    r = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_LINEAR)
    x, y = (nw - w) // 2, (nh - h) // 2
    return r[y:y + h, x:x + w]


def placeholder_bg(w=W, h=H):
    """Soft checker so an unassigned scene is obvious in previews."""
    img = Image.new("RGB", (w, h), (236, 238, 242))
    d = ImageDraw.Draw(img)
    sq = max(24, int(120 * w / W))
    for yy in range(0, h, sq):
        for xx in range(0, w, sq):
            if (xx // sq + yy // sq) % 2 == 0:
                d.rectangle((xx, yy, xx + sq, yy + sq), fill=(226, 229, 235))
    fs = max(18, int(52 * w / W))
    d.text((w // 2 - int(210 * w / W), int(140 * h / H)), "no background yet",
           font=font(fs, "MontserratSemiBold.ttf"), fill=(150, 156, 168))
    return img


class WordSprites:
    """Cached caption word images (text + stroke baked in). Normal case (as spoken),
    stroke scales with the font size."""

    def __init__(self, size=84, fill=(255, 255, 255), stroke=(17, 17, 17), stroke_w=None, upper=False):
        self.size = size
        self.fill = fill
        self.stroke = stroke
        self.stroke_w = stroke_w if stroke_w else max(6, round(size * 0.13))
        self.upper = upper
        self.font_file = _caption_font_file()
        self.cache = {}

    def get(self, text):
        if self.upper:
            text = text.upper()
        text = text.strip(".,?!;:")
        if not text:
            return None
        if text not in self.cache:
            f = font(self.size, self.font_file)
            pad = self.stroke_w + 8
            d0 = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
            bb = d0.textbbox((0, 0), text, font=f, stroke_width=self.stroke_w)
            # Constant height from the font metrics, NOT from this word's ink box.
            # Sizing to the ink meant every sprite got centred on its own glyphs, so
            # the baseline hopped by up to 17px between words: "you" sat lower than
            # "TIME" and the captions visibly bounced.
            asc, desc = f.getmetrics()
            w, h = bb[2] - bb[0] + pad * 2, asc + desc + pad * 2
            img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            d = ImageDraw.Draw(img)
            d.text((pad - bb[0], pad), text, font=f, fill=(*self.fill, 255),
                   stroke_width=self.stroke_w, stroke_fill=(*self.stroke, 255))
            self.cache[text] = img
        return self.cache[text]


def _norm_word(t):
    return str(t).lower().strip(".,?!;:'\"")


_overlay_imgs = {}


def overlay_sprite(path, width):
    """The overlay image exactly as provided: no rounding, no border, no shadow."""
    key = (path, width)
    if key not in _overlay_imgs:
        im = Image.open(path).convert("RGBA")
        h = int(im.height * width / im.width)
        _overlay_imgs[key] = im.resize((width, h), Image.LANCZOS)
    return _overlay_imgs[key]


HOOK_RED = (236, 64, 54, 255)

HOOK_FONT_CANDIDATES = [
    "TikTok-Display-Medium.otf",
    "TikTok-Text-Medium.otf",
    "ProximaNova-Semibold.otf", "Proxima Nova Semibold.otf", "ProximaNova-Semibold.ttf",
    "ProximaNova.otf", "Proxima Nova.otf", "ProximaNova.ttf",
    "ProximaNova-Bold.ttf", "ProximaNova-Bold.otf",
    "Inter-Medium.ttf",
]


def _hook_font_file():
    for name in HOOK_FONT_CANDIDATES:
        if os.path.exists(os.path.join(FONT_DIR, name)):
            return name
    return _caption_font_file()


def hook_sprite(text, size, max_w, style="bg"):
    """The hook text, in one of two looks.

    "bg" is the TikTok text-tool style: white text on red, with consecutive lines
    merging into one connected blob (rounded outer corners, smooth concave fillets
    at the width steps), exactly like the app.

    "outline" is white text with a heavy dark stroke and no box behind it, the same
    treatment the captions get. Formats that open on a photo grid use this, because
    a red slab across four photos covers the thing the video is about.
    """
    if style == "outline":
        return _hook_sprite_outline(text, size, max_w)
    f = font(size, _hook_font_file())
    d0 = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    pad_x, pad_y = int(size * 0.56), int(size * 0.30)
    radius = max(8, int(size * 0.30))
    inner_max = max_w - pad_x * 2

    lines = []
    for raw in text.split("\n"):
        words = raw.split()
        if not words:
            continue
        cur = words[0]
        for w_ in words[1:]:
            trial = cur + " " + w_
            if d0.textlength(trial, font=f) > inner_max:
                lines.append(cur)
                cur = w_
            else:
                cur = trial
        lines.append(cur)
    if not lines:
        return None

    metrics = []
    for line in lines:
        bb = d0.textbbox((0, 0), line, font=f)
        metrics.append((line, bb, bb[2] - bb[0] + pad_x * 2))
    # tight leading like the app: line boxes are taller than the line step, so
    # consecutive boxes overlap and the union reads as one blob
    line_h = int(size * 1.26)
    box_h = int(size * 1.04) + pad_y * 2
    W_spr = max(m[2] for m in metrics) + radius
    H_spr = line_h * (len(metrics) - 1) + box_h + radius

    # union of plain rects, then blur + threshold: rounds convex corners AND cuts
    # smooth concave fillets where line widths step, which is what connects the lines
    ss = 2
    mask = Image.new("L", (W_spr * ss, H_spr * ss), 0)
    md = ImageDraw.Draw(mask)
    for i, (line, bb, bw) in enumerate(metrics):
        x0 = (W_spr - bw) // 2
        y0 = radius // 2 + i * line_h
        md.rectangle((x0 * ss, y0 * ss, (x0 + bw) * ss, (y0 + box_h) * ss), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(radius * ss * 0.55))
    mask = mask.point(lambda v: 0 if v < 124 else (255 if v > 132 else int((v - 124) * 255 / 8)))
    red = Image.new("RGBA", mask.size, HOOK_RED)
    red.putalpha(mask)
    img = red.resize((W_spr, H_spr), Image.LANCZOS)

    d = ImageDraw.Draw(img)
    for i, (line, bb, bw) in enumerate(metrics):
        x0 = (W_spr - bw) // 2
        y0 = radius // 2 + i * line_h
        d.text((x0 + pad_x - bb[0], y0 + pad_y + (box_h - pad_y * 2 - (bb[3] - bb[1])) // 2 - bb[1]),
               line, font=f, fill=(255, 255, 255, 255))
    return img


def _hook_sprite_outline(text, size, max_w):
    """White hook text with a dark stroke, no box. Same stroke ratio as the captions
    so the two read as one piece of design."""
    f = font(size, _hook_font_file())
    d0 = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    stroke_w = max(6, round(size * 0.13))
    inner_max = max_w - stroke_w * 2

    lines = []
    for raw in text.split("\n"):
        words = raw.split()
        if not words:
            continue
        cur = words[0]
        for w_ in words[1:]:
            trial = cur + " " + w_
            if d0.textlength(trial, font=f) > inner_max:
                lines.append(cur)
                cur = w_
            else:
                cur = trial
        lines.append(cur)
    if not lines:
        return None

    metrics = [(line, d0.textbbox((0, 0), line, font=f, stroke_width=stroke_w)) for line in lines]
    line_h = int(size * 1.16)
    W_spr = max(bb[2] - bb[0] for _, bb in metrics) + stroke_w * 2
    H_spr = line_h * (len(metrics) - 1) + (metrics[0][1][3] - metrics[0][1][1]) + stroke_w * 2

    img = Image.new("RGBA", (max(1, W_spr), max(1, H_spr)), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for i, (line, bb) in enumerate(metrics):
        x = (W_spr - (bb[2] - bb[0])) // 2 - bb[0]
        y = stroke_w + i * line_h - bb[1]
        d.text((x, y), line, font=f, fill=(255, 255, 255, 255),
               stroke_width=stroke_w, stroke_fill=(17, 17, 17, 255))
    return img


def hook_sprite_for_settings(settings, width=W, height=H):
    """Share one fitted title between the editor sprite and encoded video.

    Fit at the full output resolution, then scale the finished sprite for previews.
    This keeps line wrapping identical at every playback resolution.
    """
    text = str(settings.get("text") or "").strip()
    if not text:
        return None
    style = settings.get("style") or "bg"
    size = max(12, int(settings.get("size", 85)))
    if not settings.get("autoFit"):
        return hook_sprite(text, max(12, int(size * width / W)), int(width * 0.86), style)
    max_w, max_h = int(W * 0.86), int(H * 0.22)
    sprite = hook_sprite(text, size, max_w, style)
    while size > 44 and (sprite.width > max_w or sprite.height > max_h):
        size = max(44, size - 2)
        sprite = hook_sprite(text, size, max_w, style)
    # A long unbroken word cannot wrap. Keep it in the safe area as well.
    fit = min(1.0, max_w / sprite.width, max_h / sprite.height)
    factor = fit * width / W
    target = (max(1, round(sprite.width * factor)), max(1, round(sprite.height * factor)))
    if target != sprite.size:
        sprite = sprite.resize(target, Image.LANCZOS)
    return sprite


def paste_center(canvas, img, cx, cy, scale=1.0, alpha=1.0):
    if img is None or scale <= 0 or alpha <= 0:
        return
    w, h = img.size
    if scale != 1.0:
        w, h = max(1, int(w * scale)), max(1, int(h * scale))
        img = img.resize((w, h), Image.BILINEAR)
    if alpha < 1.0:
        a = img.getchannel("A").point(lambda v: int(v * alpha))
        img = img.copy()
        img.putalpha(a)
    canvas.alpha_composite(img, (int(cx - w / 2), int(cy - h / 2)))


class Renderer:
    def __init__(self, project, project_dir, resolve_asset, scale=1.0):
        """resolve_asset(asset_id) -> {"path": ..., "type": "image"|"video"} or None.
        scale < 1 renders a proportionally smaller canvas (fast editor previews)."""
        self.p = project
        self.dir = project_dir
        self.resolve_asset = resolve_asset
        self.out_scale = scale
        self.W = max(2, int(W * scale)) // 2 * 2
        self.H = max(2, int(H * scale)) // 2 * 2
        self.words = project["words"]
        self.segments = project["segments"]
        self.cut = set(project.get("cutWords") or [])
        self.tl = Timeline(self.segments)
        self.scenes = project.get("scenes", [])
        cap = project.get("captions", {})
        self.captions_on = cap.get("enabled", True)
        self.caption_y = cap.get("y", 0.80)
        self.sprites = WordSprites(size=max(14, int(cap.get("size", 84) * scale)))
        hk = project.get("hook") or {}
        self.hook = hook_sprite_for_settings(hk, self.W, self.H)
        self.hook_y = float(hk.get("y", 0.45))
        self.fps = int(project.get("fps") or FPS)
        self.src = None
        # person pixels come from the RVM matte pack when the project has one,
        # else fall back to per-frame mediapipe on the raw source (old projects)
        self.packed = bool(project.get("matte"))
        self.person_path = os.path.join(project_dir, project["matte"] if self.packed else project["source"])
        self._bg_cache = {}
        self._bg_readers = {}
        self._events = self._caption_events()
        self._event_starts = [e[0] for e in self._events]
        self._word_scene = self._word_scene_map()
        self._overlays = self._overlay_events()
        # the hook only runs for scene 1: it ends exactly where the background
        # flips to scene 2 (end of scene 1's last kept word)
        self.hook_end = 0.0
        if self.hook is not None:
            if len(self.scenes) > 1:
                end_word = self.scenes[0].get("end", len(self.words) - 1)
                ends = [en for (st, en, wi) in self._events if wi <= end_word]
                self.hook_end = max(ends) if ends else 0.0
            else:
                self.hook_end = self.tl.out_dur

    # ---------- prep ----------
    def _caption_events(self):
        """One word on screen at every instant: each kept word holds until the next word
        begins, the first word covers t=0, the last holds to the end. No blank frames."""
        starts = []
        for si, (S, E, fw, lw) in enumerate(self.segments):
            first_kept = True
            for i in range(fw, lw + 1):
                if i in self.cut:
                    continue
                # a word blanked out by fix_heard (a stray "%" whisper hung on a
                # plain count) has nothing to draw. Skipping it lets the word before
                # hold through instead of flashing an empty caption mid sentence.
                if not self.words[i]["w"].strip():
                    continue
                # The first word of a segment starts AT the splice, not at its own
                # onset. The scene, and therefore the background and the hook, are
                # chosen by whichever caption word is live, so anchoring it to the
                # onset made the picture cut first and the background follow four or
                # five frames later. Every edit fired twice, which is what read as
                # badly cut.
                t = S if first_kept else max(self.words[i]["s"], S)
                starts.append((self.tl.word_to_out(i, t), i))
                first_kept = False
        starts.sort()
        events = []
        for idx, (st, i) in enumerate(starts):
            begin = 0.0 if idx == 0 else st
            end = starts[idx + 1][0] if idx + 1 < len(starts) else self.tl.out_dur
            events.append((begin, end, i))
        return events

    def _overlay_events(self):
        """Timed overlays (e.g. the App Store screenshot): start at the scene's trigger
        word, stay for at least 1.5s even across the scene boundary."""
        evs = []
        for sc in self.scenes:
            aid = sc.get("overlayAsset")
            if not aid:
                continue
            asset = self.resolve_asset(aid)
            if not asset or asset["type"] != "image":
                continue
            lo, hi = sc["start"], sc.get("end", len(self.words) - 1)
            kept = [i for i in range(lo, hi + 1) if i not in self.cut]
            if not kept:
                continue
            widx = kept[0]
            target = _norm_word(sc.get("overlayWord") or "")
            if target:
                for i in kept:
                    if _norm_word(self.words[i]["w"]) == target:
                        widx = i
                        break
            st = self.tl.word_to_out(widx, self.words[widx]["s"])
            dur = max(1.5, float(sc.get("overlayDuration") or 1.5))
            evs.append({"start": st, "end": min(self.tl.out_dur, st + dur),
                        "path": asset["path"],
                        "scale": float(sc.get("overlayScale", 0.62)),
                        "x": float(sc.get("overlayX", 0.0)),
                        "y": float(sc.get("overlayY", 0.42))})
        return evs

    def _word_scene_map(self):
        m = {}
        for idx, sc in enumerate(self.scenes):
            for w in range(sc["start"], sc.get("end", len(self.words) - 1) + 1):
                m[w] = idx
        return m

    def scene_at_out(self, t_out):
        """Scene = scene of the caption word active at t (or the last word started)."""
        if not self._events:
            return self.scenes[0] if self.scenes else None
        j = bisect.bisect_right(self._event_starts, t_out + 1e-6) - 1
        j = max(0, j)
        # inside the silent lead-in before the next word, the frame belongs to the next scene
        if t_out >= self._events[j][1] and j + 1 < len(self._events):
            j += 1
        widx = self._events[j][2]
        sidx = self._word_scene.get(widx, 0)
        return self.scenes[sidx] if self.scenes else None

    # ---------- layers ----------
    def _bg_for(self, scene, t_out):
        if scene is None or not scene.get("asset"):
            if "placeholder" not in self._bg_cache:
                self._bg_cache["placeholder"] = placeholder_bg(self.W, self.H)
            return self._bg_cache["placeholder"]
        asset = self.resolve_asset(scene["asset"])
        if asset is None:
            return self._bg_cache.setdefault("placeholder", placeholder_bg(self.W, self.H))
        if asset["type"] == "image":
            key = ("img", asset["path"])
            if key not in self._bg_cache:
                self._bg_cache[key] = cover_pil(Image.open(asset["path"]).convert("RGB"),
                                                self.W, self.H)
            return self._bg_cache[key]
        # video background: play from scene start, loop
        key = ("vid", id(scene), asset["path"])
        rd = self._bg_readers.get(key)
        if rd is None:
            rd = self._bg_readers[key] = {"frames": SourceFrames(asset["path"]), "t0": t_out, "dur": None}
        rel = max(0.0, t_out - rd["t0"])
        fr = rd["frames"].at_time(rel)
        if fr is None:
            rd["frames"].close()
            rd["frames"] = SourceFrames(asset["path"])
            rd["t0"] = t_out
            fr = rd["frames"].at_time(0.0)
        return Image.fromarray(cover_np(fr, self.W, self.H))

    def _person_layer(self, src_frame):
        if self.packed:
            return split_pack(src_frame)
        return cutout.person_rgba(src_frame)

    # ---------- frame ----------
    def render_frame(self, t_out, src_frame=None, seg_idx=None):
        if src_frame is None:
            if self.src is None:
                self.src = SourceFrames(self.person_path)
            src_t, seg_idx = self.tl.to_src(t_out)
            src_frame = self.src.at_time(src_t)
        scene = self.scene_at_out(t_out)
        canvas = self._bg_for(scene, t_out).convert("RGBA")

        if scene is None or not scene.get("hideHead"):
            rgba = self._person_layer(src_frame)
            # exactly the size and position Logan set by dragging, no automatic zoom
            scale = float(scene.get("headScale", 1.0) if scene else 1.0)
            dx = float(scene.get("headX", 0.0) if scene else 0.0)
            dy = float(scene.get("headY", 0.0) if scene else 0.0)
            fh, fw = rgba.shape[:2]
            pw = int(self.W * scale)
            ph = int(pw * fh / fw)
            person = Image.fromarray(rgba)
            if (pw, ph) != (fw, fh):
                person = person.resize((pw, ph), Image.LANCZOS)
            x = (self.W - pw) // 2 + int(dx * self.W)
            y = self.H - ph + int(dy * self.H)
            canvas.alpha_composite(person, (x, y))

        for ov in self._overlays:
            if ov["start"] - 1e-6 <= t_out < ov["end"]:
                card = overlay_sprite(ov["path"], max(40, int(ov["scale"] * self.W)))
                paste_center(canvas, card, int(self.W / 2 + ov["x"] * self.W),
                             int(ov["y"] * self.H))

        if self.hook is not None and t_out < self.hook_end - 1e-6:
            paste_center(canvas, self.hook, self.W // 2, int(self.hook_y * self.H))

        if self.captions_on and self._events:
            j = bisect.bisect_right(self._event_starts, t_out + 1e-6) - 1
            if j >= 0:
                widx = self._events[j][2]
                spr = self.sprites.get(self.words[widx]["w"])
                if spr is not None:  # static: no scale or fade, always full and on screen
                    paste_center(canvas, spr, self.W // 2, int(self.caption_y * self.H))
        return canvas.convert("RGB")

    # ---------- full render ----------
    def render(self, out_path, progress=None, log_path=None, fps=None,
               preset="medium", crf="18"):
        fps = fps or self.fps
        n_frames = int(self.tl.out_dur * fps)
        audio_src = os.path.join(self.dir, "audio.wav")
        trimmed = os.path.join(self.dir, "voice_cut.wav")
        concat_speech(audio_src, self.segments, trimmed)

        mus = self.p.get("music") or {}
        music_path = None
        if mus.get("enabled") and mus.get("file"):
            cand = os.path.join(os.path.dirname(__file__), "..", "music", mus["file"])
            if os.path.exists(cand):
                music_path = cand
        self.src = SourceFrames(self.person_path)
        enc = StreamEncoder(out_path, self.W, self.H, fps, trimmed,
                            log_path=log_path, preset=preset, crf=crf,
                            music_path=music_path,
                            music_volume=float(mus.get("volume", 0.07)),
                            duration=self.tl.out_dur)
        src_fps = self.src.fps
        for k in range(n_frames):
            t_out = k / fps
            src_t, seg_idx = self.tl.to_src(t_out)
            frame = self.src.at_index(int(round(src_t * src_fps)))
            img = self.render_frame(t_out, src_frame=frame, seg_idx=seg_idx)
            if img.size != (self.W, self.H):
                img = img.resize((self.W, self.H))
            enc.write(img.tobytes())
            if progress and k % 30 == 0:
                progress(k / max(1, n_frames))
        rc = enc.finish()
        for rd in self._bg_readers.values():
            rd["frames"].close()
        self.src.close()
        if rc != 0:
            raise RuntimeError(f"ffmpeg exited {rc}")
        if progress:
            progress(1.0)
        return out_path

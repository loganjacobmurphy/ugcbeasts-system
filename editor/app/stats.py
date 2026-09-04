"""The Hinge swipe funnel format: numbers, and the cards that show them.

The video is "I swiped right on 100,000 X on Hinge". It walks
down a funnel, one screen per step, and every screen is a generated graphic rather
than a photo. This module owns both halves of that: a set of numbers that hold
together all the way down, and the cards drawn from them.

The numbers are generated ONCE per video and then used for both the cards and the
script, so what he says matches what is on screen. In the reference video they did
not match, and it shows.
"""
import random
import re

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from . import cards

W, H = 1080, 1920

BG = (5, 5, 9)
CARD = (23, 23, 28)
EDGE = (44, 44, 52)
TEXT = (255, 255, 255)
MUTED = (150, 150, 160)

GREEN = {"accent": (34, 197, 94), "tint": (13, 42, 27), "edge": (28, 120, 66)}
PURPLE = {"accent": (139, 92, 246), "tint": (30, 20, 55), "edge": (86, 55, 160)}
RED = {"accent": (239, 68, 68), "tint": (46, 17, 20), "edge": (140, 45, 45)}


def funnel(sent=100_000, seed=None):
    """A believable funnel, consistent from top to bottom.

    Every number is derived from the one above it, so the percentages are real
    arithmetic rather than decoration. Ranges are taken from his own reference
    video, where about 13% opened, about 8% of those replied, and about 90% of
    those said no."""
    rnd = random.Random(seed)
    opened = round(sent * rnd.uniform(0.11, 0.17))
    responded = round(opened * rnd.uniform(0.06, 0.10))
    said_no = round(responded * rnd.uniform(0.86, 0.93))
    said_yes = responded - said_no
    # the payoff has to be a number worth saying out loud; his reference landed on 2
    cracked = max(2, round(said_yes * rnd.uniform(0.02, 0.05)))
    return {
        "sent": sent,
        "opened": opened,
        "notOpened": sent - opened,
        "responded": responded,
        "ignored": opened - responded,
        "saidNo": said_no,
        "saidYes": said_yes,
        "cracked": cracked,
    }


def pct(part, whole):
    return f"({part / whole * 100:.2f}%)" if whole else "(0%)"


def group(n):
    return f"{n:,}"


def _rounded_card(size, fill, edge=None, radius=28, glow=None):
    """One of the stat tiles: a rounded slab, optionally with a bright bar down its
    left edge, which is what makes the reference cards read as UI rather than text."""
    w, h = size
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=radius, fill=(*fill, 255),
                        outline=(*(edge or EDGE), 255), width=2)
    if glow:
        bar = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        bd = ImageDraw.Draw(bar)
        bd.rounded_rectangle((0, 0, 10, h - 1), radius=5, fill=(*glow, 255))
        img.alpha_composite(bar)
        halo = bar.filter(ImageFilter.GaussianBlur(14))
        img.alpha_composite(Image.alpha_composite(halo, bar))
    return img


def _tile(label, value, sub=None, colour=None, w=430, icon=None):
    """A labelled number tile: icon, caption, big figure, percentage underneath.

    The icon sits on its own row above the label. Putting it beside the label ran it
    straight through the text on anything longer than two words."""
    c = colour or {"accent": (200, 200, 210), "tint": CARD, "edge": EDGE}
    pad = 30
    f_label = cards.ui(36)
    f_value = cards.ui(76, "bold")
    f_sub = cards.ui(32)
    lines = _wrap(label, f_label, w - pad * 2 - 10)
    icon_h = 54 if icon else 0
    h = pad + icon_h + len(lines) * 46 + 92 + (42 if sub else 0) + pad
    img = _rounded_card((w, h), c["tint"], c["edge"], glow=c["accent"])
    d = ImageDraw.Draw(img)
    x = pad + 12
    y = pad
    if icon:
        d.ellipse((x, y, x + 42, y + 42), fill=(*c["accent"], 255))
        _icon(d, icon, x, y, 42)
        y += icon_h
    for ln in lines:
        d.text((x, y), ln, font=f_label, fill=(*MUTED, 255))
        y += 46
    d.text((x, y - 4), value, font=f_value, fill=(*TEXT, 255))
    y += 92
    if sub:
        d.text((x, y - 6), sub, font=f_sub, fill=(*c["accent"], 255))
    return img


def _icon(d, kind, x, y, s):
    """The tiny glyph on a tile. Drawn, not a font, so nothing has to be installed."""
    white = (255, 255, 255, 255)
    if kind == "tick":
        d.line([(x + s * 0.26, y + s * 0.52), (x + s * 0.44, y + s * 0.70),
                (x + s * 0.76, y + s * 0.32)], fill=white, width=4)
    elif kind == "cross":
        d.line([(x + s * 0.32, y + s * 0.32), (x + s * 0.68, y + s * 0.68)], fill=white, width=4)
        d.line([(x + s * 0.68, y + s * 0.32), (x + s * 0.32, y + s * 0.68)], fill=white, width=4)
    elif kind == "mail":
        d.rectangle((x + s * 0.24, y + s * 0.34, x + s * 0.76, y + s * 0.68), outline=white, width=3)
        d.line([(x + s * 0.24, y + s * 0.34), (x + s * 0.50, y + s * 0.55),
                (x + s * 0.76, y + s * 0.34)], fill=white, width=3)
    elif kind == "chat":
        d.rounded_rectangle((x + s * 0.24, y + s * 0.30, x + s * 0.76, y + s * 0.64),
                            radius=6, outline=white, width=3)
        for i in range(3):
            cx = x + s * (0.36 + i * 0.14)
            d.ellipse((cx - 2, y + s * 0.45, cx + 2, y + s * 0.49), fill=white)


def _wrap(text, font, max_w):
    d = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    out, cur = [], ""
    for word in str(text).split():
        trial = (cur + " " + word).strip()
        if cur and d.textlength(trial, font=font) > max_w:
            out.append(cur)
            cur = word
        else:
            cur = trial
    if cur:
        out.append(cur)
    return out or [""]


def _ribbon(img, x0, y0, x1, y1, thick0, thick1, colour):
    """The curved band joining one tile to the next, like a Sankey diagram. Drawn as
    a stack of horizontal slices following a smoothstep, so it curves cleanly."""
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    steps = max(2, int(abs(x1 - x0)))
    for i in range(steps):
        t = i / (steps - 1)
        s = t * t * (3 - 2 * t)          # smoothstep, flat at both ends
        x = x0 + (x1 - x0) * t
        y = y0 + (y1 - y0) * s
        th = thick0 + (thick1 - thick0) * t
        d.rectangle((x, y - th / 2, x + 2, y + th / 2), fill=(*colour, 190))
    img.alpha_composite(layer)


def split_card(f, top_area=0.62):
    """Step one: every right swipe, splitting into matches and no matches."""
    img = Image.new("RGBA", (W, H), (*BG, 255))
    src = _tile("Swiped right", group(f["sent"]), None, None, w=380, icon="mail")
    hit = _tile("Matched", group(f["opened"]), pct(f["opened"], f["sent"]), GREEN, w=430)
    miss = _tile("Did not match", group(f["notOpened"]), pct(f["notOpened"], f["sent"]), PURPLE, w=430)

    mid = int(H * top_area * 0.5) + 150
    sx, sy = 46, mid - src.height // 2
    hx, hy = W - hit.width - 46, mid - 340
    mx, my = W - miss.width - 46, mid + 150

    _ribbon(img, sx + src.width, sy + src.height * 0.42, hx, hy + hit.height / 2,
            src.height * 0.34, hit.height * 0.9, GREEN["accent"])
    _ribbon(img, sx + src.width, sy + src.height * 0.58, mx, my + miss.height / 2,
            src.height * 0.34, miss.height * 0.9, PURPLE["accent"])
    img.alpha_composite(src, (sx, sy))
    img.alpha_composite(hit, (hx, hy))
    img.alpha_composite(miss, (mx, my))
    return img.convert("RGB")


def replied_card(f):
    """Step two: of the matches, who actually replied."""
    img = Image.new("RGBA", (W, H), (*BG, 255))
    rate = None if f.get("basis") == "matches" else pct(f["opened"], f["sent"])
    src = _tile("Matched", group(f["opened"]), rate, GREEN, w=380, icon="mail")
    yes = _tile("Replied", group(f["responded"]), pct(f["responded"], f["opened"]),
                PURPLE, w=430, icon="chat")
    no = _tile("Did not reply", group(f["ignored"]), pct(f["ignored"], f["opened"]),
               RED, w=430)

    mid = int(H * 0.34)
    sx, sy = 46, mid - src.height // 2
    yx, yy = W - yes.width - 46, mid - 340
    nx, ny = W - no.width - 46, mid + 150
    _ribbon(img, sx + src.width, sy + src.height * 0.42, yx, yy + yes.height / 2,
            src.height * 0.34, yes.height * 0.9, PURPLE["accent"])
    _ribbon(img, sx + src.width, sy + src.height * 0.58, nx, ny + no.height / 2,
            src.height * 0.34, no.height * 0.9, RED["accent"])
    img.alpha_composite(src, (sx, sy))
    img.alpha_composite(yes, (yx, yy))
    img.alpha_composite(no, (nx, ny))
    return img.convert("RGB")


def answers_card(f):
    """Step three: of the ones who replied, who actually said yes. This is its own
    screen because it is its own line in the script, and putting it on the same card
    as the reply count left that line with no graphic at all."""
    img = Image.new("RGBA", (W, H), (*BG, 255))
    src = _tile("Replied", group(f["responded"]), None, PURPLE, w=380, icon="chat")
    yes = _tile("Said yes", group(f["saidYes"]), pct(f["saidYes"], f["responded"]),
                GREEN, w=430, icon="tick")
    no = _tile("Said no", group(f["saidNo"]), pct(f["saidNo"], f["responded"]),
               RED, w=430, icon="cross")

    mid = int(H * 0.34)
    sx, sy = 46, mid - src.height // 2
    yx, yy = W - yes.width - 46, mid - 340
    nx, ny = W - no.width - 46, mid + 150
    _ribbon(img, sx + src.width, sy + src.height * 0.42, yx, yy + yes.height / 2,
            src.height * 0.34, yes.height * 0.9, GREEN["accent"])
    _ribbon(img, sx + src.width, sy + src.height * 0.58, nx, ny + no.height / 2,
            src.height * 0.34, no.height * 0.9, RED["accent"])
    img.alpha_composite(src, (sx, sy))
    img.alpha_composite(yes, (yx, yy))
    img.alpha_composite(no, (nx, ny))
    return img.convert("RGB")


def result_card(f):
    """The payoff: how many actually cracked, out of every right swipe."""
    img = Image.new("RGBA", (W, H), (*BG, 255))
    d = ImageDraw.Draw(img)
    # the whole funnel restated as a ladder, so the last screen carries the payoff
    # rather than one lonely number on a black field
    rows = [("Swiped right", group(f["sent"]), MUTED),
            ("Matched", group(f["opened"]), MUTED),
            ("Replied", group(f["responded"]), MUTED),
            ("Said yes", group(f["saidYes"]), TEXT)]
    if f.get("basis") == "matches":
        rows = rows[1:]
    f_row = cards.ui(40)
    f_rowv = cards.ui(46, "bold")
    y = int(H * 0.10)
    for label, val, col in rows:
        d.text((70, y), label, font=f_row, fill=(*MUTED, 255))
        d.text((W - 70 - d.textlength(val, font=f_rowv), y - 4), val, font=f_rowv, fill=(*col, 255))
        y += 34
        d.line((70, y + 22, W - 70, y + 22), fill=(*EDGE, 255), width=2)
        y += 62
    y += 40
    d.text((70, y), "ACTUALLY CRACKED", font=cards.ui(36), fill=(*MUTED, 255))
    y += 66
    d.text((64, y), group(f["cracked"]), font=cards.ui(210, "bold"), fill=(*GREEN["accent"], 255))
    return img.convert("RGB")


# one card per step he says out loud, so no line is left without a graphic
CARDS = [("funnel split", split_card), ("who replied", replied_card),
         ("who said yes", answers_card), ("the result", result_card)]


def render_all(f):
    """Every card for one video, in the order they appear."""
    return [(name, fn(f)) for name, fn in CARDS
            if not (f.get("basis") == "matches" and name == "funnel split")]

# ---------------- reading the numbers back out of what he said ----------------
_NUM_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
              "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11,
              "twelve": 12, "none": 0, "zero": 0}

_COUNT_ONES = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19,
}
_COUNT_TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
               "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
_COUNT_SCALES = {"thousand": 1_000, "million": 1_000_000}
_COUNT_WORD = "|".join((*_COUNT_ONES, *_COUNT_TENS, "hundred", *_COUNT_SCALES))
_COUNT_PHRASE = re.compile(
    rf"\b(?:a\s+)?(?:{_COUNT_WORD})(?:(?:[\s,-]+)(?:and\s+)?(?:{_COUNT_WORD}))*\b",
    re.I,
)


def _small_count(words):
    """A number below one thousand, written as English words."""
    value = 0
    for word in words:
        if word == "a":
            value += 1
        elif word in _COUNT_ONES:
            value += _COUNT_ONES[word]
        elif word in _COUNT_TENS:
            value += _COUNT_TENS[word]
        elif word == "hundred":
            value = max(1, value) * 100
    return value


def _spelled_count_values(raw):
    """Read one or more adjacent English counts.

    A comma can either continue a count ("sixteen thousand, two hundred") or
    separate two figures ("a hundred thousand, sixteen thousand opened"). Large
    scales descend inside one number, so a repeated or larger scale starts the next
    figure instead of silently adding the two together.
    """
    words = [w for w in re.findall(r"[a-z]+", raw.lower()) if w != "and"]
    groups = []
    start = 0
    for i, word in enumerate(words):
        if word in _COUNT_SCALES:
            groups.append((words[start:i], _COUNT_SCALES[word]))
            start = i + 1
    tail = words[start:]
    if not groups:
        return [_small_count(tail)]

    out = []
    current = 0
    last_scale = None
    for chunk, scale in groups:
        part = _small_count(chunk) or 1
        if last_scale is not None and scale >= last_scale:
            out.append(current)
            current = 0
        current += part * scale
        last_scale = scale
    current += _small_count(tail)
    out.append(current)
    return out


def _expand_spelled_counts(text):
    """Turn spoken counts into digits before the proximity parser runs."""
    return _COUNT_PHRASE.sub(
        lambda m: ", ".join(str(n) for n in _spelled_count_values(m.group(0))),
        text,
    )


def _tidy(text):
    """Whisper writes big numbers with a space before the separator ("100 ,000",
    "84 .02 %"). Put them back together before anything tries to read them."""
    t = _expand_spelled_counts(text or "")
    # Caption corrections deliberately blank bad tokens rather than deleting them,
    # because every scene points at stable word indices. Joining those tokens can
    # leave doubled whitespace inside a key phrase such as "swiped  right on".
    # Collapse it before the proximity parser looks for exact phrases.
    t = re.sub(r"\s+", " ", t).strip()
    t = re.sub(r"(\d)\s+([.,])\s*(\d)", r"\1\2\3", t)
    t = re.sub(r"(\d)\s+%", r"\1%", t)
    # Whisper glues a stray % onto a plain count now and then ("1,368% actually
    # responded to me"). No half of one of these funnels is ever above a hundred
    # per cent, so that sign is noise, and left alone it hides the number from the
    # plain-number pattern entirely: a 1,368 reply count came back as 1.
    # Only whole figures are counts. A decimal above 100 is a mangled rate
    # ("12,075.65%" for "75.65%" in one real transcript), and removing its sign
    # would make the plain-number reader trust it as 12,075 opens.
    t = re.sub(r"(?<![\d.])(\d[\d,]*)\s*%",
               lambda m: m.group(1) if float(m.group(1).replace(",", "")) > 100 else m.group(0), t)
    # "30k" and "1.5m" are how he says it and how whisper writes it. Left alone the
    # send read as 30, fell under the sanity floor, and the funnel came back empty.
    t = re.sub(r"\b(\d+(?:\.\d+)?)\s*k\b", lambda m: str(int(float(m.group(1)) * 1_000)), t, flags=re.I)
    t = re.sub(r"\b(\d+(?:\.\d+)?)\s*m\b", lambda m: str(int(float(m.group(1)) * 1_000_000)), t, flags=re.I)
    # "DM'd" is how whisper writes it and how he says it; fold the apostrophe forms
    # so one set of keys covers dmed, dm'd, dmd and DMed
    t = re.sub(r"\bdm\s*['’]?\s*d\b", "dmed", t, flags=re.I)
    return t


def _num(tok):
    tok = tok.replace(",", "")
    try:
        return int(float(tok))
    except ValueError:
        return None


def _crosses_sentence(text, key_pos, a, b):
    """Is there a sentence or contrasting-clause break between this number and this word?

    The full stop inside a decimal is not one. "11.42% opened my message" read as a
    sentence break at the decimal point, so the figure could never reach the word it
    belongs to, and every percentage stated to one or two places parsed as nothing at
    all. Blank those out before looking for a real terminator.
    """
    lo, hi = (min(key_pos, a), max(key_pos, b))
    span = re.sub(r"(?<=\d)\.(?=\d)", " ", text[lo:hi])
    return any(ch in ".!?" for ch in span) or bool(re.search(r"\b(?:but|whereas)\b", span, re.I))


def _near(text, keys, window=60, want_pct=False, skip=(), rivals=()):
    """The number closest to any of these words, looking BOTH ways.

    He says it either side depending on the sentence: "15.98% opened the message"
    puts it before, "only 2,077 actually typed back" puts it before too, but
    "cracked 5 so far" puts it after. Searching forwards only picked up whatever
    number came next in the script, which was usually the wrong figure entirely.

    `skip` drops key matches that are back-references rather than the statement
    itself. "opened" appears twice in one of these scripts: once stating the count,
    and again in "out of the ones that opened it, 987 replied". Nearest-wins handed
    the open count to 987, because that number sits right against the second one.

    `rivals` are the words belonging to the OTHER figures. Nearest-wins on its own
    reads "794 of them actually responded, and 701 told me no" as 701 responding,
    because 701 sits closer to "responded" than 794 does, just on the wrong side.
    A number that hugs another figure's word is that figure's, so it is not offered
    here at all."""
    low = text.lower()
    # The plain pattern has to refuse the halves of a decimal percentage. Left to
    # itself it read "11.42%" as the numbers 11 and 4, and that stray 4 was then
    # handed back as the open count, which is how a 60,000 send came out as 4 opens.
    # The (?!\d) is what stops it settling for part of a number: without it the
    # engine backtracks out of a rejected "88" and offers the single digit "8".
    pat = (r"(\d[\d,]*\.?\d*)\s*%" if want_pct
           else r"(?<![\d.,])(\d[\d,]*)(?![\d,])(?!\s*%)(?!\.\d*\s*%)")
    nums = [(m.start(), m.end(), m.group(1)) for m in re.finditer(pat, text)]
    if not nums:
        return None
    # where each rival word sits, so a number can be handed to whichever it hugs
    rival_at = [m.start() for r in rivals for m in re.finditer(re.escape(r), low)]

    def claimed_by_rival(a, b, mine):
        """True when some other figure's word is closer to this number than ours,
        and nothing separates them. Only applies inside one sentence: across a full
        stop the nearer word is a different statement, not a better claim."""
        return any(min(abs(pos - b), abs(a - pos)) < mine and not _crosses_sentence(text, pos, a, b)
                   for pos in rival_at)

    best = None
    for k in keys:
        for m in re.finditer(re.escape(k), low):
            if any(re.match(pat, low[m.start():m.start() + 40]) for pat in skip):
                continue
            for a, b, raw in nums:
                dist = 0 if a <= m.start() <= b else min(abs(m.start() - b), abs(a - m.end()))
                if dist > window:
                    continue
                # a figure and the words describing it are always in one sentence.
                # "701 told me no. But 93 of them said they were ready" only reads
                # correctly if 701 cannot reach across the full stop to claim 93.
                if _crosses_sentence(text, m.start(), a, b):
                    continue
                if claimed_by_rival(a, b, dist):
                    continue
                v = float(raw.replace(",", "")) if want_pct else _num(raw)
                if v is None:
                    continue
                # A percentage above 100 is Whisper damage, never one side of a
                # funnel split. Leave it unclaimed so a valid figure in the other
                # clause can drive the arithmetic.
                if want_pct and not 0 <= v <= 100:
                    continue
                if best is None or dist < best[0]:
                    best = (dist, v)
    return best[1] if best else None


# Whisper's homophones for the small counts. "cracking three so far" comes back as
# "cracking through" and as "cracking free" about as often as it comes back right,
# and one missed word there loses the whole funnel, cards and all.
_NEAR_HOMOPHONES = {"for": 4, "free": 3, "through": 3, "tree": 3}


def _spelled(text, keys, window=40):
    """A count he said in words rather than digits ("cracking five so far").

    A homophone is read as its number, but only in the word or two straight after
    the key. Whisper writes "I've only cracked four" as "I've only cracked for",
    which left the whole funnel unreadable. Kept that tight deliberately: every one
    of these words is far too common to treat as a number anywhere else, and both
    "I used Regen for this" and "you have to filter through a lot" sit in these
    scripts already.
    """
    low = text.lower()
    for k in keys:
        for m in re.finditer(re.escape(k), low):
            for j, w in enumerate(re.findall(r"[a-z]+", low[m.end():m.end() + window])):
                if w in _NUM_WORDS:
                    return _NUM_WORDS[w]
                if w in _NEAR_HOMOPHONES and j < 2:
                    return _NEAR_HOMOPHONES[w]
    return None


def percentages_disagree(text):
    """He sometimes states both halves of the split and they do not add to 100.

    No card can be right in that case: whichever figure it shows contradicts the
    other thing he said. Worth telling him rather than quietly picking one."""
    t = _tidy(text)
    missed = ["did not match", "didn't match", "never matched", "left me",
              "undelivered", "on delivered", "did not open", "didn't open",
              "never opened"]
    positive = ["matched", "opened"]
    op = _near(t, positive, want_pct=True,
               skip=(r"opened\s+(it|them|those)\b",), rivals=missed)
    miss = _near(t, missed, want_pct=True, rivals=positive)
    if op is None or miss is None:
        return None
    if abs(op + miss - 100) <= 2:
        return None
    # "64% left me undelivered, 36,000 opened my message" states ONE percentage, but
    # it sits close enough to "opened" to be picked up by both lookups. The same
    # number twice is a misread, not him contradicting himself, and warning about it
    # buried a video that was fine.
    if abs(op - miss) < 0.5:
        return None
    return (f"you said {miss:g}% did not match and {op:g}% matched, which comes to "
            f"{op + miss:g}%, so the card cannot match both")


def from_transcript(text):
    """Rebuild the funnel from what he actually said, so the cards on screen carry
    his own figures rather than a fresh set that contradicts him.

    Returns None if the transcript does not carry enough to be sure."""
    t = _tidy(text)
    # "message" as well as "messaged": he says "I decided to message 40,000 furries"
    # as often as "I messaged". Nearest-wins keeps this off "opened my message".
    # "asked" carries the send on the feet pic cuts, where the hook is "I asked
    # 100,000 PAWGs for feet pics" and the word message never appears until the
    # split line, which would have handed the send count to the open figure.
    # The send is always stated before the split. A later feet-pic payoff can say
    # "they sent 4 pictures", and searching the whole transcript handed that 4 to
    # the original send because it sat directly beside the word "sent".
    low = t.lower()
    # The direct-match cut starts from matches already made, not right swipes.
    # Keep the denominator in the existing numeric fields for downstream cards,
    # but mark the basis so no imaginary swipe/match split is rendered.
    direct = re.search(r"\bi\s+(?:have\s+)?matched\s+(?:with\s+)?(\d[\d,]*)\b", low)
    match_total = None
    if direct and not re.search(r"\b(?:swiped|swipes|dmed|messaged|sent)\b", low[:direct.start()]):
        match_total = _num(direct.group(1))
    split_at = min((i for i in (low.find("matched"), low.find("macked back"),
                                low.find("did not match"),
                                low.find("didn't match"), low.find("opened"),
                                low.find("left me"), low.find("undelivered"),
                                low.find("responded")) if i >= 0),
                   default=len(t))
    sent = _near(t[:split_at], ["swiped right on", "swiped right", "swiped on", "swipes",
                                "messaged", "message", "dmed", "dm", "sent", "asked"])
    if match_total is not None:
        sent = match_total
    # A manual word cut can remove "I DM'd 100,000" while leaving the next line,
    # "Out of that 100,000...", intact. That line still states the denominator
    # unambiguously, so use it when the original send clause is no longer present.
    if not sent or sent < 100:
        sent = _near(t[:split_at], ["out of that", "out of all of them"])
    # One real 10k Hinge recording replaced the scripted number with "all of the
    # ASU girls". The rest of its funnel was complete and the current swipe format
    # is a 10k challenge, so keep the cards instead of discarding every stage.
    if (not sent or sent < 100) and re.search(
            r"\bswiped right on (?:all|every)(?:\s+of)?\b", low[:split_at]):
        sent = 10_000
    if not sent or sent < 100:
        return None

    # "opened it" and "opened them" look BACK at the count stated earlier, so they
    # must never anchor it themselves
    OPENED_BACKREF = (r"opened\s+(it|them|those)\b",)
    MISSED_KEYS = ["did not match", "didn't match", "never matched", "left me",
                   "undelivered", "on delivered", "did not open", "didn't open",
                   "never opened"]
    # Whisper turned "matched back" into "macked back" in a real Snow Bunny
    # upload. The phrase is specific to the match step and safe to treat as such.
    POSITIVE_KEYS = ["matched", "macked back", "opened"]
    # Stop the match lookup before the reply step. Otherwise the back-reference in
    # "out of the ones that matched, 405 replied" is closer to 405 than the real
    # earlier match count, and replies get mistaken for matches.
    reply_at = min((i for i in (low.find("responded"), low.find("replied"),
                                low.find("said something"), low.find("typed something"),
                                low.find("typing something"), low.find("raised something"))
                    if i >= 0), default=len(t))
    backref_at = min((low.find(k) for k in
                      ("out of the ones that matched", "out of the ones who matched",
                       "out of those that matched", "out of those who matched",
                       "out of the ones that opened", "out of the ones who opened",
                       "out of those that opened", "out of those who opened")
                      if low.find(k) >= 0), default=len(t))
    split_text = t[:min(reply_at, backref_at)]
    # he gives the open rate as a percentage far more often than as a count
    open_pct = _near(split_text, POSITIVE_KEYS, want_pct=True, skip=OPENED_BACKREF,
                     rivals=MISSED_KEYS)
    miss_pct = _near(split_text, MISSED_KEYS, want_pct=True, rivals=POSITIVE_KEYS)
    opened_count = _near(split_text, POSITIVE_KEYS, skip=OPENED_BACKREF,
                         rivals=MISSED_KEYS)

    # The second half of the split drops its per cent sign often enough to matter:
    # "87.6% left me undelivered, but 12.4 actually opened my message". Bare, that
    # 12.4 reads as a count, so a 100,000 send comes back as twelve opens. Two
    # halves of one split add up to 100, so a number that completes the stated half
    # is the percentage he said out loud, not a dozen people. Only trusted when
    # reading it as a count would be absurd, which keeps a real small count safe.
    if (miss_pct is not None and opened_count is not None
            and abs(opened_count + miss_pct - 100) <= 2
            and opened_count < sent * 0.02):
        open_pct, opened_count = 100 - miss_pct, None

    # Both percentages can land on the SAME figure when the two clauses sit close
    # together: "64% left me undelivered, 36,000 opened my message" puts that 64
    # within reach of "opened" too, and reading it as the open rate inverts the
    # whole funnel. Real halves of one split add up to 100, so anything else means
    # one of them was misread; the stated count is worth more than either.
    contradictory = (open_pct is not None and miss_pct is not None
                     and abs(open_pct + miss_pct - 100) > 2)
    if contradictory:
        open_pct = None
        if opened_count is None:
            opened = round(sent * (100 - miss_pct) / 100)
        else:
            opened = opened_count
    elif open_pct is not None:
        opened = round(sent * open_pct / 100)
    elif miss_pct is not None:
        opened = round(sent * (100 - miss_pct) / 100)
    else:
        opened = opened_count
    if match_total is not None:
        opened = match_total
    if opened is None:
        return None

    # he never says these the same way twice, so the lists carry every phrasing seen
    # across his scripts rather than one canonical wording
    YES_KEYS = ["said they were down", "were down to", "said yes", "saying yes",
                "say yes", "wanted to crack", "said they wanted", "down to crack",
                "ready to crack", "were ready", "said they were ready", "up for it",
                "said they would", "would be down", "said they actually would",
                "said they might be down", "saying they were down",
                "might actually be down", "might be down",
                "were interested", "interested"]
    NO_KEYS = ["said no", "saying no", "told me no", "straight up said no", "hard no",
               "said nah", "instantly said no", "said straight up no"]
    RESP_KEYS = ["typed something back", "typing something back", "typed back",
                 "wrote something back", "wrote back",
                 # Whisper produced "raised something back" for "wrote something
                 # back" in a real upload. It is specific enough to be safe here,
                 # and without it the entire funnel and all five cards disappear.
                 "raised something back",
                 "responded", "replied", "actually responded",
                 "said something to me", "said something back",
                 "actually said something"]

    responded = _near(t, RESP_KEYS, rivals=YES_KEYS + NO_KEYS)
    if responded is None:
        return None

    said_yes = _near(t, YES_KEYS, rivals=RESP_KEYS + NO_KEYS)
    if said_yes is None:
        # "then 93% of them said they actually wanted to crack": whisper hangs a per
        # cent sign on the yes count now and then, and the plain-number pattern has
        # to refuse anything wearing one or it reads the halves of a decimal split
        # as counts. He states this step as a headcount every time, so read it back
        # as one, but only when it fits inside the replies it is drawn from.
        stray = _near(t, YES_KEYS, want_pct=True, rivals=RESP_KEYS + NO_KEYS)
        if stray is not None and stray == int(stray) and 0 < stray <= responded:
            said_yes = int(stray)
    if said_yes is None:
        said_no = _near(t, NO_KEYS, rivals=RESP_KEYS + YES_KEYS)
        said_yes = (responded - said_no) if said_no is not None else None
    if said_yes is None:
        return None
    said_no = responded - said_yes

    # "cracking" matters as much as "cracked": he says "ended up with only cracking
    # two so far" as often as "cracked two", and dropping it lost the whole funnel
    CRACKED_KEYS = ["ended up cracking", "end up cracking", "actually cracked",
                    "cracked", "cracking",
                    # The intentionally absurd virginity hook still uses the same
                    # numeric Hinge funnel. Its final figure is phrased as how many
                    # times he "lost my virginity", so treat that as the payoff.
                    "lost my virginity", "lose my virginity",
                    "gotten through", "got through", "went through", "been through",
                    # the feet pic cuts ask for a picture rather than a crack, so the
                    # payoff is something he GOT. Kept to multi word phrases: a bare
                    # "got" also sits in "here's how I got them", which is the reveal
                    # line and carries no figure at all.
                    "ended up getting", "end up getting", "ended up receiving",
                    "end up receiving", "ended up with", "end up with",
                    # Natural payoff wording from the short feet-pic scripts. A bare
                    # "received" would be too broad, but the full lead-in only occurs
                    # on the final result and safely anchors either digits or words.
                    "so far i've received", "so far i’ve received",
                    "so far i have received", "so far i've gotten",
                    "so far i’ve gotten", "so far i have gotten",
                    "managed to receive", "managed to get", "managed to crack",
                    "actually got", "only got", "only received", "actually received",
                    # Natural 30 day challenge payoff. In a real upload, "I've
                    # only had three foot jobs" carried the final result. Missing
                    # this one phrase discarded an otherwise complete funnel, so
                    # every stat card disappeared and all four figures collapsed
                    # into one ordinary photo scene.
                    "only had", "have only had",
                    "have got", "have gotten", "got sent", "sent me"]
    cracked = (_near(t, CRACKED_KEYS) or _spelled(t, CRACKED_KEYS))
    if cracked is None:
        return None

    result = {"sent": sent, "opened": opened, "notOpened": sent - opened,
            "responded": responded, "ignored": max(0, opened - responded),
            "saidNo": max(0, said_no), "saidYes": said_yes, "cracked": cracked}
    if match_total is not None:
        result["basis"] = "matches"
    return result


# ---------------- the DM inbox the hook sits on ----------------
# Instagram's DM list shows a person's DISPLAY NAME, not their handle, which is why
# a real inbox is mostly capitalised names with the odd handle among them. A column
# of nothing but lowercase handles was one of the things that read as fake.
HANDLES = {
    "furrys": ["Pawsly", "growler_", "Thistle Vane", "lunapaw", "Byte", "Clawdia",
               "muzzlefuzz", "Flare Nightingale", "nixie", "Sable", "rusk", "Vell Ardo"],
    "trans/femboy": ["kittenly", "Sophie Lang", "softboyy", "Ren Takahashi", "mochi",
                     "Elise Moreau", "velvet", "peaches", "Bambi Cross", "lilbun",
                     "Angel Reyes", "sylvie"],
    "torta": ["Mariana Reyes", "yaritza", "Brenda Solís", "chiqui", "Lupita Sandoval",
              "danna", "Kimberly Ortiz", "yamileth", "Estrella Vega", "jocelyn",
              "Britany Nava", "alexa"],
    "bwgs": ["Kayleigh Brooks", "beccaa", "Shannon Doyle", "mads", "Chelsea Warner",
             "gemmaa", "Paige Hollis", "kirst", "Danielle Frost", "abbie", "Leanne Cobb", "jess"],
    "pawgs": ["Brooke Vance", "peachy", "Kaitlyn Ross", "bella", "Amber Cole", "jazz",
              "Sierra Blake", "mkayla", "Hayden Voss", "riri", "Delaney Cruz", "tori"],
    "milfs": ["Rachel Vaughn", "mrs.h", "Denise Carter", "lisaa", "Michelle Brady",
              "auntyk", "Karen Pryce", "shaz", "Andrea Nolan", "jules", "Fiona Whitmore", "nic"],
    "onlyfans": ["Skye Monroe", "babyskye", "Lexi Vaughn", "itslexi", "Amberlyn Ross",
                 "amberxo", "Jade Sinclair", "jadeee", "Nova Reign", "novaa", "Ruby Lane", "rubyy"],
    "oat girls": ["Wren Ashby", "oatmilkk", "Sunny Vale", "freakyy", "Marlowe Quinn",
                  "granola", "Indie Rae", "oatbabe", "Juniper Hale", "matcha", "Sage Ellery", "wrenn"],
    "black girls": ["Amara Boateng", "amaraa", "Simone Reid", "moni", "Tiana Okafor",
                    "tee", "Jasmine Cole", "jazzy", "Nia Campbell", "niaa", "Zuri Bennett", "zuzu"],
    "goth mommys": ["Morticia Vane", "gothmum", "Raven Doyle", "ravenn", "Lilith Crowe",
                  "lilxo", "Persephone Mars", "sephh", "Winona Blackwood", "wednesdayy",
                  "Elvira Stone", "vira"],
    "indians": ["Priya Nair", "priyaa", "Anjali Rao", "anj", "Meera Kapoor", "meerz",
                "Divya Shah", "divs", "Kavya Iyer", "kavv", "Sanya Malhotra", "sanyaa"],
    "indian mommys": ["Sunita Sharma", "auntysuni", "Rekha Patel", "rekhaa", "Kamla Desai",
                    "kammy", "Anita Bose", "anitaa", "Poonam Gill", "poonie",
                    "Lata Krishnan", "lataa"],
    # Strippers and Hookers share one library, so they share one name pool too,
    # which is both lists merged rather than one of them going unused.
    "strippers": ["Diamond Reyes", "diamondd", "Candy Vale", "candyxo", "Sapphire Knox",
                  "saph", "Roxy Sinclair", "roxyy", "Cherry Blaine", "cherri", "Bambi Cross", "bambii",
                  "Trixie Vale", "trix", "Roxanne Hart", "roxi", "Ginger Malone", "ging",
                  "Star Delaney", "starrr", "Nikki Vaughn", "nikkii", "Honey Blake", "honeyy"],
    "wnba": ["Deja Carter", "dejaa", "Brianna Holt", "bri", "Jaylen Moss", "jaymo",
             "Alicia Boone", "leash", "Tamara Reid", "tam", "Kyra Dunn", "kyraa"],
    "snow bunnies": ["Aspen Wilde", "aspennn", "Sierra Nash", "sierraa", "Winter Rowe",
                     "wintry", "Skylar Frost", "sky", "Ivy Larsen", "ivyy", "Bunny Vale", "bunbun"],
    "asu sorority": ["Madison Pryce", "maddyy", "Kenzie Bell", "kenz", "Blair Sutton",
                     "blairr", "Taylor Rhodes", "tay", "Peyton Grace", "peyt", "Sloane Vance", "sloaney"],
}
NEUTRAL_HANDLES = ["Alexa Ward", "mia", "Sasha Bell", "robin", "Kai Osei", "jules",
                   "Nova Pryce", "remy", "wren", "Sam Ellery", "quinn", "frankie"]

# Sampled off the reference, which is not black: #0C0F14 page, #FCFDFF names,
# #A8ACB7 preview text. The grey is faintly blue, and the page more so.
IG_BG = (12, 15, 20)
IG_NAME = (252, 253, 255)
IG_SUB = (168, 172, 183)

# What Instagram writes under a name once YOU sent the last thing. "Sent just now" is
# lifted verbatim off the reference; the timed ones follow the same shape it uses for
# "Liked a message · 8h". He fired the whole list off in one sitting, so they are all
# recent, and the first few genuinely would all read "just now".
SENT = ["Sent just now", "Sent just now", "Sent · 1m", "Sent · 2m", "Sent · 4m",
        "Sent · 7m", "Sent · 12m", "Sent · 26m", "Sent · 1h", "Sent · 2h",
        "Sent · 3h", "Sent · 5h"]


# Instagram on iOS renders in the system font, so the inbox should too. SF Pro ships
# with macOS as a variable font; Inter was close but not it.
_SF = "/System/Library/Fonts/SFNS.ttf"
_sf_cache = {}


WEIGHTS = {"Regular": 400, "Medium": 510, "Semibold": 590, "Bold": 700}

# White on black blooms and reads thinner than the same text black on white, and
# Apple compensates with SF Pro's GRAD axis. Skipping it is why this screen came out
# spindly: measured against a real screenshot, a stem was 0.095 of the line height
# where iOS draws 0.143. At 640 both the grey regular and the white bold sit within
# a pixel of the real thing (0.152 vs 0.143, 0.200 vs 0.192), which is as close as a
# whole pixel of stem allows. Erring heavy is deliberate: thin is the failure that
# was visible, and h.264 eats the light end. Unlike raising the weight, GRAD leaves
# advance widths alone, so nothing reflows.
GRADE = 640


def ios(size, weight="Regular", pt=None):
    """SF Pro at a given weight, falling back to the app's own UI font if the system
    font is not there (a different Mac, or a trimmed OS install).

    `pt` is the size the PHONE would have used, in points. SF Pro is two designs on
    one axis: under about 20pt it switches to the Text cut, with sturdier stems and
    more open counters so it survives being small. PIL leaves that axis at its 28
    default, which draws the Display cut at every size, so 14pt labels were being
    set in a headline's hairlines. Pass the real point size and the right cut comes
    out. It is not the pixel size: zooming a screenshot does not change which design
    the phone picked.
    """
    key = (size, weight, pt)
    if key not in _sf_cache:
        try:
            f = ImageFont.truetype(_SF, size)
            axes = f.get_variation_axes()
            lo = axes[1]["minimum"]
            hi = axes[1]["maximum"]
            optical = min(max(pt if pt else size, lo), hi)
            # order is Width, Optical Size, GRAD, Weight
            f.set_variation_by_axes([100, optical, GRADE, WEIGHTS.get(weight, 400)])
        except Exception:
            f = cards.ui(size, {"Regular": "regular", "Medium": "regular",
                                "Semibold": "semibold", "Bold": "bold"}.get(weight, "regular"))
        _sf_cache[key] = f
    return _sf_cache[key]


def _story_ring(size, thickness, seen=False):
    """Instagram's story ring: a conic gradient from orange round to purple. Exact
    stops taken off a working replica of the screen, not eyeballed."""
    # a story he has already watched draws flat grey, not the gradient
    stops = ([(0.0, (78, 78, 82)), (1.0, (78, 78, 82))] if seen else
             [(0.000, (240, 148, 51)), (0.200, (230, 104, 60)), (0.400, (220, 39, 67)),
              (0.600, (204, 35, 102)), (0.800, (188, 24, 136)), (1.000, (240, 148, 51))])

    def at(t):
        for i in range(len(stops) - 1):
            a, b = stops[i], stops[i + 1]
            if a[0] <= t <= b[0]:
                k = (t - a[0]) / (b[0] - a[0] or 1)
                return tuple(round(a[1][j] + (b[1][j] - a[1][j]) * k) for j in range(3))
        return stops[-1][1]

    ss = 3
    n = size * ss
    ring = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(ring)
    start = 200          # the gradient starts at 200deg, as the real one does
    steps = 180
    for i in range(steps):
        a0 = start + i * 360 / steps
        d.pieslice((0, 0, n - 1, n - 1), a0, a0 + 360 / steps + 1, fill=(*at(i / steps), 255))
    hole = int(thickness * ss)
    d.ellipse((hole, hole, n - hole - 1, n - hole - 1), fill=(0, 0, 0, 0))
    return ring.resize((size, size), Image.LANCZOS)


def _portrait(path, size):
    """Square crop framed on the face, for use as a profile picture.

    Cropping the middle of the frame at a fixed height was fine for a head-and
    shoulders selfie and useless for anything else: a full body shot gave an avatar
    of somebody's waist, and there are plenty of those in the library. The face box
    is worked out once at import and cached on the asset, so this is just a crop.

    Falls back to the old fixed crop when no face was found, which is mostly the
    fursuit photos, and those read fine either way because the suit fills the frame.
    """
    img = Image.open(path).convert("RGB")
    face = _FACE_CACHE.get(path)
    if not face:
        return cards._cover(img, size, size, focus_y=0.36)
    cx, cy, fw = face[0] * img.width, face[1] * img.height, face[2] * img.width
    # roughly a head and shoulders: the face about a third of the frame, sitting a
    # little above centre the way a portrait does
    box = min(min(img.size), max(fw * 3.0, min(img.size) * 0.3))
    x = min(max(0, cx - box / 2), img.width - box)
    y = min(max(0, cy - box * 0.42), img.height - box)
    return img.crop((int(x), int(y), int(x + box), int(y + box))).resize(
        (size, size), Image.LANCZOS)


_FACE_CACHE = {}


def load_faces(items, library_root):
    """Face boxes for the library, keyed by path, read from what was cached at import."""
    import os
    for a in items:
        f = a.get("face")
        if f:
            _FACE_CACHE[os.path.join(library_root, a["folder"], a["file"])] = f


def _avatar(path, size, ring_w=7, ring=True, seen=False):
    """Round profile picture, inside the story ring when that account has a story.

    Not everyone has one. Giving every row a ring was one of the things that made it
    read as generated rather than screenshotted."""
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    if ring:
        out.alpha_composite(_story_ring(size, ring_w, seen=seen))
        inner = size - ring_w * 2 - 6      # 3px of black between ring and photo
    else:
        inner = size                       # no ring, so the photo fills the slot
        # it really is the full 150: measured off the reference, a ringless avatar is
        # the same diameter as the ring would have been, not inset inside it
    try:
        face = _portrait(path, inner)
    except Exception:
        face = Image.new("RGB", (inner, inner), (58, 58, 60))
    mask = Image.new("L", (inner, inner), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, inner - 1, inner - 1), fill=255)
    off = (size - inner) // 2
    out.paste(face, (off, off), mask)
    return out


def _verified(size=40):
    """The blue check. Drawn as the scalloped disc it actually is, not a plain circle."""
    ss = 4
    n = size * ss
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    import math
    pts = []
    for i in range(360):
        a = math.radians(i)
        r = n / 2 * (0.86 + 0.14 * abs(math.cos(4 * a)))
        pts.append((n / 2 + r * math.cos(a), n / 2 + r * math.sin(a)))
    d.polygon(pts, fill=(0, 149, 246, 255))
    d.line([(n * 0.30, n * 0.52), (n * 0.44, n * 0.66), (n * 0.71, n * 0.36)],
           fill=(255, 255, 255, 255), width=int(n * 0.09), joint="curve")
    return img.resize((size, size), Image.LANCZOS)



def _paste_glyph(d, glyph, cx, cy):
    """Composite a drawn glyph onto an ImageDraw's image. Uses paste with the alpha
    as the mask because the canvas is RGB, and alpha_composite needs RGBA."""
    x, y = int(cx - glyph.width / 2), int(cy - glyph.height * 0.80)
    d._image.paste(glyph, (x, y), glyph)



def _magnifier(d, x, y, s=34):
    d.ellipse((x, y, x + s, y + s), outline=(142, 142, 147, 255), width=4)
    d.line((x + s * 0.78, y + s * 0.78, x + s * 1.12, y + s * 1.12),
           fill=(142, 142, 147, 255), width=4)



def dm_inbox(photo_paths, handles=None, rows=0, account="loganmphy",
             verified=True, zoom=1.30):
    """His Instagram DM list, full of them, every one already messaged.

    MEASURED, not eyeballed, off a real screenshot of the DM list on his own phone
    (1206 wide, an iPhone 16 Pro, so 3x) and scaled to this canvas by 1080/1206:

        avatar 168px -> 150      row pitch 216px -> 193      avatar x 48 -> 43
        text x 254 -> 227        name and preview BOTH 47px (15.7pt)
        name #FCFDFF             preview #A8ACB7             page #0C0F14

    Two of those were the things that read as fake. The page is not black, it is a
    very dark navy, and putting pure black behind it flattened the whole shot. And
    the preview line is the SAME size as the name, not smaller: the name only looks
    heavier because it is white against grey. Both measure a 6px stem in the
    reference, which is Regular once GRAD is applied.

    No status bar and no account header either. A made up clock, battery and
    notification dot are the tell on a fake screenshot, and none of it is what the
    shot is about.

    `zoom` frames the whole thing in closer, the way he would pinch into a real
    screenshot. Fewer rows fit, which is the point: the ones that show are legible.
    """
    Z = zoom
    # the reference screenshot was 3x, then scaled down to this canvas
    PX_PER_PT = 1080 / 1206 * 3.0

    def z(v):
        return int(round(v * Z))

    def font(base, weight="Regular"):
        """`base` is the size measured off the screenshot, in THIS canvas's pixels."""
        return ios(z(base), weight, pt=base / PX_PER_PT)

    img = Image.new("RGB", (W, H), IG_BG)
    d = ImageDraw.Draw(img, "RGBA")

    # ---- search bar, now the top of the shot
    sb_y, sb_h = z(40), z(120)
    d.rounded_rectangle((z(37), sb_y, W - z(38), sb_y + sb_h), radius=sb_h // 2, fill=(28, 28, 32))
    _magnifier(d, z(84), sb_y + z(41), z(40))
    d.text((z(156), sb_y + z(37)), "Search or ask Meta AI", font=font(42), fill=(142, 142, 152))

    # ---- Messages / Requests
    f_req = font(43, "Bold")
    y = z(227)
    d.text((z(47), y), "Messages", font=font(48, "Bold"), fill=IG_NAME)
    d.text((W - z(47) - d.textlength("Requests", font=f_req), y + z(5)),
           "Requests", font=f_req, fill=IG_SUB)

    # ---- the list
    y = z(331)
    step = z(193)
    av = z(150)
    names = list(handles or NEUTRAL_HANDLES)
    f_name = font(42)
    f_row = font(42)
    rows = rows or int((H - y) / step) + 1
    if photo_paths:
        rows = min(rows, len(photo_paths))
    # seeded off the names too, so the rings and ticks do not fall in the same places
    # on every audience's inbox
    rnd = random.Random(f"{account}|{rows}|{names[0] if names else ''}")
    # The reference has FOUR rows and not one story ring, so scattering them over
    # half the list was overdoing it. Two, one of them already watched so it draws
    # flat grey, is enough to show the feature exists without it becoming the shot.
    rings = set(rnd.sample(range(min(6, rows)), min(2, rows)))
    seen_rings = set(rnd.sample(sorted(rings), 1)) if rings else set()
    ticks = set(rnd.sample(range(rows), 1)) if verified else set()

    for i in range(rows):
        cy = y + step / 2
        if photo_paths:
            a = _avatar(photo_paths[i], av, ring_w=z(6), ring=i in rings, seen=i in seen_rings)
            img.paste(a, (z(43), int(cy - av / 2)), a)
        name = names[i % len(names)]
        nx = z(227)
        d.text((nx, cy - z(57)), name, font=f_name, fill=IG_NAME)
        nw = d.textlength(name, font=f_name)
        if i in ticks:
            badge = _verified(z(38))
            img.paste(badge, (int(nx + nw + z(14)), int(cy - z(53))), badge)
        d.text((nx, cy + z(1)), SENT[i % len(SENT)], font=f_row, fill=IG_SUB)
        y += step

    return img


def hinge_swipes(photo_paths, handles=None, total=100_000,
                  opener="Yo, can I crack?", reply="Uhh, no. What the fuck?"):
    """A Hinge chat screenshot for the line that names the right swipes.

    The spoken line already supplies the total. The visual explains why the later
    match funnel is so harsh by showing the opener and rejection inside a real chat
    layout instead of repeating the count on a generic discovery card.
    """
    paper = (255, 255, 255)
    ink = (31, 30, 33)
    muted = (116, 113, 121)
    line = (231, 229, 233)
    incoming = (242, 241, 244)
    purple = (91, 71, 151)
    img = Image.new("RGB", (W, H), paper)
    d = ImageDraw.Draw(img, "RGBA")

    names = list(handles or NEUTRAL_HANDLES)
    display = (names[0] if names else "New match").replace("_", " ").strip().title()
    first = display.split()[0] if display else "New match"

    # iPhone status bar and Hinge conversation header.
    d.text((58, 31), "9:41", font=cards.ui(31, "semibold"), fill=ink)
    d.rounded_rectangle((892, 43, 952, 68), radius=8, outline=(*ink, 255), width=3)
    d.rounded_rectangle((898, 49, 940, 62), radius=4, fill=(*ink, 255))
    d.rectangle((954, 50, 960, 61), fill=(*ink, 255))
    for i, h in enumerate((10, 16, 23, 30)):
        d.rounded_rectangle((800 + i * 18, 68 - h, 811 + i * 18, 68), radius=4,
                            fill=(*ink, 255))

    d.line((77, 156, 105, 128), fill=(*ink, 255), width=7)
    d.line((77, 156, 105, 184), fill=(*ink, 255), width=7)
    if photo_paths:
        avatar = _avatar(photo_paths[0], 112, ring=False)
        img.paste(avatar, (484, 91), avatar)
    else:
        d.ellipse((484, 91, 596, 203), fill=(216, 213, 220, 255))
    name_font = cards.ui(37, "semibold")
    name_w = d.textlength(display, font=name_font)
    d.text(((W - name_w) / 2, 214), display, font=name_font, fill=ink)
    d.text((952, 135), "•••", font=cards.ui(35, "bold"), fill=ink)
    d.line((0, 280, W, 280), fill=(*line, 255), width=2)

    d.text((274, 315), "Chat", font=cards.ui(39, "semibold"), fill=ink)
    d.text((690, 315), "Profile", font=cards.ui(39, "medium"), fill=muted)
    d.rounded_rectangle((208, 378, 470, 386), radius=4, fill=(*purple, 255))
    d.line((0, 387, W, 387), fill=(*line, 255), width=2)

    d.text((397, 454), "You matched", font=cards.ui(35, "semibold"), fill=ink)
    d.text((409, 505), "Today, 10:24 AM", font=cards.ui(27), fill=muted)

    # Sent messages sit on the right in Hinge purple. Replies sit on the left in
    # the app's light neutral bubble, each with the same asymmetric tail treatment.
    sent_font = cards.ui(48, "medium")
    sent_box = d.textbbox((0, 0), opener, font=sent_font)
    sent_w = min(820, max(430, sent_box[2] - sent_box[0] + 84))
    sx1, sy0, sy1 = W - 58, 650, 778
    sx0 = sx1 - sent_w
    d.rounded_rectangle((sx0, sy0, sx1, sy1), radius=42, fill=(*purple, 255))
    d.polygon(((sx1 - 26, sy1 - 35), (sx1 + 5, sy1), (sx1 - 55, sy1 - 10)),
              fill=(*purple, 255))
    d.text((sx0 + 40, sy0 + 35), opener, font=sent_font, fill=(255, 255, 255))
    d.text((sx1 - 108, 798), "Sent", font=cards.ui(25), fill=muted)

    reply_font = cards.ui(48, "medium")
    reply_box = d.textbbox((0, 0), reply, font=reply_font)
    reply_w = min(860, max(470, reply_box[2] - reply_box[0] + 84))
    rx0, ry0, ry1 = 58, 862, 990
    rx1 = rx0 + reply_w
    d.rounded_rectangle((rx0, ry0, rx1, ry1), radius=42, fill=(*incoming, 255))
    d.polygon(((rx0 + 26, ry1 - 35), (rx0 - 5, ry1), (rx0 + 55, ry1 - 10)),
              fill=(*incoming, 255))
    d.text((rx0 + 40, ry0 + 35), reply, font=reply_font, fill=ink)

    # Keep the input visible even behind a cutout so the screen reads as the Hinge
    # messenger immediately rather than a generic text-message mockup.
    d.line((0, 1634, W, 1634), fill=(*line, 255), width=2)
    d.rounded_rectangle((52, 1683, 928, 1792), radius=54,
                        fill=(250, 249, 251, 255), outline=(*line, 255), width=3)
    d.text((92, 1715), f"Message {first}", font=cards.ui(38), fill=muted)
    d.ellipse((948, 1689, 1038, 1779), fill=(*purple, 255))
    d.line((993, 1714, 993, 1752), fill=(255, 255, 255, 255), width=7)
    d.arc((974, 1728, 1012, 1764), 0, 180, fill=(255, 255, 255, 255), width=6)
    d.line((993, 1764, 993, 1770), fill=(255, 255, 255, 255), width=6)
    return img

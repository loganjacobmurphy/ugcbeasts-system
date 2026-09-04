"""Video formats and audiences.

A FORMAT is the video style, named after its hook: "How many X can i crack". It owns
which Logan HQ campaigns can use it, which app it promotes, and the hook patterns.
It deliberately says nothing about who the video is about.

An AUDIENCE is the X: which green screen images to use and the word that fills {aud}
in the hook. It is picked per video, after the format, so one format covers furries,
femboys, tortas and MILFs instead of needing a copy for each.

Both are stored data, edited on the Formats page, not hardcoded.
"""
import json
import os
import re
import threading

DATA = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data"))
PATH = os.path.join(DATA, "formats", "formats.json")
_lock = threading.Lock()

# the app a format promotes. Free text, not an enum: it doubles as the key that
# auto-matches a format to a campaign of the same name, so a new deal like "roast"
# works without code changes.
KNOWN_APPS = ["regen", "halo", "roast"]

# bump only for a change that genuinely cannot be migrated in place
SCHEMA_VERSION = 2

# The shots the scripts call for, with the words that signal each one. A scene whose
# line mentions "a travel shot" should get a travel photo, not a random one.
# Taken from the scripts themselves, not invented: every line below is a shot one
# of his recorded 10/10 videos or their reference transcript actually asks for.
# "physique" is deliberately absent, he does not use those photos.
SHOT_TYPES = [
    ("solo, dressed well", ["solo", "dressed", "outfit", "fit", "fitted shirt", "well dressed",
                            "going somewhere", "somewhere important", "good lighting", "standing"]),
    ("face shot", ["face shot", "clear face", "no sunglasses", "no hat", "no filters",
                   "close up", "headshot", "your face"]),
    ("full body", ["full body", "head to toe", "whole fit", "lied to", "what you look like"]),
    ("candid laughing", ["candid", "laughing", "laugh", "mid laugh", "smiling", "smile",
                         "approachable", "looking away"]),
    ("travel", ["travel", "trip", "holiday", "vacation", "abroad", "flight", "airport",
                "mountains", "abroad"]),
    ("group with friends", ["group", "friends", "mates", "boys", "squad", "have a life",
                            "leave the house", "loner", "enjoying your company"]),
    ("across the table", ["across the table", "table", "dinner", "restaurant", "fancy",
                          "date", "steak"]),
    ("outdoor", ["outdoor", "outdoors", "outside", "natural", "nature", "park", "walk", "hike"]),
    ("night out", ["night out", "club", "bar", "evening", "out out", "your absolute best"]),
    ("wedding or event", ["wedding", "event", "formal", "suit", "black tie", "occasion",
                          "elevated status"]),
    ("hobby", ["hobby", "with your hands", "something with your hands", "skill", "playing",
               "guitar", "surf", "sport"]),
    ("beach", ["beach", "sunset", "golden hour", "sea", "sand", "shore", "gym or beach"]),
    ("on a boat", ["boat", "yacht", "sailing", "on the water", "deck"]),
    ("with a pet", ["pet", "dog", "puppy", "cat", "animal", "even if it isnt your own"]),
]


def all_shot_types():
    return [label for label, _ in SHOT_TYPES]


def shot_type_for(text):
    """Best-matching shot type for a line of script, or "" when nothing matches.
    Deliberately dumb keyword scoring, so it stays predictable and easy to correct."""
    t = " " + re.sub(r"[^a-z ]+", " ", (text or "").lower()) + " "
    t = re.sub(r"\s+", " ", t)
    best, best_score = "", 0
    for label, keys in SHOT_TYPES:
        score = sum(1 for k in keys if (f" {k} " in t))
        if score > best_score:
            best, best_score = label, score
    return best

# Hook patterns, taken from the ones Logan writes by hand. {aud} / {Aud} are the
# audience name in lower / title case.
#   day hooks  use {day}  = which day of the challenge this video is, said out loud
#   span hooks use {span} = how long the challenge runs ("a week", "30 days")
#
# EMPTY dayHooks means the format never counts days. Not every format is a running
# challenge: a "how to" video has no day 6, so it must never open with one.
DEFAULT_DAY_HOOKS = [
    "Day {day} of seeing how many {aud} i can crack",
    "day {day} of cracking {Aud}",
    "Day {day} of seeing how many {aud} i can pull",
]
DEFAULT_SPAN_HOOKS = [
    "How many {Aud} can i crack in {span}",
    "Cracking {Aud} until i get an S*D",
    "how many {aud} can crack me in {span}?",
]

# The styles Logan runs, named after the hook rather than the audience.
_SEED_FORMATS = [
    ("f_crack", "How many X can i crack", "regen", DEFAULT_DAY_HOOKS, DEFAULT_SPAN_HOOKS),
    # no day hooks: this one is a how to, not a challenge he counts days on
    ("f_downbad", "How to find down bad X", "regen", [],
     ["How to find down bad {Aud}, if ur really downbad",
      "How to find {Aud} if ur really downbad",
      "Where to find down bad {Aud}, if ur really downbad"]),
]

# collection = the library tag the green screen images carry
# word        = what fills {aud} / {Aud} in a hook line
# (id, label shown in the app, library collection, the word he says in the script)
_SEED_AUDIENCES = [
    ("a_furries", "Furries", "furrys", "furries"),
    ("a_femboys", "Femboys", "trans/femboy", "femboys"),
    ("a_tortas", "Tortas", "torta", "tortas"),
    ("a_bwgs", "BWGs", "bwgs", "big white girls"),
    ("a_pawgs", "PAWGs", "pawgs", "PAWGs"),
    # borrows the PAWGs library, the way Hookers borrows the strippers'
    ("a_gymgirls", "Freaky gym girls", "pawgs", "freaky gym girls"),
    ("a_oatgirls", "Freaky oat girls", "pawgs", "freaky oat girls"),
    ("a_milfs", "MILFs", "milfs", "MILFs"),
    ("a_onlyfans", "OnlyFans models", "onlyfans", "OnlyFans models"),
    ("a_blackgirls", "Black girls", "black girls", "black girls"),
    ("a_gothmums", "Goth mommys", "goth mommys", "goth mommys"),
    # borrows the Indian mommys library, the way Hookers borrows the strippers'
    ("a_indians", "Indians", "indian mommys", "Indian girls"),
    ("a_indianmums", "Indian mommys", "indian mommys", "Indian mommys"),
    ("a_strippers", "Strippers", "strippers", "strippers"),
    # borrows the strippers library, the way Girlies borrows Tortas'
    ("a_hookers", "Hookers", "strippers", "hookers"),
    ("a_wnba", "WNBA", "wnba", "WNBA players"),
    ("a_snowbunnies", "Snow bunnies", "snow bunnies", "snow bunnies"),
    ("a_asu", "ASU sorority girls", "asu sorority", "ASU sorority girls"),
]


def _blank(name="", app="regen"):
    return {"id": "", "name": name, "app": app, "campaigns": [],
            "dayHooks": list(DEFAULT_DAY_HOOKS), "spanHooks": list(DEFAULT_SPAN_HOOKS),
            # a transcript of a real video in this format; script generation copies
            # its structure, pacing and voice rather than inventing a new one
            "reference": "",
            # a format whose images are a fixed pile (e.g. the roast formats, which
            # show good photos rather than being about a group) sets its own
            # collection; the flow then skips the audience step entirely
            "collection": "",
            # how the app gets worked in near the end. Spoken as the method he
            # used, not as an ad read.
            "cta": "",
            # how many photos the hook shows at once. The 10/10 style opens on a
            # grid of good photos rather than a single background. 0 = one image.
            "hookCollage": 0,
            # "bg" is the red TikTok slab, "outline" is white text with a dark
            # stroke. A slab covers a photo grid, so those formats want outline.
            "hookStyle": "bg",
            # the Hinge funnel format: the backgrounds are generated stat cards built
            # from a set of numbers, and the script is written from the same numbers
            # so what he says matches what is on screen
            "statsFunnel": False,
            # Where the Hinge swipe screenshot goes. True pins it to the hook shot.
            # The current cuts open on a photo of the audience instead and put the
            # swipe card on the next line that names the Hinge right swipes, so it is a
            # per-format choice rather than a rule.
            "inboxOnHook": True,
            # a library collection whose images get laid over the hook shot, empty
            # for the formats where the hook is just the one picture
            "hookOverlay": ""}


# Words whisper reliably gets wrong on his footage, and what he actually said.
# "furries" comes back as "fairies" or "ferries" often enough that it was being
# burned into the captions on screen. Keyed by what whisper heard, lowercased and
# stripped; the value is the correct word in the same case shape.
MISHEARD = {
    "fairies": "furries",
    "fairy": "furry",
    "ferries": "furries",
    "ferry": "furry",
    "furies": "furries",
    "fury": "furry",
    # he confirmed fanboys is always femboys misheard, never a group of his own
    "fanboys": "femboys",
    "fanboy": "femboy",
    "thermoise": "femboys",
    "fembois": "femboys",
    # whisper hears "foids" as a surname and capitalises it
    "floyd's": "foids",
    "floyds": "foids",
    "floyd": "foids",
    "tortillas": "tortas",
    "torta's": "tortas",
    "tortoise": "tortas",
    "tortoises": "tortas",
    # In the dating proof line Whisper hears the acronym ABGs as AVGs. The
    # possessive spelling is what appeared in a real upload, so keep this narrow.
    "avg's": "ABGs",
    "avgs": "ABGs",
    "macked": "matched",
    "hinch": "Hinge",
}


# Words that carry their own spelling whatever whisper heard. _match_case keeps the
# capital it guessed, which is right for an ordinary noun and wrong for these: it
# turns "foids" into "Foids" because whisper thought it was a surname, and leaves an
# app name lowercase in the middle of a sentence.
CANONICAL = {
    "foids": "foids",
    "regen": "Regen",
    "hinge": "Hinge",
    # the new audiences are acronyms, and whisper writes them however it feels
    "pawgs": "PAWGs", "pawg": "PAWG",
    "milfs": "MILFs", "milf": "MILF",
    "bwgs": "BWGs", "bwg": "BWG",
    "wnba": "WNBA",
    "asu": "ASU",
    "onlyfans": "OnlyFans",
}


def vocabulary():
    """The proper nouns whisper should expect, fed to it as a prompt so it leans
    towards them instead of the nearest ordinary word."""
    words = {a.get("word", "") for a in all_audiences()}
    words |= {n for f in all_formats() for n in app_names(f)}
    words |= set(MISHEARD.values())
    return sorted(w for w in words if w)


def _match_case(heard, fixed):
    if heard.isupper():
        return fixed.upper()
    if heard[:1].isupper():
        return fixed[:1].upper() + fixed[1:]
    return fixed


def fix_heard(words, app=""):
    """Correct known mishearings in a word list, in place, keeping the capital and
    any trailing punctuation so the caption still reads right. Returns how many it
    changed."""
    n = 0
    # Whisper hangs a stray "%" on a plain count now and then ("1,368 % actually
    # responded to me"), and captions are one word at a time, so it lands on screen
    # as a shot of its own. Nothing in these scripts is a share of more than a
    # hundred per cent, so a sign trailing a bigger WHOLE figure is noise. The whole
    # number part matters: he states counts as round figures and rates to a decimal
    # place, so "12,075.65%" is a real rate off a number whisper mangled, and
    # blanking its sign would only trade one wrong caption for another. Blanked
    # rather than removed: cutWords, breaks and scenes are written against indices.
    num = None                      # the figure being spelled across tokens: "1" ",368"
    for w in words or []:
        token = (w.get("w") or "").strip()
        if token == "%":
            if num is not None and "." not in num and float(num.replace(",", "")) > 100:
                w["w"] = ""
                n += 1
            num = None
            continue
        piece = token.rstrip(".,!?")
        if re.fullmatch(r"\d[\d,.]*", piece):
            num = piece
        elif num is not None and re.fullmatch(r"[.,]\d[\d,.]*", piece):
            num += piece
        else:
            num = None

    expected_app = (app or "").lower()
    rows = words or []
    # A thousands group is one caption, not "7" followed by "958". Keep the
    # original timing slots so existing cuts/scene indices remain valid; the
    # caption renderer holds the combined number through the blank slot.
    number_at = None
    for i, row in enumerate(rows):
        token = (row.get("w") or "").strip()
        if number_at is not None and re.fullmatch(r",\d{3}[,.!?;]?$", token):
            rows[number_at]["w"] += token
            row["w"] = ""
            n += 1
        elif re.fullmatch(r"\d+(?:,\d{3})*", token):
            number_at = i
        else:
            number_at = None
    # A real Hinge upload came back as "I start to write on 10,000 hotties" for
    # "I swiped right on 10,000 hotties". This phrase is specific enough to fix
    # as a unit. Keep every timing/index slot intact because scenes and captions
    # point at word indices.
    for i in range(len(rows) - 3):
        phrase = [re.sub(r"[^a-z]+", "", rows[j].get("w", "").lower())
                  for j in range(i, i + 4)]
        if phrase == ["start", "to", "write", "on"]:
            rows[i]["w"] = "swiped"
            rows[i + 1]["w"] = ""
            rows[i + 2]["w"] = "right"
            n += 3

    # "feet pictures" repeatedly lands as "feed pictures". Only change it when
    # the next token makes the intended phrase unambiguous, so an ordinary use of
    # feed elsewhere is untouched.
    for i in range(len(rows) - 1):
        here = re.sub(r"[^a-z]+", "", rows[i].get("w", "").lower())
        after = re.sub(r"[^a-z]+", "", rows[i + 1].get("w", "").lower())
        if here == "feed" and after in ("pic", "pics", "picture", "pictures"):
            rows[i]["w"] = rows[i].get("w", "").replace("feed", "feet").replace("Feed", "Feet")
            n += 1
        if here == "hello" and after == "matches":
            rows[i]["w"] = rows[i].get("w", "").replace("hello", "hella").replace("Hello", "Hella")
            n += 1

    # The sign-off phrase "a hell of a lot" was heard as "a head of a lot".
    # Correct only that complete local phrase, not the ordinary noun "head".
    for i in range(len(rows) - 3):
        phrase = [re.sub(r"[^a-z]+", "", rows[j].get("w", "").lower())
                  for j in range(i, i + 4)]
        if phrase == ["head", "of", "a", "lot"]:
            rows[i]["w"] = rows[i].get("w", "").replace("head", "hell").replace("Head", "Hell")
            n += 1

    for i, w in enumerate(rows):
        token = w.get("w", "")
        core = re.sub(r"^[^A-Za-z']+|[^A-Za-z']+$", "", token)
        if not core:
            continue
        # Whisper split "swapped my face" into "swap to my face" in one upload.
        # Keep the timing slots but blank the invented word so captions read the
        # phrase that was actually spoken.
        if core.lower() == "swap" and i + 3 < len(rows):
            after = [re.sub(r"[^a-z]+", "", x.get("w", "").lower())
                     for x in rows[i + 1:i + 4]]
            if after == ["to", "my", "face"]:
                w["w"] = token.replace(core, "swapped", 1)
                rows[i + 1]["w"] = ""
                n += 2
                continue
        # The same Goth recording ends on "grippy foot jobs", heard as "foot
        # drops" only on the second occurrence. The full local phrase is specific.
        if core.lower() == "drops" and i >= 2:
            before = [re.sub(r"[^a-z]+", "", x.get("w", "").lower())
                      for x in rows[i - 2:i]]
            if before == ["grippy", "foot"]:
                w["w"] = token.replace(core, "jobs", 1)
                n += 1
                continue
        # Snow Bunny is occasionally heard as "snow money's". Money's is a normal
        # word elsewhere, so correct it only when Snow is the word immediately
        # before it.
        if core.lower() == "money's" and i > 0:
            prev = re.sub(r"[^a-z]+", "", rows[i - 1].get("w", "").lower())
            if prev == "snow":
                w["w"] = token.replace(core, "bunnies", 1)
                n += 1
                continue
        # Whisper hears the Roast brand as "Rose". That is also a normal English
        # word, so only correct it when this is a Roast campaign and the surrounding
        # words make it the app mention, not a literal rose in the script.
        if core.lower() == "rose" and "roast" in expected_app:
            before = [re.sub(r"[^a-z]+", "", x.get("w", "").lower())
                      for x in rows[max(0, i - 2):i]]
            after = [re.sub(r"[^a-z]+", "", x.get("w", "").lower())
                     for x in rows[i + 1:i + 3]]
            if any(x in ("use", "used", "using", "with") for x in before) \
                    or any(x in ("app", "for") for x in after):
                w["w"] = token.replace(core, "Roast", 1)
                n += 1
                continue
        # Regen is commonly heard as the ordinary words "region" or "regent".
        # As with Rose and Roast, only fix it for a Regen project when the nearby
        # words clearly make this the app mention.
        if core.lower() in ("region", "regent") and "regen" in expected_app:
            before = [re.sub(r"[^a-z]+", "", x.get("w", "").lower())
                      for x in rows[max(0, i - 2):i]]
            after = [re.sub(r"[^a-z]+", "", x.get("w", "").lower())
                     for x in rows[i + 1:i + 3]]
            if any(x in ("use", "used", "using", "with") for x in before) \
                    or any(x in ("app", "for") for x in after):
                w["w"] = token.replace(core, "Regen", 1)
                n += 1
                continue
        fixed = MISHEARD.get(core.lower())
        if fixed:
            spelt = CANONICAL.get(fixed.lower()) or _match_case(core, fixed)
            w["w"] = token.replace(core, spelt, 1)
            n += 1
            continue
        spelt = CANONICAL.get(core.lower())
        if spelt and spelt != core:
            w["w"] = token.replace(core, spelt, 1)
            n += 1
    return n


def _blank_audience():
    return {"id": "", "label": "", "collection": "", "word": ""}


def _seeded():
    bundled = os.path.join(os.path.dirname(__file__), "..", "defaults", "formats.json")
    if os.path.exists(bundled):
        with open(bundled) as source:
            return json.load(source)
    formats = []
    for fid, name, app, day, span in _SEED_FORMATS:
        f = _blank(name, app)
        f.update(id=fid, dayHooks=list(day), spanHooks=list(span))
        formats.append(f)
    audiences = [{"id": aid, "label": label, "collection": coll, "word": word}
                 for aid, label, coll, word in _SEED_AUDIENCES]
    return {"version": SCHEMA_VERSION, "formats": formats, "audiences": audiences}


def load():
    with _lock:
        fresh = None
        if os.path.exists(PATH):
            with open(PATH) as f:
                data = json.load(f)
            # An explicit version, NOT a heuristic on which keys are present: the
            # first migration sniffed for a "collection" key, and re-adding that
            # field later made the loader wipe every format and reseed.
            if data.get("version") != SCHEMA_VERSION:
                fresh = _seeded()
        else:
            fresh = _seeded()
        if fresh is not None:
            os.makedirs(os.path.dirname(PATH), exist_ok=True)
            with open(PATH, "w") as f:
                json.dump(fresh, f, indent=2)
            return fresh
    data["version"] = SCHEMA_VERSION
    data.setdefault("audiences", _seeded()["audiences"])
    for x in data.get("formats", []):
        for k, v in _blank().items():
            x.setdefault(k, v)
    return data


def save(data):
    with _lock:
        os.makedirs(os.path.dirname(PATH), exist_ok=True)
        tmp = PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, PATH)


def all_formats():
    return load()["formats"]


def all_audiences():
    return load()["audiences"]


def all_apps():
    """Every app in use, taken from the formats themselves so a new deal appears in
    the editor the moment it is typed into a format. Nothing to hardcode."""
    names = list(KNOWN_APPS)
    for f in all_formats():
        for a in app_names(f):
            if a not in names:
                names.append(a)
    return names


def audience(aid):
    return next((a for a in all_audiences() if a["id"] == aid), None)


def app_names(f):
    """`app` may list more than one name, comma separated, when a format runs under
    more than one deal. The first is the tag a video gets; all of them are used to
    auto-match campaigns by name."""
    return [a.strip() for a in (f.get("app") or "").split(",") if a.strip()]


def primary_app(fid):
    f = parse(fid)
    names = app_names(f) if f else []
    return names[0] if names else ""


def app_for_campaign(fid, campaign_name=""):
    """Which app a video is actually promoting. A format can run under more than one
    deal, so when the campaign names one of them that is the one being promoted, not
    whichever happens to be listed first."""
    f = parse(fid)
    names = app_names(f) if f else []
    brand = (campaign_name or "").lower()
    # compare lowercased both ways: Logan HQ does, and a format typed as "Regen"
    # would otherwise never match a campaign called "Regen (Bounty)"
    for n in names:
        if n and n.lower() in brand:
            return n
    return names[0] if names else ""


def parse(fid):
    """The stored format record, or None."""
    if not fid:
        return None
    return next((f for f in all_formats() if f["id"] == fid), None)


def for_campaign(campaign_id):
    """Formats a campaign has access to. Access is explicit: a format shows up only on
    the campaigns ticked for it, so a Halo format never appears under a Regen deal."""
    return [f for f in all_formats() if campaign_id in f["campaigns"]]


def upsert(body):
    data = load()
    fid = str(body.get("id") or "").strip()
    rec = next((f for f in data["formats"] if f["id"] == fid), None)
    if rec is None:
        import uuid
        rec = _blank()
        rec["id"] = fid or "f_" + uuid.uuid4().hex[:10]
        data["formats"].append(rec)
    rec["name"] = str(body.get("name") or rec["name"] or "Untitled")[:60]
    rec["app"] = str(body.get("app") or rec["app"] or "").strip()[:30] or rec["app"]
    if isinstance(body.get("campaigns"), list):
        rec["campaigns"] = [str(c)[:60] for c in body["campaigns"]][:40]
    if "cta" in body:
        rec["cta"] = str(body.get("cta") or "")[:600]
    if "collection" in body:
        rec["collection"] = str(body.get("collection") or "")[:60]
    if "statsFunnel" in body:
        rec["statsFunnel"] = bool(body.get("statsFunnel"))
    if "inboxOnHook" in body:
        rec["inboxOnHook"] = bool(body.get("inboxOnHook"))
    if "hookOverlay" in body:
        rec["hookOverlay"] = str(body.get("hookOverlay") or "").strip()
    if "hookStyle" in body:
        rec["hookStyle"] = "outline" if body.get("hookStyle") == "outline" else "bg"
    if "hookCollage" in body:
        try:
            rec["hookCollage"] = max(0, min(9, int(body.get("hookCollage") or 0)))
        except (TypeError, ValueError):
            rec["hookCollage"] = 0
    if "reference" in body:
        rec["reference"] = str(body.get("reference") or "")[:8000]
    for key in ("dayHooks", "spanHooks"):
        if isinstance(body.get(key), list):
            rec[key] = [str(h)[:160] for h in body[key] if str(h).strip()][:12]
    save(data)
    return rec


def delete(fid):
    data = load()
    data["formats"] = [f for f in data["formats"] if f["id"] != fid]
    save(data)


def collection_for(aid):
    """The library collection an audience's images live in."""
    a = audience(aid)
    return a["collection"] if a else ""


def images_for(fid, aid):
    """Where a video's green screen images come from: the format's own collection
    when it has one, otherwise the chosen audience's."""
    f = parse(fid)
    if f and f.get("collection"):
        return f["collection"]
    return collection_for(aid)


def app_for(fid):
    return primary_app(fid)


_NUM_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
    "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19, "twenty": 20, "thirty": 30,
}


def _opening(words, n=40):
    text = " ".join(w.get("w", "") for w in (words or [])[:n]).lower()
    return re.sub(r"[^a-z0-9 ]+", " ", text)


def day_number(words):
    """Pull the day number out of what he says at the start ("day six of...",
    "this is day 13"). Returns None when the video does not mention one."""
    text = _opening(words)
    m = re.search(r"\bday\s+(\d{1,2})\b", text)
    if m:
        return int(m.group(1))
    # compound words first, so "day twenty one" is not read as day twenty
    m = re.search(r"\bday\s+(twenty|thirty)\s+([a-z]+)\b", text)
    if m and m.group(2) in _NUM_WORDS and _NUM_WORDS[m.group(2)] < 10:
        return _NUM_WORDS[m.group(1)] + _NUM_WORDS[m.group(2)]
    m = re.search(r"\bday\s+([a-z]+)\b", text)
    if m and m.group(1) in _NUM_WORDS:
        return _NUM_WORDS[m.group(1)]
    return None


def span_phrase(words):
    """How long the challenge runs, as it reads in a hook. Defaults to 30 days when
    he does not say, which is the span he uses most."""
    text = _opening(words, 60)
    if re.search(r"\b(a|one)\s+week\b", text) or re.search(r"\b7\s+days\b", text):
        return "a week"
    if re.search(r"\b(a|one)\s+month\b", text):
        return "a month"
    m = re.search(r"\b(\d{1,3})\s+days\b", text)
    if m:
        return f"{m.group(1)} days"
    for word, val in _NUM_WORDS.items():
        if re.search(rf"\b{word}\s+days\b", text):
            return f"{val} days"
    return "30 days"


# ---------------- sorting a batch by ear ----------------
_STOP = set("""a an and the of to in is it i im you your my me we so that this these those
for on at with as but or if not was were be been being have has had do does did just
got get gonna going really actually only out up down what how many much they them
their there here now then when who whom which will would can could should about into
over than very too also like know see look go come said say says""".split())


def _grams(text, lo=2, hi=4):
    """Word n-grams of a piece of text, lowercased and stripped of punctuation."""
    ws = [w for w in re.sub(r"[^a-z0-9 ]+", " ", (text or "").lower()).split() if w]
    out = set()
    for n in range(lo, hi + 1):
        for i in range(len(ws) - n + 1):
            g = ws[i:i + n]
            if all(x in _STOP for x in g):
                continue
            out.add(" ".join(g))
    return out


def _signature(f):
    """Everything that characterises a format in words: its name, its hook lines and
    the reference transcript of a real video in it."""
    parts = [f.get("name", "")]
    parts += [re.sub(r"\{[^}]*\}", " ", h) for h in (f.get("dayHooks") or []) + (f.get("spanHooks") or [])]
    parts.append(f.get("reference") or "")
    return _grams(" . ".join(parts))


def classify(text, campaign_id="", campaign_name=""):
    """Work out which format a recording is, by what he says in it.

    Scores each candidate on the phrases that are UNIQUE to it. A phrase both the
    crack format and the down bad format use says nothing about which one this is,
    so only the distinctive ones count. Returns
    (format_id, audience_id, confidence 0..1, why).
    """
    cands = for_campaign_or_app(campaign_id, campaign_name) or all_formats()
    if not cands:
        return "", "", 0.0, "no formats to choose from"
    sigs = {f["id"]: _signature(f) for f in cands}
    heard = _grams(text)

    scores, hits = {}, {}
    for f in cands:
        others = set().union(*[g for k, g in sigs.items() if k != f["id"]]) if len(sigs) > 1 else set()
        unique = sigs[f["id"]] - others
        matched = unique & heard
        # normalise by how much distinctive material the format has, so a format
        # with a long reference does not automatically win
        scores[f["id"]] = len(matched) / (len(unique) ** 0.5) if unique else 0.0
        hits[f["id"]] = matched

    # A complete funnel is stronger evidence than the reusable face-swap ending.
    # The ending also appears in the ongoing crack series, so n-grams alone can file
    # a clear swipe, match, reply, no/yes, result video under f_crack and suppress
    # every stat card. Pick the matching stats format from the spoken structure.
    low = " " + re.sub(r"[^a-z0-9 ]+", " ", (text or "").lower()) + " "
    has_swipe_total = any(k in low for k in
                          (" swiped right ", " swiped on ", " swipes "))
    has_match_total = bool(re.search(
        r"\bi\s+(?:have\s+)?matched\s+(?:with\s+)?(?:\d|ten thousand)", low))
    has_match = any(k in low for k in
                    (" matched", " macked back", " opened my message"))
    has_reply = any(k in low for k in
                    (" responded", " replied", " said something to me",
                     " typing something back", " typed something back",
                     " raised something back"))
    has_answer = (
        any(k in low for k in (" said no", " saying no"))
        and any(k in low for k in (" said yes", " saying yes", " were interested", " were down",
                                   " might be down", " would be down"))
    )
    has_result = any(k in low for k in
                     (" so far ", " in the end ", " ended up cracking",
                      " ended up receiving", " only received"))
    complete_funnel = (has_swipe_total or has_match_total) and has_match and has_reply and has_answer and has_result
    if complete_funnel:
        stats_cands = [f for f in cands if f.get("statsFunnel")]
        target = None
        is_feet = " feet " in low or " foot " in low
        if is_feet and " 30 days " in low:
            target = next((f for f in stats_cands if "30 day" in f.get("name", "").lower()), None)
        if target is None and (" swiped right " in low or has_match_total):
            target = next((f for f in stats_cands
                           if f.get("name", "").lower().startswith("i swiped right")), None)
        if target is None:
            target = next((f for f in stats_cands if f.get("id") == "f_prove"), None)
        if target:
            scores[target["id"]] = max(scores.values(), default=0.0) + 10.0
            hits[target["id"]].add("complete swipe match reply answer result funnel")

    # Keep the older DM feet recordings recoverable too. They have the same full
    # stat structure but no swipe wording, so the generic Hinge rule above does not
    # apply to them.
    complete_legacy_feet_funnel = (
        not complete_funnel
        and (" mission to see how many " in low or " experiment to see how many " in low)
        and (" feet picture" in low or " feet pic" in low)
        and has_match and has_reply and has_answer and has_result
    )
    if complete_legacy_feet_funnel and "f_prove" in scores:
        scores["f_prove"] = max(scores.values(), default=0.0) + 10.0
        hits["f_prove"].add("complete legacy feet picture funnel")

    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    best, top = ranked[0]
    # nothing matched at all, so there is no evidence for any of them. Whisper
    # hallucinates "Thanks for watching!" over silence, and that used to be enough
    # to file a recording under whichever format happened to sort first.
    if top <= 0:
        return "", "", 0.0, "nothing in the transcript matched any format"
    runner = ranked[1][1] if len(ranked) > 1 else 0.0
    # confidence is how far clear the winner is, not the raw score
    conf = 0.0 if top <= 0 else round(min(1.0, (top - runner) / top), 3)

    aud = ""
    f = parse(best) or {}
    if not f.get("collection"):
        low = " " + re.sub(r"[^a-z ]+", " ", (text or "").lower()) + " "
        # whisper splits some of these into two words ("crack heads"), so also look
        # at the text with the spaces taken out. Merging the tokens themselves is not
        # an option: scenes and segments reference word indices.
        squashed = low.replace(" ", "")
        best_n = 0
        for a in all_audiences():
            aliases = {(a.get(k) or "").lower() for k in ("word", "label", "collection")}
            # He says both "ASU sorority girls" and the shorter "ASU girls".
            # They are the same image set, so the sorter must not leave the audience
            # blank just because the descriptive middle word was omitted.
            aliases |= {w.replace(" sorority ", " ") for w in aliases if " sorority " in w}
            aliases = {w.rstrip("s") for w in aliases if w}
            n = max((max(low.count(" " + w), squashed.count(w.replace(" ", "")))
                     for w in aliases), default=0)
            if n > best_n:
                aud, best_n = a["id"], n

    why = ", ".join(sorted(hits[best], key=len, reverse=True)[:4])
    return best, aud, conf, why


def for_campaign_or_app(campaign_id="", campaign_name=""):
    """The formats a campaign can use: ticked explicitly, or matching by app name.
    Mirrors what Logan HQ shows him, so sorting can only pick something he could
    have picked himself."""
    brand = (campaign_name or "").lower()
    out = []
    for f in all_formats():
        if campaign_id and campaign_id in (f.get("campaigns") or []):
            out.append(f)
        elif brand and any(a.lower() in brand for a in app_names(f)):
            out.append(f)
    return out


def hook_for(fid, aid, words, seq=0, n=None):
    """Build the hook text for a video: a pattern from its format, filled with the
    audience word and the day or challenge length he says.

    If he says a day number at the start we use a day pattern and that number,
    otherwise a challenge-length pattern. `seq` is how many videos already exist in
    this format, so the pattern rotates instead of repeating.
    """
    f = parse(fid)
    if not f:
        return ""
    a = audience(aid) or {}
    day = day_number(words)
    # a format with no day hooks never counts days, even if he happens to say a
    # number; fall back to its OWN other hooks, never to the global defaults
    counts_days = day is not None and bool(f["dayHooks"])
    patterns = (f["dayHooks"] if counts_days else f["spanHooks"]) or f["dayHooks"] or DEFAULT_SPAN_HOOKS
    pattern = patterns[seq % len(patterns)]
    name = a.get("word") or ""
    # a pattern is only usable if we can actually fill it. Better no hook, which he
    # will notice and type, than one burned into the video with "None" or a hole
    # where the audience word should be.
    if "{day}" in pattern and day is None:
        patterns = f["spanHooks"] or DEFAULT_SPAN_HOOKS
        pattern = patterns[seq % len(patterns)]
    if not name and ("{aud}" in pattern or "{Aud}" in pattern):
        return ""
    try:
        # {n} is how many profiles he swiped right on for the Hinge funnel format
        return pattern.format(day=day, span=span_phrase(words), aud=name,
                              Aud=name.title(), n=f"{n:,}" if n else "100,000")
    except (KeyError, IndexError):
        return pattern  # a hand-edited pattern with an unknown placeholder

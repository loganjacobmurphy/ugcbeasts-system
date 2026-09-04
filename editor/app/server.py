"""greenroom local server. Run: python3 -m uvicorn app.server:app --port 5710"""
import io
import json
import os
import queue as _queue_mod
import re
import shutil
import threading
import time
import traceback
import uuid

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.requests import ClientDisconnect

from . import cards, formats, pipeline, stats, store
from . import inbox as inbox_layout
from .media import (probe, extract_audio, grab_frame, normalize_source, target_fps_for,
                    concat_speech, concat_videos, append_wav, wav_duration)
from .pipeline import RmsEnvelope, Timeline

app = FastAPI(title="greenroom")

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
STATIC = os.path.join(ROOT, "static")

os.makedirs(store.DATA, exist_ok=True)
app.mount("/files", StaticFiles(directory=store.DATA), name="files")
app.mount("/static", StaticFiles(directory=STATIC), name="static")

_jobs = {}          # pid -> thread
_previews = {}      # pid -> {"rev": int, "renderer": Renderer}
_preview_lock = threading.Lock()

# ingest/upgrade jobs run one at a time: the matte pass owns the GPU, so a serial
# queue is both faster overall and keeps the app responsive for editing meanwhile
_work_q = _queue_mod.Queue()

# renders and previews are things Logan actively waits on: while one runs, the
# ingest queue pauses (checked between matte frames) so they get the machine.
#
# Counted rather than a plain flag. Uploading now holds the gate too, and with a
# bare clear/set the upload finishing would hand the machine back mid render,
# because whoever set it last won regardless of who else still wanted it.
_user_gate = threading.Event()
_user_gate.set()
_gate_lock = threading.Lock()
_gate_holders = 0


def _hold_gate():
    """Take the machine off the ingest queue until the matching release."""
    global _gate_holders
    with _gate_lock:
        _gate_holders += 1
        _user_gate.clear()


def _release_gate():
    global _gate_holders
    with _gate_lock:
        _gate_holders = max(0, _gate_holders - 1)
        if not _gate_holders:
            _user_gate.set()


# An upload is something he is waiting on exactly the way a render is, and until
# now it was the one thing that did not hold the gate. The first video of a batch
# would land, ingest would start a matte pass on it, that pass would peg the
# machine, and the parts of the next video could not be answered inside
# Cloudflare's timeout, so the rest of the batch died with a 502 apiece. Parts
# arrive in bursts with gaps between them, so the hold is released on quiet
# rather than per request.
_upload_seen = 0.0
_upload_holding = False
_upload_lock = threading.Lock()
_UPLOAD_QUIET = 20.0


def _note_upload():
    global _upload_seen, _upload_holding
    with _upload_lock:
        _upload_seen = time.monotonic()
        if not _upload_holding:
            _upload_holding = True
            _hold_gate()


def _upload_watch():
    global _upload_holding
    while True:
        time.sleep(2)
        release = False
        with _upload_lock:
            if _upload_holding and time.monotonic() - _upload_seen > _UPLOAD_QUIET:
                _upload_holding = False
                release = True
        if release:
            _release_gate()


threading.Thread(target=_upload_watch, daemon=True).start()


def _work_worker():
    while True:
        kind, pid = _work_q.get()
        try:
            if kind == "upgrade":
                _upgrade(pid)
            elif kind == "append":
                _append(pid)
            else:
                _ingest(pid)
        except Exception:
            traceback.print_exc()
        finally:
            _work_q.task_done()


threading.Thread(target=_work_worker, daemon=True).start()


def _requeue_orphans():
    """After a server restart, pick up projects that were queued or mid-processing."""
    time.sleep(3)  # let the module finish loading before jobs can run
    # a scene pointing at an asset that no longer exists is worse than an empty one:
    # it renders as the grey placeholder and every "is anything missing" check reads
    # it as filled. Sweep them once at startup so a stale id can never sit there.
    known = {a["id"] for a in store.load_library()["items"]}
    for meta in store.list_projects():
        try:
            p = store.load_project(meta["id"])
        except Exception:
            continue
        touched = False
        for sc in p.get("scenes") or ():
            for k in ("asset", "overlayAsset"):
                if sc.get(k) and sc[k] not in known:
                    sc[k] = None
                    touched = True
        if touched:
            p["rev"] = int(p.get("rev") or 0) + 1
            store.save_project(p)
            print(f"cleared dead image references on {meta['id']}")

    for meta in store.list_projects():
        # a preview that was building when we stopped is not building any more, and
        # leaving it marked running makes the Preview button dead on that video
        try:
            p = store.load_project(meta["id"])
            if (p.get("preview") or {}).get("status") == "running":
                p["preview"] = {**p["preview"], "status": "idle"}
                store.save_project(p)
        except Exception:
            pass
        if meta.get("status") == "uploading":
            # an upload that never finished has no recording to work from; it would
            # otherwise sit in the list forever with no way to clear it
            try:
                if not store.load_project(meta["id"]).get("source"):
                    store.delete_project(meta["id"])
                    continue
            except Exception:
                pass
        if meta.get("status") in ("queued", "processing"):
            try:
                p = store.load_project(meta["id"])
            except Exception:
                continue
            # Back to "queued" while it sits in the line. One worker runs one job at
            # a time, so everything behind the active one was still reporting
            # "Processing" against a progress bar frozen where it died, which reads
            # as stuck when it is simply waiting its turn.
            if meta["status"] == "processing":
                p["status"] = "queued"
                store.save_project(p)
            if p.get("appendSrc"):
                _work_q.put(("append", meta["id"]))
            elif meta["status"] == "queued":
                _work_q.put(("ingest", meta["id"]))
            else:
                # words already present = it was an upgrade or a late stage; upgrading
                # preserves scenes and cuts, a fresh ingest would wipe them
                _work_q.put(("upgrade", meta["id"]) if p.get("words") else ("ingest", meta["id"]))
        elif meta.get("status") == "rendering":
            # a render orphaned by a restart: pick it up again, same output slot
            t = threading.Thread(target=_render_job, args=(meta["id"],), daemon=True)
            _jobs[meta["id"] + ":render"] = t
            t.start()


threading.Thread(target=_requeue_orphans, daemon=True).start()


# Nothing was compressed, and /api/state is ~100kb of JSON that has to cross the
# Cloudflare proxy and the tunnel before the editor can paint. Gzip takes it to
# ~21kb. Only worth it above a kilobyte; below that the header costs more than it
# saves, and it leaves image and video responses alone since those are already
# compressed formats.
app.add_middleware(GZipMiddleware, minimum_size=1024)


# shared secret the Logan HQ proxy sends; empty locally, set by the LaunchAgent
GREENROOM_KEY = os.environ.get("GREENROOM_KEY", "")


@app.middleware("http")
async def only_via_hq(request: Request, call_next):
    """Loopback use (localhost:5710) stays open. Anything reaching us on a public
    hostname has to come through the HQ proxy, which adds the shared key."""
    host = (request.headers.get("host") or "").split(":")[0]
    if host not in ("127.0.0.1", "localhost", "::1", ""):
        if not GREENROOM_KEY or request.headers.get("x-gr-key") != GREENROOM_KEY:
            return Response("Not found", status_code=404)
    return await call_next(request)


@app.middleware("http")
async def no_stale_static(request, call_next):
    resp = await call_next(request)
    # Firefox heuristically caches statics without this, so UI fixes never arrive
    if request.url.path.startswith(("/static", "/files")) or request.url.path == "/":
        resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    html = open(os.path.join(STATIC, "index.html")).read()
    # version the asset urls by file mtime so every deploy busts the cache
    for name in ("app.js", "style.css"):
        v = int(os.path.getmtime(os.path.join(STATIC, name)))
        html = html.replace(f"static/{name}", f"static/{name}?v={v}")
    # "/" locally, "/greenroom/" when Logan HQ proxies us under that path
    prefix = request.headers.get("x-forwarded-prefix", "").rstrip("/")
    return html.replace("__BASE__", f"{prefix}/" if prefix else "/")


# ---------------- state ----------------
@app.get("/api/state")
def state():
    music_dir = os.path.join(ROOT, "music")
    tracks = sorted(f for f in os.listdir(music_dir)
                    if f.lower().endswith((".mp3", ".m4a", ".wav"))) if os.path.isdir(music_dir) else []
    return {"projects": store.list_projects(),
            "library": store.load_library()["items"],
            "templates": store.load_templates()["templates"],
            "folders": store.FOLDERS,
            "formats": formats.all_formats(),
            "audiences": formats.all_audiences(),
            "apps": formats.all_apps(),
            "shotTypes": formats.all_shot_types(),
            "music": tracks}


# ---------------- projects ----------------
def _format_seq(fid, pid, created=None):
    """Where this video ranks among others in its format, so hook patterns rotate.

    Counts only videos made BEFORE this one. Counting everything that exists right
    now gave every video in a batch the same answer, because they are all uploaded
    before the first one finishes ingesting, so they all got the same hook line."""
    n = 0
    for other in store.list_projects():
        if other.get("format") != fid or other.get("id") == pid:
            continue
        if created is None or (other.get("created") or 0) < created:
            n += 1
    return n


# what a project is born with, see _fill_defaults in store.py
# 85 is the size he wants new videos to open on; the old default was 66, so
# anything already saved at 66 counts as hand set and is left alone.
STOCK_HOOK = {"y": 0.45, "size": 85}


# ---------------- scene breaks for the Hinge funnel ----------------
# A Hinge funnel video is a walk down a funnel and each step of it is one shot: the
# right swipes, the match split, who replied, who said yes, how he got them,
# what he ended up with. Breaking on pauses alone landed in the wrong places, since
# he does not pause where the funnel turns: one step got split across two scenes
# ("...90.1% left me on delivered," | "but 9.9% actually opened my message.") while
# two other steps ran together in one. So the steps are found in what he said and
# the breaks are put there instead.

# words that open a clause, so a step that starts mid sentence still gets the whole
# phrase ("and out of that 60,000...", not "out of that 60,000...")
CONNECTIVES = {"and", "but", "then", "so", "after", "before", "out", "now", "with",
               "anyway", "essentially", "basically"}

# under this many words a scene is a flash, not a shot
MIN_SCENE_WORDS = 4

NUM_WORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six",
             7: "seven", 8: "eight", 9: "nine", 10: "ten"}


def _funnel_tokens(p):
    """The transcript as (word index, text) with numbers glued back together.

    Whisper writes "60,000" as "60" + ",000" and "90.1%" as "90" + ".1" + "%", so a
    figure cannot be matched against a single token. Fragments are folded into the
    token before them, keeping that token's index."""
    cut = set(p.get("cutWords") or [])
    out = []
    for i, w in enumerate(p["words"]):
        if i in cut:
            continue
        t = w["w"]
        # Transcript corrections keep the timing slot but blank the bad token.
        # Do not let that empty slot break a multi-word funnel phrase such as
        # "swiped right on". The tuple still carries each surviving word's real
        # index, so the scene break lands at the correct source word.
        if not (t or "").strip():
            continue
        if out and re.match(r"^[.,]\d|^%", t) and re.search(r"\d$|\d[.,]$", out[-1][1]):
            out[-1] = (out[-1][0], out[-1][1] + t)
        else:
            out.append((i, t))
    return out


def _find_after(toks, needles, start):
    """First token at or after `start` whose text, or the phrase beginning at it,
    matches one of `needles`. Returns a word index, or None."""
    def norm(s):
        cleaned = re.sub(r"[^a-z0-9.%]", "", s.lower())
        # Keep decimal points inside figures, but discard sentence punctuation.
        # Retaining the full stop in "Regen." made a phrase ending at that word
        # impossible to match, so the app line never received its own scene.
        return re.sub(r"(?<!\d)\.|\.(?!\d)", "", cleaned)
    flat = [norm(t) for _, t in toks]
    # the needles have to go through the SAME normaliser as the transcript. They did
    # not, so every figure with a comma in it ("2,077" against a token flattened to
    # "2077") silently failed to match and the step anchored on whatever phrase came
    # next instead, which put the break after the number rather than before it.
    needles = [" ".join(norm(w) for w in n.split()) for n in needles]
    span = max((len(n.split()) for n in needles), default=1)
    joined = [" ".join(flat[i:i + span]) for i in range(len(flat))]
    for pos in range(len(toks)):
        if toks[pos][0] < start:
            continue
        for n in needles:
            if flat[pos] == n or joined[pos].startswith(n + " ") or joined[pos] == n:
                return toks[pos][0]
    return None


def _clause_start(words, idx, floor):
    """Walk back from a word to the top of the clause it sits in, never past `floor`."""
    i = idx
    start = idx
    while i > floor + 1:
        if words[i - 1]["w"].endswith((".", "!", "?")):
            start = i
            break
        if words[i]["w"].strip(",.!?'’").lower() in CONNECTIVES:
            start = i
            break
        i -= 1
    # a step tends to open on a run of them ("and out of that"), so take the lot
    while start > floor + 1 and words[start - 1]["w"].strip(",.!?").lower() in CONNECTIVES:
        start -= 1
    return start


def _funnel_anchors(p, fun):
    """Word index where each funnel step starts being talked about, in order."""
    toks = _funnel_tokens(p)
    f = formats.parse(p.get("format")) or {}
    app = (p.get("app") or "").strip().lower()
    pct = lambda a, b: f"{a / b * 100:.1f}%" if b else ""
    steps = [
        ("split",
         ["and out of that", "out of that", "and out of all of them",
          "out of all of them", "did not match", "didn't match", "never matched",
          "matched with me", "actually matched", "macked back", "matched",
          "left me on delivered", "on delivered", "left me", "did not open",
         "never opened", "actually opened", "opened my message", "opened it",
         pct(fun["notOpened"], fun["sent"]), pct(fun["opened"], fun["sent"]),
         f"{fun['notOpened']:,}", f"{fun['opened']:,}"]),
        ("replied",
         ["out of the ones", "out of those",
          "out of the ones that matched", "out of those that matched",
          "out of the ones that actually opened it",
          "out of the ones that opened it", "out of those that actually opened",
          "out of those that opened", f"{fun['responded']:,}", "responded",
          "replied", "said something to me", "said something back",
          "typed back", "egoed", "messaged me back",
          "actually responded"]),
        # The answers step is the no AND the yes: one card, showing both figures.
        # Anchoring on the yes alone started the scene at "but 24 said yes" and left
        # "364 said no" on the reply scene, so the card carried a number the
        # voiceover had already moved past. He always says the no first, so the
        # no-side needles go first and _find_after takes whichever lands earliest.
        ("answers",
         [f"{fun['saidNo']:,}", "said no", "saying no", "told me no", "said nah",
          "straight up no", "just said no",
          f"{fun['saidYes']:,}", "said they wanted", "wanted to crack", "said yes",
          "were down", "said they were down", "down to crack", "were interested"]),
        ("reveal",
         ["before i get into", "before i tell you", "before i reveal",
          "before we get into",
          "before i say", "let me show you", "show you how", "how i got",
          "how i actually got", "the way i got", "heres how i got",
          # Short feet-picture scripts go straight from the yes count into the
          # method. Without these openers, the answer graph stays up while he is
          # already explaining the dating-app method, making that image look absent.
          "and i used the same method", "i used the same method",
          "the way i did this", "this is how i do it",
          "and i pulled these", "i pulled these", "to do this"]),
        # "I used Regen for this" is the ad, and it earns its own shot: the app
        # screenshot goes here, so it must not share a scene with the swap method
        # before it or the payoff after it.
        ("app",
         # whisper slips an article in front of the app name often enough to matter
         # ("I used a roast for this" is in one of these verbatim), and without a
         # needle for it the ad loses its own shot and merges into the line before.
         [f"i used {app} for this", f"i use {app} for this",
          f"i used the {app}", f"i use the {app}", f"i used a {app}",
          f"used {app} for this", f"used a {app}", f"used the {app}",
          f"with {app}", f"using {app}", f"using a {app}",
          f"using the {app}", f"i used {app}", f"i use {app}"]),
        ("result",
         ["ive only ended up", "ive only end up", "but so far", "so far ive only",
          "in the end", "managed to receive", "managed to get",
          "ended up receiving", "ended up cracking",
          f"{fun['cracked']:,}", NUM_WORDS.get(fun["cracked"], ""), "so far",
          "only cracked"]),
    ]
    # On the "to prove how much I love X" cut the swipe card is NOT the hook shot:
    # the hook is a photo of the audience and the card belongs on the line that names
    # the number. He says both in one breath, so they land on one scene, and the
    # swipe card then has nowhere to go but the hook, which is the picture he wanted
    # there in the first place. Give the send its own step so it opens its own shot.
    if fun.get("basis") == "matches":
        steps = [(key, needles) for key, needles in steps if key != "split"]
        steps.append(("closing", ["i got hella matches", "i get hella matches",
                                  "i did get hella matches", "i did get a lot of matches",
                                  "i got a hella", "i got a lot of matches",
                                  "i dont think my approach", "i just dont think my approach",
                                  "i dont feel my approach", "i just dont feel my approach",
                                  "my approach wasnt",
                                  "my approach was not"]))
    elif not f.get("inboxOnHook", True):
        steps.insert(0, ("send",
                         ["i swiped right on", "swiped right on", "i swiped on",
                          "swiped on hinge", "right swipes on hinge",
                          "i decided to message", "i decided to dm", "i decided to dmd",
                          "i decided to dmed", "i decided to send", "decided to message",
                          "decided to dm", "so i messaged", "so i dmed", "so i dmd",
                          "so i dm",
                          "so i asked", "so i sent", "so i went and",
                          # the feet pic cuts ask rather than message, and he opens
                          # them either way round ("so I decided to ask 100,000...").
                          # Without these the send line keeps no scene of its own and
                          # every card after it lands one shot late.
                          "i decided to ask", "decided to ask", "i asked every",
                          "asked every single"]))

    anchors = [0]
    # the explanation and the ad keep their pause breaks; everything else collapses
    # onto one shot per step. Held by word index rather than by position in the list,
    # because the list is not always the same length.
    loose = set()
    for key, needles in steps:
        hit = _find_after(toks, [n for n in needles if n], anchors[-1] + 1)
        if hit is None:
            continue
        # The app mention and the payoff are often spoken without a pause after the
        # previous beat. Walking backwards from them steals the whole prior clause,
        # so their explicit openers begin exactly where they were found.
        exact = key in ("app", "closing")
        if key == "result":
            openers = ["ive only ended up", "ive only end up", "but so far",
                       "so far ive only"]
            exact = _find_after(toks, openers, anchors[-1] + 1) == hit
        start = hit if exact else _clause_start(p["words"], hit, anchors[-1])
        if exact and start > anchors[-1] + 1:
            prev = p["words"][start - 1]["w"].strip(",.!?'’").lower()
            if prev in CONNECTIVES:
                start -= 1
        # If the recording itself opens with "I swiped right...", that is already
        # the hook line. Splitting at token one leaves a one-word scene containing
        # only "I". The next stat step should be the first new scene instead.
        if key == "send" and start - anchors[-1] < MIN_SCENE_WORDS:
            continue
        if start > anchors[-1]:
            anchors.append(start)
            if key in ("reveal", "app"):
                loose.add(start)
    return anchors, loose


def _funnel_scenes(p):
    """Regroup a Hinge funnel video's scenes onto its funnel steps.

    Forces a break where each step starts, and drops the pause-derived breaks that
    fall inside a step, so one step is one scene rather than a figure on one and the
    clause that finishes it on the next. The stretch between the reveal and the
    result is left alone: it is the long explanation and it wants more than one shot.
    """
    f = formats.parse(p.get("format")) or {}
    fun = p.get("funnel")
    if not f.get("statsFunnel") or not fun or not p.get("words") or not p.get("breaks"):
        return
    anchors, loose = _funnel_anchors(p, fun)
    if len(anchors) < 3:
        return                              # not enough of it was said to regroup on
    keep = set(anchors)
    old_anchors = set(p.get("funnelAnchors") or ())
    for b in p["breaks"]:
        # Rebuilding after a parser improvement must remove an anchor that the old
        # parser invented. Otherwise a former false result, such as the teaser in
        # "before I reveal how many I ended up getting", survives forever as a cut.
        if b in old_anchors and b not in keep:
            continue
        step = max([a for a in anchors if a <= b], default=None)
        if step is None:
            continue
        if b == step or step in loose:
            keep.add(b)                     # a step opener, or inside the explanation
    # a pause inside a step can leave a two word flash of a scene ("and crack,"),
    # which is the choppy cutting he complained about. Anything under a few words
    # goes back onto the scene before it. Step openers are exempt: they are where the
    # picture has to change no matter how short the line is.
    breaks = sorted(keep)
    n = len(p["words"])
    trimmed = []
    for j, b in enumerate(breaks):
        end = breaks[j + 1] if j + 1 < len(breaks) else n
        if b in keep and b not in anchors and end - b < MIN_SCENE_WORDS:
            continue
        trimmed.append(b)
    breaks = trimmed

    p["funnelAnchors"] = anchors        # _carry_charts needs to know where steps turn
    if breaks != sorted(set(p["breaks"])):
        p["breaks"] = breaks
        p["scenes"] = pipeline.scenes_from_breaks(p["words"], breaks, existing=p.get("scenes"))


def _read_funnel(p):
    """Read the funnel out of the transcript BEFORE the hook is written.

    The hook line carries {n}, how many he swiped right on. Building it first meant it fell
    back to the stock 100,000 while he had actually said 30,000 in the recording."""
    f = formats.parse(p.get("format")) or {}
    if not f.get("statsFunnel") or not p.get("words"):
        return
    cut = set(p.get("cutWords") or [])
    text = " ".join(w["w"] for i, w in enumerate(p["words"]) if i not in cut)
    fun = stats.from_transcript(text)
    if fun:
        p["funnel"] = fun
    clash = stats.percentages_disagree(text)
    if clash:
        p["warning"] = "The numbers in this one do not add up: " + clash + "."


def _hinge_opener(text):
    """The fake Hinge opener must match the actual challenge being narrated."""
    low = stats._tidy(text).lower()
    if re.search(r"\bfoot\s*jobs?\b", low):
        return "Yo, can I have a footjob?"
    if re.search(r"\b(?:feet|foot)\s*(?:pics?|pictures?)\b", low):
        return "Yo, can you send me a feet pic?"
    if re.search(r"\b(?:lose|lost) my virginity\b", low):
        return "Yo, help me lose it?"
    return "Yo, can I crack?"


def _apply_stats_cards(p):
    """Build the funnel graphics for a Hinge funnel video and hang them on the right
    scenes.

    The numbers come from the TRANSCRIPT, not a fresh roll, so the cards carry the
    figures he actually said. Generating new ones would put graphics on screen that
    contradict his own voiceover, which is the exact fault in the reference video.
    """
    f = formats.parse(p.get("format")) or {}
    if not f.get("statsFunnel") or not p.get("words") or not p.get("scenes"):
        return
    cut = set(p.get("cutWords") or [])
    text = " ".join(w["w"] for i, w in enumerate(p["words"]) if i not in cut)
    fun = p.get("funnel") or stats.from_transcript(text)
    if not fun:
        # he did not state enough of the funnel to read it back; a made up set would
        # contradict him, so leave the scenes alone and say so
        p["warning"] = ("Could not read the funnel numbers out of what you said, "
                        "so the stat cards were not made.")
        return
    p["funnel"] = fun

    coll = f"funnel {p['id']}"
    # NOTE the order: make the new cards, place them, and only THEN bin the old ones.
    # Deleting first meant store.delete_asset cleared the references out of the saved
    # project while this one was still working from an in memory copy, and a scene
    # whose new card had not been placed yet was left pointing at nothing.
    stale = [a["id"] for a in store.load_library()["items"] if a.get("collection") == coll]

    made = []
    # the first funnel graphic shows the Hinge right swipe action and total
    a = formats.audience(p.get("audience")) or {}
    # Profile pictures only. The "hinge" folder holds generated dating cards, which
    # have a photo of HIM in the top strip, so cropping them for an avatar filled the
    # profile with his own face. Shuffled too: taking the first twelve in library order
    # put all the cards at the top of the list.
    import random as _r
    pool = [x for x in store.load_library()["items"]
            if x.get("collection") == a.get("collection") and x["type"] == "image"
            and x["folder"] not in ("hinge", "extra", "app", "inserts")
            and not x.get("statsCard") and not x.get("collage")]
    _r.Random(p["id"]).shuffle(pool)
    # a photo where a face was found makes a far better profile picture, so those go
    # to the top of the list and fill the rows that are actually on screen
    pool.sort(key=lambda x: 0 if x.get("face") else 1)
    stats.load_faces(store.load_library()["items"], store.LIBRARY)
    photos = [os.path.join(store.LIBRARY, x["folder"], x["file"]) for x in pool[:14]]
    # a brand new audience has no pictures yet, and the Hinge card has no profile.
    # Say so on the project rather than letting him find
    # out when he opens the finished video.
    if not photos:
        p["warning"] = (f"No photos in the {a.get('label') or 'this'} library yet, so the "
                        "Hinge swipe card has no profile picture. Add some and rebuild.")
    # Some cuts put a still on TOP of the hook rather than replacing it: the feet pic
    # cuts can keep a funnel graphic as the hook background and lay the thing he asked for
    # over it. The pool is a collection he tags on upload, so it stays his to fill,
    # and the placement is only a starting point because the editor lets him drag it.
    want_over = (f.get("hookOverlay") or "").strip().lower()
    if want_over and p.get("scenes"):
        over = [x for x in store.load_library()["items"]
                if (x.get("collection") or "").strip().lower() == want_over
                and x["type"] == "image" and not x.get("statsCard") and not x.get("collage")]
        if over:
            _r.Random(p["id"] + ":overlay").shuffle(over)
            p["scenes"][0]["overlayAsset"] = over[0]["id"]
            p["scenes"][0].setdefault("overlayDuration", 3.0)
        else:
            p["warning"] = (f'No images tagged "{want_over}" in the library yet, so the '
                            "hook has no overlay. Add some and rebuild.")

    opener = _hinge_opener(text)
    cards_to_make = [("hinge swipes", stats.hinge_swipes(
        photos, stats.HANDLES.get(a.get("collection")), fun["sent"], opener=opener))]
    cards_to_make += stats.render_all(fun)
    for name, img in cards_to_make:
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=92)
        item = store.add_library_file(
            "extra", f"{name.replace(' ', '_')}.jpg", content=buf.getvalue(),
            name=name, meta={"collection": coll, "statsCard": name})
        made.append((name, item))

    # each card goes on the scene where he says that step's numbers, and the cards
    # go in script order: the funnel is always walked forwards, so a card can never
    # land before the one ahead of it.
    wants = {
        # the hook line names the audience and the total, nothing else does
        "hinge swipes": ["swiped right on", "swiped on hinge", "right swipes",
                         "on hinge", "to see how many",
                     "asked every single", "asked every one"],
        # Match the branch result, not the total. The total is commonly spoken in
        # the hook too, and using it here put the split card over the hook photo.
        "funnel split": [f"{fun['opened'] / fun['sent'] * 100:.1f}",
                         f"{fun['notOpened'] / fun['sent'] * 100:.1f}", "matched",
                         "macked back",
                         "did not match", "didn't match", "opened", "undelivered",
                         "on delivered"],
        "who replied": [f"{fun['responded']:,}", str(fun["responded"]),
                        "typed", "responded", "replied", "said something",
                        "egoed", "ignored"],
        # This card shows both branches of the answer step, no and yes. Match the
        # no line as well so it appears as soon as that split is spoken, then stays
        # through the yes line, instead of arriving one scene late on yes alone.
        "who said yes": [f"{fun['saidNo']:,}", str(fun["saidNo"]),
                         "said no", "saying no", "told me no", "straight up no",
                         f"{fun['saidYes']:,}", str(fun["saidYes"]),
                         "said they were down", "down to crack", "said yes",
                         "wanted to crack", "said they would", "would send",
                         "were interested", "interested"],
        # the payoff, not the "before I get into how many I cracked" tease that comes
        # earlier, so ties go to the LAST scene that mentions it
        "the result": [str(fun["cracked"]), "ended up", "so far", "cracked",
                       "only cracked", "ended up getting", "only got"],
    }
    lo = 0
    for name, item in made:
        # On the standard cut the swipe graphic IS the hook shot, so it takes scene one:
        # matching it on keywords put it further down whenever the first line
        # happened not to state the right swipe total. The current cut opens on a photo
        # of the audience instead, and the swipe graphic belongs on the line that
        # mentions Hinge, so there it falls through to keyword matching like the
        # rest of the cards.
        if name == "hinge swipes" and (f.get("inboxOnHook", True) or fun.get("basis") == "matches"):
            p["scenes"][0]["asset"] = item["id"]
            lo = 1
            continue
        keys = wants.get(name, [])
        prefer_last = name == "the result"
        best, score = None, 0
        search_lo = 1 if name == "hinge swipes" and not f.get("inboxOnHook", True) else lo
        for i in range(search_lo, len(p["scenes"])):
            line = stats._tidy(_scene_text(p, sc=p["scenes"][i])).lower()
            n = sum(1 for k in keys if k and k.lower() in line)
            if n > score or (prefer_last and n == score and n > 0):
                best, score = i, n
        # If the swipe total is already in the hook, there is no separate spoken
        # swipe scene. Do not consume the match scene with a redundant swipe card,
        # because that pushes every real stat graphic one beat late.
        if name == "hinge swipes" and not f.get("inboxOnHook", True):
            if best is None:
                continue
            line = stats._tidy(_scene_text(p, sc=p["scenes"][best])).lower()
            if any(k in line for k in ("matched", "macked back", "did not match",
                                       "didn't match", "opened", "undelivered")):
                continue
        # two steps often land in one scene; hold this one on the next scene along
        # rather than dropping it, which is what left a line with no graphic
        if best is None and search_lo < len(p["scenes"]) and name != "the result":
            best = search_lo
        if best is not None:
            p["scenes"][best]["asset"] = item["id"]
            lo = best + 1

    # Drop any scene still holding a card from the previous build before carrying
    # charts. Otherwise the stale card looks valid, blocks the new answer card from
    # continuing across its sentence, then gets cleared after it is too late.
    dead = set(stale)
    for sc in p["scenes"]:
        if sc.get("asset") in dead:
            sc["asset"] = None

    _carry_charts(p)
    _place_app_shots(p)
    _fill_gaps(p)

    for aid in stale:
        store.delete_asset(aid)
    return len(made)


def _app_pool(p):
    """The images allowed as the app shot on THIS video.

    `app` holds one deal's own material, so a Regen video must never reach for a
    Roast screen, which is exactly what it did: the pool was every image in `app`
    and `inserts` regardless of who it belonged to. `inserts` is the general pile
    by design and still comes through on everything.

    Videos made before campaigns were attached carry an app name but no campaign id,
    so the id is recovered from the campaign names greenroom has already seen on
    other projects. HQ owns the campaign list; this only needs the mapping.
    """
    lib = [a for a in store.load_library()["items"] if a["type"] == "image"]
    general = [a for a in lib if a["folder"] == "inserts"]
    owned = [a for a in lib if a["folder"] == "app"]

    cid = ((p.get("campaign") or {}).get("id") or "").strip()
    if not cid:
        app = (p.get("app") or "").strip().lower()
        if not app:
            return general + [a for a in owned if not a.get("campaign")]
        # any campaign whose name carries the app name is that app's, the same rule
        # HQ uses to decide which formats a campaign can run
        ids = set()
        for row in store.list_projects():
            c = (row.get("campaign") or {})
            if c.get("id") and app in (c.get("name") or "").lower():
                ids.add(c["id"])
        return general + [a for a in owned
                          if not a.get("campaign") or a.get("campaign") in ids]

    # untagged material in `app` predates the split and is safe on anything
    return general + [a for a in owned
                      if not a.get("campaign") or a.get("campaign") == cid]


def _place_app_shots(p):
    """The scenes between the funnel and the payoff are the method, not the numbers:
    the model photo he swapped onto, the swapped result, and the app itself. Left to
    the ordinary fill they got another photo of the audience, which makes no sense
    over "I took a male model's photo and swapped my face with his"."""
    app = (p.get("app") or "").lower()
    lib = _app_pool(p)

    def tagged(tag):
        """Newest asset carrying an exact library collection tag.

        CTA assets are a matched set chosen in the Library: `og` is the original
        model, `result` is the face-swapped version, and the app name such as
        `regen` is its screenshot. These explicit tags beat fuzzy filenames.
        """
        hits = [a for a in lib if (a.get("collection") or "").strip().lower() == tag]
        return max(hits, key=lambda a: float(a.get("added") or 0)) if hits else None

    def find(*words):
        """Prefer an asset for this app, but take any that matches. Requiring the app
        name outright skipped "generated photo desert" and left the reveal on a photo
        of the audience."""
        hits = [a for a in lib if all(w in (a.get("name") or "").lower() for w in words)]
        if not hits:
            return None
        for a in hits:
            if app and app in (a.get("name") or "").lower():
                return a
        return hits[0]

    steps = [
        # what he is saying          -> which asset it wants
        (("male model", "stole a", "took a", "models photo", "model's photo", "model photo"),
         tagged("og") or find("model") or find("generated")),
        (("swap my face", "swap my", "swapped my face", "swapped my",
          "talked to my face", "talked my face",
          "with regen", "with roast", "face with"),
         tagged("result") or find("result") or find("generated")),
        (("i used regen", "i used roast", "i used the regen", "i used the roast",
          "i use regen", "i use roast",
          "used regen for", "used roast for", "use regen for", "use roast for",
          "used the regen for", "used the roast for",
          "using regen", "using roast", "using a regen", "using a roast",
          "with regen", "with roast", "regen for this", "roast for this"),
         tagged(app) or find("app screen") or find("app store")),
        (("upload", "uploaded", "dating apps", "dating profiles", "put this on hinge"),
         find("app screen 2") or find("app screen") or find("app store")),
        # he says some version of "you get so many normal women, you have to filter
        # through them" in nearly every video, and it wants the full inbox shot
        (("stacked", "maxed out", "normal women", "drowns out", "filter through",
          "so many matches", "hella matches", "fully maxed", "dms are still full",
          "my approach", "good for conversion"),
         tagged("hinge inbox") or find("hinge icon") or find("242 likes") or find("matches")),
    ]
    used = set()
    for keys, asset in steps:
        if not asset:
            continue
        for i, sc in enumerate(p["scenes"]):
            if i in used or (store.get_asset(sc.get("asset") or "") or {}).get("statsCard"):
                continue
            line = _scene_text(p, sc).lower()
            if any(k in line for k in keys):
                sc["asset"] = asset["id"]
                used.add(i)
                break

    _place_direct_match_bookends(p)


def _place_direct_match_bookends(p):
    """The matches-first cut opens on the inbox and closes on the conversation.

    Keep this separate from numeric card placement: the closing chat must not
    advance the stats cursor or displace the final result graphic.
    """
    if (p.get("funnel") or {}).get("basis") != "matches":
        return
    scenes = p.get("scenes") or []
    if len(scenes) < 2:
        return
    closing = next((sc for sc in reversed(scenes[1:])
                    if any(k in _scene_text(p, sc).lower()
                           for k in ("hella matches", "my approach", "good for conversion"))), None)
    if closing is None:
        return
    lib = store.load_library()["items"]
    chats = [a for a in lib if a.get("collection") == "funnel " + p.get("id", "")
             and a.get("statsCard") == "hinge swipes"]
    chat = max(chats, key=lambda a: float(a.get("added") or 0)) if chats else None
    inbox = store.get_asset(p.get("hingeInboxAsset") or "")
    if not inbox:
        inboxes = [a for a in _app_pool(p)
                   if (a.get("collection") or "").strip().lower() == "hinge inbox"]
        inbox = max(inboxes, key=lambda a: float(a.get("added") or 0)) if inboxes else None
        if inbox and inbox.get("id") == inbox_layout.TEMPLATE_ID:
            personalized = inbox_layout.create_asset(p, inbox)
            if personalized:
                inbox = personalized
                p["hingeInboxAsset"] = inbox["id"]
    if inbox:
        scenes[0]["asset"] = inbox["id"]
    if chat:
        closing["asset"] = chat["id"]


# "Snull came through last night", "I met up with Bella" - when he names someone he
# met, the shot wants to be that person's dating card, not another stock photo of the
# audience. He was making those by hand in the card form every time.
_MET = [
    re.compile(r"\b(?:met up with|matched with|linked up with|met|pulled up on)\s+"
               r"([A-Z][a-zA-Z]{2,12})\b"),
    re.compile(r"\b([A-Z][a-zA-Z]{2,12})\s+(?:came through|pulled up|slid into|hit me up)\b"),
]
# words that get capitalised mid sentence and are not people
_NOT_NAMES = {"Regen", "Roast", "Hinge", "Tinder", "Bumble", "Instagram", "Snapchat",
              "TikTok", "OnlyFans", "The", "This", "That", "But", "And", "So", "Then",
              "Out", "Now", "After", "Before", "Essentially", "Unfortunately", "Anyway",
              "I", "It", "We", "They", "She", "He", "You", "My", "Day"}


# The CTA is a fixed little sequence and each beat wants its own picture: the model
# photo, the swap, the app. He says it in one breath though ("all I did was take a
# model's photo and swap my face with his"), so pause-based splitting leaves it as one
# scene and only the first beat gets a picture. Same treatment as the funnel steps.
CTA_BEATS = [
    # NOTE the apostrophes: the matcher strips them, so "model's" becomes "models"
    # and a needle written as "take a model" never matches "take a model's photo".
    ["took a model's", "took a male model", "stole a male model", "stole a model's",
     "take a model's", "take a male model", "a male model's", "male models photo",
     "male model", "a model's photo", "took a models", "take a models"],
    ["swap my face", "swapped my face", "swapped my", "swapped his face", "swap his face",
     "talked to my face", "talked my face"],
    ["i used regen", "i used roast", "i used the regen", "i used the roast",
     "i use regen", "i use roast",
     "used regen for", "used roast for", "use regen for", "use roast for",
     "used the regen for", "used the roast for",
     "using regen", "using roast", "using a regen", "using a roast"],
    # The proof after the app is a fresh visual beat, not another sentence under
    # the app screen.
    ["this also gets me matches", "it also gets me matches",
     "this method already gets me", "this method gets me",
     "this is also how i get matches", "this is also the same way i get matches",
     "and i know this method works", "i know this method works"],
    ["then upload", "upload this on", "upload these", "on my dating"],
]


def _cta_scenes(p):
    """Give each beat of the CTA its own scene, so each can carry its own picture."""
    if not p.get("scenes") or not p.get("words") or not p.get("breaks"):
        return
    toks = _funnel_tokens(p)
    existing = sorted(set(int(b) for b in p["breaks"]))
    anchors, floor = [], -1
    for beat in CTA_BEATS:
        hit = _find_after(toks, beat, floor + 1)
        if hit is None:
            continue
        # If a scene already starts inside this beat, that break IS the boundary and
        # inventing another one just carves a two word sliver off the line before it.
        # Walking back from "take a model's photo" hit the "so" in "so many," and left
        # a scene containing exactly that. Reuse the real break when there is one.
        clause = _clause_start(p["words"], hit, floor)
        prior = [b for b in existing if clause <= b <= hit]
        start = max(prior) if prior else clause
        if start > floor:
            anchors.append(start)
            floor = start
    if len(anchors) < 2:
        return                       # nothing to separate
    breaks = sorted(set(int(b) for b in p["breaks"]) | set(anchors))
    # _funnel_scenes intentionally creates short scenes such as "Then 382 replied"
    # so the reply card begins on its own number. CTA splitting used to discard that
    # boundary as a short non-CTA scene, shifting every later card one scene late.
    protected = set(anchors) | set(p.get("funnelAnchors") or ()) | {0}
    n = len(p["words"])
    trimmed = []
    for j, b in enumerate(breaks):
        end = breaks[j + 1] if j + 1 < len(breaks) else n
        if b not in protected and end - b < MIN_SCENE_WORDS:
            continue
        if b not in protected and trimmed:
            prev = " ".join(w["w"] for w in p["words"][trimmed[-1]:b])
            cur = " ".join(w["w"] for w in p["words"][b:end])
            if _continues(prev, cur):
                continue
        trimmed.append(b)
    if trimmed != sorted(set(p["breaks"])):
        p["breaks"] = trimmed
        p["scenes"] = pipeline.scenes_from_breaks(p["words"], trimmed, existing=p.get("scenes"))


def _place_named_cards(p):
    """Make a dating card for anyone he names as having met, and put it on that scene.

    Whatever whisper heard is the name on the card ON PURPOSE: it has to match what
    the voiceover says, and if he said "Snull" then "Snull" is what is on screen.
    """
    if not p.get("scenes") or not p.get("words"):
        return
    a = formats.audience(p.get("audience")) or {}
    coll = a.get("collection")
    if not coll:
        return
    mine = f"cards {p['id']}"
    lib = store.load_library()["items"]
    made = {x.get("cardName"): x for x in lib if x.get("collection") == mine}
    # photos of the right group, best faces first, skipping ones already on a scene
    used = {sc.get("asset") for sc in p["scenes"]}
    pool = [x for x in lib if x.get("collection") == coll and x["type"] == "image"
            and x["folder"] == "people" and x["id"] not in used]
    pool.sort(key=lambda x: 0 if x.get("faceFrom") == "face" else 1)
    if not pool:
        return

    for i, sc in enumerate(p["scenes"]):
        line = _scene_text(p, sc)
        name = None
        for rx in _MET:
            m = rx.search(line)
            if m and m.group(1) not in _NOT_NAMES:
                name = m.group(1)
                break
        if not name:
            continue
        item = made.get(name)
        if item is None:
            if not pool:
                return
            photo = pool.pop(0)
            kind = "match" if "matched with" in line.lower() else "like"
            # a like card has a strip at the top showing the photo of HIS that she
            # liked. Leaving it out renders an empty grey box, which is the tell.
            top = next((x["id"] for x in lib
                        if "my liked photo" in (x.get("name") or "").lower()), None)
            recipe = {"kind": kind, "name": name, "age": "",
                      "promptLabel": "The way to win me over is",
                      "promptAnswer": "good banter and better food",
                      "message": "majestic ahhh", "pronouns": "she/her/hers",
                      "coverFace": False, "photoAsset": photo["id"],
                      "topPhotoAsset": top if kind == "like" else None}
            try:
                img = _render_card(recipe)
            except Exception:
                continue
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            item = store.add_library_file(
                "hinge", f"{store.safe_name(name)}_{kind}.png", content=buf.getvalue(),
                name=f"{kind} {name}",
                meta={"recipe": recipe, "collection": mine, "cardName": name})
            made[name] = item
        sc["asset"] = item["id"]


def _app_shot(p, line):
    """An app screenshot for a line that names the app, or None.

    A retake dropped in mid video is nearly always the app mention he forgot ("I used
    Regen for this"), and the ordinary fill hands that scene another photo of the
    audience, which is the one thing the line is definitely not about."""
    app = (p.get("app") or "").lower()
    names = [n.lower() for n in (formats.app_names(formats.parse(p.get("format")) or {}) or [])]
    if not any(n and n in line for n in ([app] + names)):
        return None
    lib = _app_pool(p)
    for want in ("app screen", "app store"):
        hits = [a for a in lib if want in (a.get("name") or "").lower()]
        for a in hits:
            if app and app in (a.get("name") or "").lower():
                return a["id"]
        if hits:
            return hits[0]["id"]
    return None


def _fill_gaps(p):
    """Nothing leaves this function with a blank scene. Rebuilding the cards can
    orphan a scene whose old card has gone, and a scene with no image renders as the
    grey placeholder."""
    coll = formats.images_for(p.get("format"), p.get("audience"))
    pool = [a for a in store.load_library()["items"]
            if a.get("collection") == coll and a["type"] == "image" and not a.get("statsCard")]
    if not pool:
        return
    import random
    taken = {sc.get("asset") for sc in p["scenes"]}
    spare = [a for a in pool if a["id"] not in taken] or pool
    random.shuffle(spare)
    k = 0
    for sc in p["scenes"]:
        if not store.get_asset(sc.get("asset") or ""):
            sc["asset"] = spare[k % len(spare)]["id"]
            k += 1


def _carry_charts(p):
    # a scene that is the back half of a chart's sentence keeps that chart, the same
    # way a continuation keeps its photo. "Out of those 1,455," is still the replied
    # step, so dropping back to a photo there changes the picture mid sentence.
    for i in range(1, len(p["scenes"])):
        prev = store.get_asset(p["scenes"][i - 1].get("asset") or "")
        here = store.get_asset(p["scenes"][i].get("asset") or "")
        if prev and prev.get("statsCard") and not (here or {}).get("statsCard"):
            # never carry a chart past the point where the funnel turns to the next
            # step: the scenes are cut on those turns now, so a chart crossing one is
            # last step's picture sitting over this step's line
            if p["scenes"][i]["start"] in set(p.get("funnelAnchors") or ()):
                continue
            line = _scene_text(p, p["scenes"][i]).lower()
            # ...unless this is where the reveal starts. That sentence often runs on
            # from the last figure, but the picture belongs to the method now, not
            # to the chart.
            reveal = any(k in line for k in (
                "show you how", "how i got", "how i actually got", "essentially",
                "i stole", "i took a", "male model", "swapped my face", "let me show"))
            if not reveal and _continues(_scene_text(p, p["scenes"][i - 1]), line):
                p["scenes"][i]["asset"] = prev["id"]


def _auto_sort(p):
    """Work out which format a recording is by what he says in it.

    For a batch upload he picks the campaign once and drops the lot in; each video
    is sorted here, after the transcript exists. Only ever runs when no format was
    chosen by hand, and only picks from the formats that campaign could use.

    The confidence is kept so an uncertain one can be flagged rather than quietly
    filed in the wrong place."""
    if p.get("format") or not p.get("words"):
        return
    cut = set(p.get("cutWords") or [])
    text = " ".join(w["w"] for i, w in enumerate(p["words"]) if i not in cut)
    cam = p.get("campaign") or {}
    fid, aid, conf, why = formats.classify(text, cam.get("id", ""), cam.get("name", ""))
    if not fid:
        return
    p["format"] = fid
    if aid and not p.get("audience"):
        p["audience"] = aid
    # a format with its own pile of photos is not about a group, so a missing
    # audience there is correct rather than something to flag
    needs_aud = not (formats.parse(fid) or {}).get("collection")
    p["sortedBy"] = {"confidence": conf, "matched": why, "audienceFound": bool(aid)}
    bits = []
    if conf < 0.5:
        bits.append("the format was a close call")
    if needs_aud and not aid:
        bits.append("could not tell who it is about")
    if bits:
        p["warning"] = "Sorted automatically, but " + " and ".join(bits) + ". Worth checking."


def _apply_format(p, refill=True):
    """Everything the format and audience decide, applied in one place at ingest: the
    app tag, the hook text, and the green screen images pulled from the audience's
    collection. Called once the transcript and scenes exist.

    `refill` is off when the format is changed on a video that already exists, so
    switching it does not wipe scene images he has already chosen; the editor's
    "Redo hook and images" button is what asks for that explicitly.
    """
    fid, aid = p.get("format"), p.get("audience")
    f = formats.parse(fid)
    if not f:
        return
    p["app"] = formats.app_for_campaign(fid, (p.get("campaign") or {}).get("name", ""))
    hook = p.get("hook") or {}
    if not (hook.get("text") or "").strip():
        text = formats.hook_for(fid, aid, p.get("words"),
                                _format_seq(fid, p.get("id"), p.get("created")),
                                n=(p.get("funnel") or {}).get("sent"))
        direct_matches = (p.get("funnel") or {}).get("basis") == "matches"
        if direct_matches:
            audience_word = (formats.audience(aid) or {}).get("word") or "Hinge"
            text = f"Matched with {p['funnel']['opened']:,} {audience_word}"
        if text:
            # a grid hook wants the title big and high, clear of his head; a single
            # background photo wants it smaller and lower down, as it always was
            base = dict(pipeline.GRID_HOOK_TEXT) if f.get("hookCollage") else STOCK_HOOK
            if direct_matches:
                base = dict(pipeline.MATCH_HOOK_TEXT)
            keep = dict(hook)
            # 66 at 0.45 is what a blank project is born with, so it means "nobody has
            # set this", not "he chose it". Without dropping it, the format's own
            # layout could never win and the title stayed small and low.
            if (round(float(keep.get("size", 85)), 3) == STOCK_HOOK["size"]
                    and abs(float(keep.get("y", 0.45)) - STOCK_HOOK["y"]) < 1e-9):
                keep.pop("size", None)
                keep.pop("y", None)
            p["hook"] = {**base, **keep, "text": text,
                         "style": f.get("hookStyle") or "bg"}
    if refill:
        _fill_from_collection(p, formats.images_for(fid, aid))
        # The CTA is the same three beats in every video for a given app: the model
        # photo, the swap, then the app itself. It was only being placed on the DM
        # funnel format, so on every other video he was picking those three by hand
        # each time. It is the same sequence, so it runs everywhere now.
        _cta_scenes(p)
        _place_app_shots(p)
        _place_named_cards(p)
    _place_hook_scene(p, f)


def _place_hook_scene(p, f):
    """Apply the format's opening cutout preset without undoing manual placement.

    Everywhere else he sits in a corner so the photo behind him is readable, but the
    hook is four photos at once with the title above, and he belongs in the middle of
    it. Only moves a scene still on an automatic placement, so anything Logan dragged
    himself is left exactly where he put it."""
    direct_matches = (p.get("funnel") or {}).get("basis") == "matches"
    if not (f.get("hookCollage") or direct_matches) or not p.get("scenes"):
        return
    sc = p["scenes"][0]
    auto = {(round(s, 4), round(x, 4))
            for s, x in (*pipeline.PLACEMENTS, *pipeline.LEGACY_PLACEMENTS)}
    key = (round(float(sc.get("headScale", 1.0)), 4), round(float(sc.get("headX", 0.0)), 4))
    if key in auto and abs(float(sc.get("headY", 0.0))) < 1e-9:
        scale, dx, dy = (pipeline.MATCH_HOOK_PLACEMENT if direct_matches
                         else pipeline.GRID_HOOK_PLACEMENT)
        sc.update(headScale=scale, headX=dx, headY=dy)


def _ingest(pid):
    p = store.load_project(pid)
    try:
        pdir = store.project_dir(pid)
        src = os.path.join(pdir, p["source"])
        p.update(status="processing", progress=0.03)
        store.save_project(p)

        raw_info = probe(src)
        p.update(duration=raw_info["duration"], progress=0.06)
        store.save_project(p)

        wav = os.path.join(pdir, "audio.wav")
        extract_audio(src, wav)
        p.update(progress=0.1)
        store.save_project(p)

        # single color-managed bt709 file everything downstream reads, keeping the
        # source frame rate (60fps stays 60 so motion isn't choppy)
        norm = os.path.join(pdir, "normalized.mp4")
        cinfo = normalize_source(src, norm, target_fps=target_fps_for(raw_info["fps"]))
        ninfo = probe(norm)
        p.update(normalized="normalized.mp4", hdrSource=cinfo["hdr"], sourceFps=raw_info["fps"],
                 fps=cinfo["fps"], width=ninfo["width"], height=ninfo["height"],
                 duration=ninfo["duration"], progress=0.25)
        store.save_project(p)

        campaign_name = ((p.get("campaign") or {}).get("name") or "")
        words, _dur = pipeline.transcribe(wav, app=p.get("app") or campaign_name)
        toks = {w["w"].lower().strip(".,?!") for w in words}
        app_tag = "regen" if "regen" in toks else ("halo" if "halo" in toks else "")
        # name the project by its spoken opening so the home page reads like content,
        # not filenames; the original filename is kept in sourceName
        opening = " ".join(w["w"] for w in words[:8]).strip(" .,!?")
        if len(opening) > 44:
            opening = opening[:44].rsplit(" ", 1)[0]
        p.update(words=words, app=p.get("app") or app_tag,
                 sourceName=p["name"], name=opening or p["name"], progress=0.55)
        store.save_project(p)

        rms = RmsEnvelope.from_wav(wav)
        rms.save(os.path.join(pdir, "rms.json"))
        cut, auto_info = pipeline.detect_auto_cuts(words)
        p.update(cutWords=sorted(cut), autoCuts=auto_info)

        groups = _rebuild_segments(p, pdir)
        breaks = pipeline.default_breaks(words, groups)
        p["breaks"] = breaks
        # scenes_from_breaks already cycles PLACEMENTS, so the cutout alternates
        # size and side by itself, no dragging per scene
        p["scenes"] = pipeline.scenes_from_breaks(words, breaks)
        _auto_sort(p)
        _read_funnel(p)          # the hook needs the real figure, not the stock one
        _funnel_scenes(p)        # regroup onto the funnel steps before cards are hung
        _apply_format(p)
        _apply_stats_cards(p)
        p["progress"] = 0.6
        store.save_project(p)

        # RVM matte pass (the slow part, ~real time); mediapipe fallback if it can't run
        try:
            from .matte import build_matte

            def mprog(v):
                p["progress"] = round(0.6 + 0.35 * v, 3)
                store.save_project(p)

            fps = int(cinfo["fps"])
            build_matte(norm, os.path.join(pdir, "matte.mp4"),
                        ninfo["width"], ninfo["height"], fps,
                        int(p["duration"] * fps), progress=mprog,
                        log_path=os.path.join(pdir, "matte.log"),
                        throttle=_user_gate.wait)
            p.update(matte="matte.mp4", matteEngine="rvm")
            # clear only OUR warning from a previous run. Blanking the field wiped
            # the "check how this got sorted" note that _auto_sort had just set.
            if "cutout" in (p.get("warning") or ""):
                p["warning"] = ""
        except Exception as me:
            traceback.print_exc()
            p.update(matte=None, matteEngine="mediapipe",
                     warning=f"high quality cutout unavailable ({me}), using fallback")
        p["progress"] = 0.97
        store.save_project(p)

        _ensure_thumbs(p)
        p.update(status="ready", progress=1.0, rev=p.get("rev", 0) + 1)
        store.save_project(p)
    except Exception as e:
        traceback.print_exc()
        p.update(status="error", error=str(e))
        store.save_project(p)


def _rebuild_segments(p, pdir):
    """Recompute the cut list from words + cutWords + gapCut, snapping to audio energy."""
    rms_path = os.path.join(pdir, "rms.json")
    wav = os.path.join(pdir, "audio.wav")
    if not os.path.exists(rms_path) and os.path.exists(wav):
        RmsEnvelope.from_wav(wav).save(rms_path)
    rms = RmsEnvelope.load(rms_path) if os.path.exists(rms_path) else None
    segments, groups = pipeline.build_segments(
        p["words"], p["duration"], gap_cut=p.get("gapCut", 0.2),
        cut=set(p.get("cutWords") or []), rms=rms,
        keep_gaps=set(p.get("keepGaps") or []))
    p["segments"] = segments
    p["outDuration"] = round(Timeline(segments).out_dur, 2)
    return groups


def _ensure_thumbs(p):
    """Source-frame thumbnail for every scene start word."""
    pdir = store.project_dir(p["id"])
    src = os.path.join(pdir, p.get("normalized") or p["source"])
    os.makedirs(os.path.join(pdir, "thumbs"), exist_ok=True)
    for sc in p.get("scenes", []):
        idx = sc["start"]
        out = os.path.join(pdir, "thumbs", f"w{idx}.jpg")
        if os.path.exists(out) or not p["words"]:
            continue
        t = p["words"][min(idx, len(p["words"]) - 1)]["s"]
        try:
            from PIL import Image
            frame = grab_frame(src, t + 0.05)
            img = Image.fromarray(frame)
            img.thumbnail((240, 426))
            img.save(out, quality=82)
        except Exception:
            pass


def _begin_project(filename, name, fmt, audience, campaign_id, campaign_name):
    """Make the project record and say where its recording goes.

    Split out so a one shot upload and a chunked one agree on everything except
    how the bytes arrive. Returns (project, dest path, source filename)."""
    if store.asset_type(filename) != "video":
        raise HTTPException(400, "need a video file")
    p = store.create_project(name or os.path.splitext(filename)[0])
    if formats.parse(fmt):
        p["format"] = fmt
    if formats.audience(audience):
        p["audience"] = audience
    if campaign_id or campaign_name:
        p["campaign"] = {"id": campaign_id, "name": campaign_name}
    src_name = "source" + os.path.splitext(filename)[1].lower()
    return p, os.path.join(store.project_dir(p["id"]), src_name), src_name


def _queue_project(p, src_name):
    p.update(source=src_name, status="queued")
    store.save_project(p)
    _work_q.put(("ingest", p["id"]))
    return p


@app.post("/api/projects")
async def create_project(file: UploadFile = File(...), name: str = Form(""),
                         format: str = Form(""), audience: str = Form(""),
                         campaignId: str = Form(""), campaignName: str = Form("")):
    p, dest, src_name = _begin_project(file.filename, name, format, audience,
                                       campaignId, campaignName)
    with open(dest, "wb") as f:
        while True:
            chunk = await file.read(1 << 22)
            if not chunk:
                break
            f.write(chunk)
    return _queue_project(p, src_name)


# ---- chunked upload -------------------------------------------------------
# Cloudflare refuses a request body over 100 MB, so a whole recording can never
# come through in one request: measured on his own zone, a 150 MB POST is cut off
# with a 413 after about 2 MB. His iPhone files are routinely 200 MB plus, so the
# browser sends them in parts and these three endpoints put the file back
# together before the normal ingest starts.
UPLOADS = os.path.join(store.DATA, "uploads")


def _upload_dir(uid):
    """Resolve an upload id to its parts directory, refusing anything shaped
    differently so a crafted id cannot walk out of the uploads folder."""
    if not (uid.startswith("u_") and len(uid) == 12 and uid[2:].isalnum()):
        raise HTTPException(404, "no such upload")
    d = os.path.join(UPLOADS, uid)
    if not os.path.isdir(d):
        raise HTTPException(404, "no such upload")
    return d


def _sweep_uploads(max_age=86400):
    """An upload abandoned halfway leaves its parts on disk, and these are big.
    Clear the old ones whenever a new upload starts."""
    if not os.path.isdir(UPLOADS):
        return
    now = time.time()
    for name in os.listdir(UPLOADS):
        d = os.path.join(UPLOADS, name)
        try:
            if os.path.isdir(d) and now - os.path.getmtime(d) > max_age:
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass


@app.post("/api/uploads")
async def start_upload(request: Request):
    body = await request.json()
    filename = str(body.get("filename") or "")
    if store.asset_type(filename) != "video":
        raise HTTPException(400, "need a video file")
    # a batch is starting: hold the machine before the first part rather than after
    _note_upload()
    _sweep_uploads()
    uid = "u_" + uuid.uuid4().hex[:10]
    os.makedirs(os.path.join(UPLOADS, uid), exist_ok=True)
    return {"id": uid}


@app.post("/api/uploads/{uid}/parts/{index}")
async def upload_part(uid: str, index: int, request: Request):
    # take the machine off ingest for the rest of this batch, so a video that
    # already landed is not rendering while the next one is still coming up
    _note_upload()
    d = _upload_dir(uid)
    if not 0 <= index <= 9999:
        raise HTTPException(400, "part out of range")
    # A retry can arrive before the edge has fully released the previous request.
    # Give each request its own scratch file so overlapping attempts cannot truncate,
    # delete or rename one another's bytes.
    tmp = os.path.join(d, "%05d.%s.tmp" % (index, uuid.uuid4().hex[:8]))
    # The edge occasionally closes its upstream body early but still presents a
    # clean end of stream. Without an expected size that partial file looks valid,
    # gets renamed to .part and corrupts the assembled video. New clients send the
    # explicit header. An older tab without it must refresh, because an edge supplied
    # Content-Length can describe the already truncated body rather than the file
    # slice the browser intended to send.
    expected_raw = request.headers.get("x-upload-bytes")
    if not expected_raw:
        raise HTTPException(428, "refresh the page before uploading")
    try:
        expected = int(expected_raw)
    except ValueError:
        raise HTTPException(400, "invalid upload size")
    if expected < 0:
        raise HTTPException(400, "invalid upload size")
    n = 0
    try:
        with open(tmp, "wb") as f:
            async for chunk in request.stream():
                f.write(chunk)
                n += len(chunk)
    except ClientDisconnect:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise HTTPException(400, "upload part disconnected")
    if n != expected:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise HTTPException(400, "upload part incomplete")
    # named last, so a part whose connection died halfway is never mistaken for a
    # good one when the file is reassembled
    os.replace(tmp, os.path.join(d, f"{index:05d}.part"))
    return {"ok": True, "bytes": n}


@app.get("/api/uploads/{uid}")
def upload_status(uid: str):
    """Which parts of this upload already arrived.

    A browser refresh loses the file bytes, so the page cannot simply carry on.
    What it can do is ask what already landed and send only the rest, once he
    picks the same recording again. Parts survive for a day, same as the sweep.
    """
    try:
        d = _upload_dir(uid)
    except HTTPException:
        return {"id": uid, "parts": []}
    if not os.path.isdir(d):
        return {"id": uid, "parts": []}
    parts = sorted(int(f[:-5]) for f in os.listdir(d) if f.endswith(".part"))
    return {"id": uid, "parts": parts}


@app.post("/api/uploads/{uid}/finish")
async def finish_upload(uid: str, request: Request):
    d = _upload_dir(uid)
    body = await request.json()
    parts = sorted(f for f in os.listdir(d) if f.endswith(".part"))
    expected = int(body.get("parts") or 0)
    if not parts:
        raise HTTPException(400, "no parts arrived")
    if expected and len(parts) != expected:
        raise HTTPException(400, f"only {len(parts)} of {expected} parts arrived")
    p, dest, src_name = _begin_project(str(body.get("filename") or ""),
                                       str(body.get("name") or ""),
                                       str(body.get("format") or ""),
                                       str(body.get("audience") or ""),
                                       str(body.get("campaignId") or ""),
                                       str(body.get("campaignName") or ""))
    with open(dest, "wb") as out:
        for name in parts:
            with open(os.path.join(d, name), "rb") as f:
                shutil.copyfileobj(f, out, 1 << 22)
    shutil.rmtree(d, ignore_errors=True)
    return _queue_project(p, src_name)


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    try:
        return store.load_project(pid)
    except FileNotFoundError:
        raise HTTPException(404, "no such project")


@app.delete("/api/projects/{pid}")
def delete_project(pid: str):
    store.delete_project(pid)
    _previews.pop(pid, None)
    return {"ok": True}


def _bump(p):
    p["rev"] = p.get("rev", 0) + 1
    _previews.pop(p["id"], None)


def _patch(pid, **fields):
    """Reload-update-save so a background job never clobbers concurrent edits."""
    p = store.load_project(pid)
    p.update(fields)
    store.save_project(p)
    return p


@app.post("/api/projects/{pid}/breaks")
def set_breaks(pid: str, body: dict):
    p = store.load_project(pid)
    breaks = body.get("breaks", [])
    p["breaks"] = sorted(set(int(b) for b in breaks) | {0})
    p["scenes"] = pipeline.scenes_from_breaks(p["words"], p["breaks"], existing=p.get("scenes"))
    _bump(p)
    store.save_project(p)
    _ensure_thumbs(p)
    return p


@app.post("/api/projects/{pid}/scenes/{index}/remove")
def remove_scene(pid: str, index: int):
    """Delete a scene outright: its words are cut from the video, not handed to a neighbour.

    Dropping the break alone only merges, because a scene is just the span between
    two breaks and its words carry on being spoken. Removing the section for real
    means cutting those words as well, and the two have to happen together: doing
    them as two calls from the browser re-derives the scenes in between, so the
    second call is working off indices the first one already moved.
    """
    p = store.load_project(pid)
    scenes = p.get("scenes") or []
    if not 0 <= index < len(scenes):
        raise HTTPException(404, "no such scene")
    if len(scenes) < 2:
        raise HTTPException(400, "a video needs at least one scene")

    sc = scenes[index]
    lo, hi = int(sc["start"]), int(sc["end"])
    cut = set(p.get("cutWords") or [])
    cut |= set(range(lo, hi + 1))
    p["cutWords"] = sorted(i for i in cut if 0 <= i < len(p["words"]))

    # scene 1 opens at word 0 and break 0 always exists, so for the first scene it
    # is the following break that has to go instead
    drop = scenes[1]["start"] if index == 0 else lo
    p["breaks"] = sorted(b for b in p["breaks"] if b != drop)
    p["scenes"] = pipeline.scenes_from_breaks(p["words"], p["breaks"], existing=p.get("scenes"))

    _rebuild_segments(p, store.project_dir(pid))
    _bump(p)
    store.save_project(p)
    _ensure_thumbs(p)
    return p


@app.post("/api/projects/{pid}/scenes")
def set_scenes(pid: str, body: dict):
    p = store.load_project(pid)
    incoming = {s["start"]: s for s in body.get("scenes", [])}
    for sc in p["scenes"]:
        upd = incoming.get(sc["start"])
        if upd:
            for k in ("asset", "hideHead", "headScale", "headX", "headY", "label",
                      "overlayAsset", "overlayWord", "overlayDuration",
                      "overlayScale", "overlayX", "overlayY"):
                if k in upd:
                    sc[k] = upd[k]
    _bump(p)
    store.save_project(p)
    return p


@app.post("/api/projects/{pid}/settings")
def set_settings(pid: str, body: dict):
    p = store.load_project(pid)
    if "captions" in body:
        p["captions"].update(body["captions"])
    if "hook" in body:
        p.setdefault("hook", {"text": "", "y": 0.45, "size": 85}).update(body["hook"])
    if "music" in body:
        p.setdefault("music", {"enabled": True, "file": "gymnopedie1.mp3", "volume": 0.07}).update(body["music"])
    if "app" in body:
        p["app"] = str(body["app"] or "")[:20]
    if "audience" in body:
        aid = str(body["audience"] or "")
        p["audience"] = aid if formats.audience(aid) else ""
    if "format" in body:
        fid = str(body["format"] or "")
        p["format"] = fid if formats.parse(fid) else ""
        # changing format after ingest re-derives what the format owns, but leaves
        # the scene images alone unless he explicitly asks for a redo
        if p["format"] and p.get("words"):
            reapply = bool(body.get("reapply"))
            if reapply:
                p["hook"] = {**(p.get("hook") or {"y": 0.45, "size": 85}), "text": ""}
            _apply_format(p, refill=reapply)
    if "campaign" in body:
        c = body["campaign"] or {}
        p["campaign"] = {"id": str(c.get("id") or "")[:60], "name": str(c.get("name") or "")[:80]}
        # a format can run under more than one deal, so the app tag follows the
        # campaign; without this, moving a video to Roast leaves it tagged regen
        if p.get("format"):
            p["app"] = formats.app_for_campaign(p["format"], p["campaign"]["name"])
    if "posted" in body:
        p["posted"] = bool(body["posted"])
    # Downloading a render sets this on its own, and until now nothing could unset
    # it: one accidental click parked a video under Downloaded for good.
    if "downloaded" in body:
        p["downloaded"] = bool(body["downloaded"])
    if "name" in body:
        p["name"] = str(body["name"])[:80]
    if "gapCut" in body:
        p["gapCut"] = max(0.15, min(2.0, float(body["gapCut"])))
        groups = _rebuild_segments(p, store.project_dir(pid))
        if body.get("reproposeScenes"):
            p["breaks"] = pipeline.default_breaks(p["words"], groups)
            p["scenes"] = pipeline.scenes_from_breaks(p["words"], p["breaks"], existing=p.get("scenes"))
            # reproposing from pauses alone would undo the funnel grouping, so put it
            # straight back for the formats that have one
            _funnel_scenes(p)
            _ensure_thumbs(p)
    _bump(p)
    store.save_project(p)
    return p


def _scene_text(p, sc):
    """What is actually said during a scene, used to pick a matching shot."""
    words = p.get("words") or []
    lo, hi = int(sc.get("start", 0)), int(sc.get("end", -1))
    if hi < lo:
        hi = len(words) - 1
    return " ".join(w["w"] for w in words[lo:hi + 1])


def _continues(prev_text, text):
    """Whether this scene is the back half of the sentence before it.

    Scenes are cut on pauses, so "A photo in a fitted shirt, / not the one you sleep
    in." becomes two scenes. It is still one shot being described, and giving the
    second half its own photo makes the picture change mid sentence."""
    prev, cur = (prev_text or "").strip(), (text or "").strip()
    if not prev or not cur:
        return False
    # whisper punctuates, so an unfinished sentence is a reliable signal, and a
    # lowercase opening word says the same thing from the other side
    unfinished = not prev.rstrip('"\'').endswith((".", "!", "?"))
    lower_start = cur[0].islower()
    return unfinished or lower_start


def _fill_from_collection(p, coll, plan=None):
    """Give every scene an image from `coll`, preferring one whose shot type matches
    what he says during that scene ("a simple travel shot" gets a travel photo).
    Falls back to any unused image, so a half-tagged library still fills.

    Returns how many scenes were filled (0 when the collection has no images, which
    is not an error at ingest)."""
    import random
    items = [a for a in store.load_library()["items"]
             if a.get("collection") == coll and a["type"] == "image"
             and a["folder"] in ("people", "backgrounds", "extra", "hinge")
             # a generated stat card is not a photo of anybody. One had been left
             # tagged to an audience without the flag and could be drawn as a random
             # background, so a funnel graphic turned up mid sentence in a day video.
             and not a.get("statsCard")
             # a hook grid belongs to the video it was built for; picking one up as
             # an ordinary background puts a 4 photo grid in the middle of a video
             and not a.get("collage")]
    if not items:
        return 0
    random.shuffle(items)
    by_kind = {}
    for a in items:
        by_kind.setdefault(a.get("kind") or "", []).append(a)

    used = set()
    # shots the script asked for that this collection simply has no photo of; worth
    # naming, because otherwise it silently substitutes and looks like a bad match
    p["_unmet"] = sorted({k for k in (plan or []) if k and k != "same" and k not in by_kind})

    def take(pool):
        for a in pool or ():
            if a["id"] not in used:
                return a
        return None

    prev_text, prev_asset = "", None
    for i, sc in enumerate(p["scenes"]):
        text = _scene_text(p, sc)
        want = (plan[i] if plan and i < len(plan) else "") or ""

        # the back half of a sentence keeps the photo the front half got, so the
        # picture does not change halfway through one line
        if prev_asset and (want == "same" or (not want and _continues(prev_text, text))):
            sc["asset"] = prev_asset
            prev_text = text
            continue

        kind = want if want != "same" else ""
        kind = kind or formats.shot_type_for(text)
        pick = take(by_kind.get(kind)) if kind else None
        pick = pick or take(items) or items[i % len(items)]
        sc["asset"] = pick["id"]
        used.add(pick["id"])
        prev_text, prev_asset = text, pick["id"]

    # a format like the 10/10 one opens on a grid of photos, not a single shot
    f = formats.parse(p.get("format")) or {}
    if f.get("hookCollage") and p["scenes"]:
        _collage_for_scene(p, p["scenes"][0], coll, f["hookCollage"])
    return len(p["scenes"])


def _collage_for_scene(p, sc, coll, count=4):
    """Build a grid of photos from `coll` and hang it on the scene as its background.

    The old collage is deleted as it is replaced, so reshuffling does not silt up
    the library with every grid he did not keep."""
    import random
    items = [a for a in store.load_library()["items"]
             if a.get("collection") == coll and a["type"] == "image"
             and a["folder"] in ("people", "backgrounds", "extra")
             and not a.get("collage")]
    if len(items) < 2:
        return None
    random.shuffle(items)
    # round robin across shot types, so the hook is not four near identical photos
    by_kind = {}
    for a in items:
        by_kind.setdefault(a.get("kind") or "", []).append(a)
    pools = list(by_kind.values())
    picks = []
    while len(picks) < count and any(pools):
        for pool in pools:
            if pool and len(picks) < count:
                picks.append(pool.pop())
    # library items carry folder + file, not a path; only resolve_asset builds one
    img = cards.collage([os.path.join(store.LIBRARY, a["folder"], a["file"]) for a in picks],
                        count=count)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92)
    item = store.add_library_file("extra", "hook_collage.jpg", content=buf.getvalue(),
                                  name=f"{count} up collage",
                                  meta={"collection": coll, "collage": {"count": count}})
    old = store.get_asset(sc.get("asset") or "")
    sc["asset"] = item["id"]
    _sweep_collages(p)
    return item


def _sweep_collages(current=None):
    """Bin any hook grid no video is showing any more.

    Deleting just the one being replaced was not enough: the fill assigns an
    ordinary photo to scene 1 first and only then builds the grid, so the grid it
    was replacing had already been forgotten and stayed in the library forever."""
    live = set()
    for sc in (current or {}).get("scenes") or ():
        for k in ("asset", "overlayAsset"):
            if sc.get(k):
                live.add(sc[k])
    for meta in store.list_projects():
        if current and meta["id"] == current.get("id"):
            continue
        try:
            other = store.load_project(meta["id"])
        except Exception:
            continue
        for sc in other.get("scenes") or ():
            for k in ("asset", "overlayAsset"):
                if sc.get(k):
                    live.add(sc[k])
    gone = 0
    for a in list(store.load_library()["items"]):
        if a.get("collage") and a["id"] not in live:
            store.delete_asset(a["id"])
            gone += 1
    return gone


@app.post("/api/projects/{pid}/collage")
def make_collage(pid: str, body: dict):
    """Replace one scene's background with a grid of photos. Call again to reshuffle."""
    p = store.load_project(pid)
    idx = int(body.get("scene") or 0)
    if not 0 <= idx < len(p["scenes"]):
        raise HTTPException(400, "no such scene")
    coll = (str(body.get("collection") or "").strip()
            or formats.images_for(p.get("format"), p.get("audience")))
    count = int(body.get("count") or 4)
    if not _collage_for_scene(p, p["scenes"][idx], coll, count):
        raise HTTPException(400, f"need at least 2 images tagged {coll}")
    _bump(p)
    store.save_project(p)
    return p


@app.get("/api/funnel")
def new_funnel(sent: int = 100000):
    """A fresh set of Hinge funnel numbers. Generated once and used for BOTH the stat
    cards and the script, so what he says matches what is on screen."""
    return stats.funnel(max(100, min(int(sent), 10_000_000)))


@app.get("/api/projects/{pid}/lines")
def scene_lines(pid: str):
    """What is said during each scene, so the shot each line calls for can be worked
    out properly rather than guessed from keywords."""
    p = store.load_project(pid)
    return {"lines": [_scene_text(p, sc) for sc in p["scenes"]],
            "shotTypes": formats.all_shot_types()}


@app.post("/api/projects/{pid}/fill")
def fill_scenes(pid: str, body: dict):
    """Assign images from a collection to every scene: the heavy lifting for a series
    video, Logan swaps the few that need something specific. Reshuffles each call.

    `plan` is an optional shot type per scene; without it the keyword scan decides."""
    p = store.load_project(pid)
    coll = (str(body.get("collection") or "").strip()
            or formats.images_for(p.get("format"), p.get("audience")))
    plan = body.get("plan")
    plan = [str(x or "") for x in plan] if isinstance(plan, list) else None
    if not _fill_from_collection(p, coll, plan):
        raise HTTPException(400, f"no images tagged {coll}")
    unmet = p.pop("_unmet", [])
    _bump(p)
    store.save_project(p)
    return {**p, "unmet": unmet}


@app.post("/api/projects/{pid}/cuts")
def set_cuts(pid: str, body: dict):
    p = store.load_project(pid)
    n = len(p["words"])
    if body.get("auto"):
        cut, info = pipeline.detect_auto_cuts(p["words"])
        p["cutWords"] = sorted(set(p.get("cutWords") or []) | cut)
        p["autoCuts"] = info
    else:
        p["cutWords"] = sorted({int(i) for i in body.get("cutWords", []) if 0 <= int(i) < n})
    _rebuild_segments(p, store.project_dir(pid))
    _bump(p)
    store.save_project(p)
    return p


# ---------------- preview ----------------
def _renderer_for(p):
    from .renderer import Renderer
    with _preview_lock:
        cached = _previews.get(p["id"])
        if cached and cached["rev"] == p.get("rev", 0):
            return cached["renderer"]
        r = Renderer(p, store.project_dir(p["id"]), store.resolve_asset)
        _previews[p["id"]] = {"rev": p.get("rev", 0), "renderer": r}
        return r


@app.get("/api/projects/{pid}/scene_preview/{sidx}")
def scene_preview(pid: str, sidx: int):
    p = store.load_project(pid)
    if p.get("status") not in ("ready", "rendering", "done") or sidx >= len(p["scenes"]):
        raise HTTPException(409, "not ready")
    pdir = store.project_dir(pid)
    cache = os.path.join(pdir, "thumbs", f"scene{sidx}_rev{p.get('rev', 0)}.jpg")
    if not os.path.exists(cache):
        sc = p["scenes"][sidx]
        widx = min(sc["start"], len(p["words"]) - 1)
        tl = Timeline(p["segments"])
        src_t = p["words"][widx]["s"]
        t_out = min(tl.word_to_out(widx, src_t) + 0.35, max(0.0, tl.out_dur - 0.05))
        src_t2, seg_idx = tl.to_src(t_out)
        person_file = p.get("matte") or p["source"]
        frame = grab_frame(os.path.join(pdir, person_file), src_t2)
        r = _renderer_for(p)
        img = r.render_frame(t_out, src_frame=frame, seg_idx=seg_idx)
        img = img.resize((360, 640))
        img.save(cache, quality=85)
    return FileResponse(cache, media_type="image/jpeg")


@app.get("/api/projects/{pid}/hook_sprite")
def hook_sprite_png(pid: str):
    """The hook text exactly as the renderer draws it, for the editor stage."""
    p = store.load_project(pid)
    hk = p.get("hook") or {}
    if not str(hk.get("text") or "").strip():
        raise HTTPException(404, "no hook text")
    pdir = store.project_dir(pid)
    rev = p.get("rev", 0)
    os.makedirs(os.path.join(pdir, "previews"), exist_ok=True)
    cache = os.path.join(pdir, "previews", f"hook_rev{rev}.png")
    if not os.path.exists(cache):
        import glob
        for old in glob.glob(os.path.join(pdir, "previews", "hook_rev*.png")):
            os.remove(old)
        from .renderer import hook_sprite_for_settings
        spr = hook_sprite_for_settings(hk)
        if spr is None:
            raise HTTPException(404, "no hook text")
        spr.save(cache)
    return FileResponse(cache, media_type="image/png")


@app.get("/api/projects/{pid}/audio_preview")
def audio_preview(pid: str):
    """The edited voice track (all cuts applied), for checking the trim by ear."""
    p = store.load_project(pid)
    if p.get("status") not in ("ready", "rendering", "done") or not p.get("segments"):
        raise HTTPException(409, "not ready")
    pdir = store.project_dir(pid)
    rev = p.get("rev", 0)
    os.makedirs(os.path.join(pdir, "previews"), exist_ok=True)
    out = os.path.join(pdir, "previews", f"voice_rev{rev}.wav")
    if not os.path.exists(out):
        import glob
        for old in glob.glob(os.path.join(pdir, "previews", "voice_rev*.wav")):
            os.remove(old)
        concat_speech(os.path.join(pdir, "audio.wav"), p["segments"], out)
    return FileResponse(out, media_type="audio/wav")


# ---------------- fast editor preview ----------------
def _preview_job(pid):
    from .renderer import Renderer
    p = store.load_project(pid)
    _hold_gate()
    rev = p.get("rev", 0)
    pdir = store.project_dir(pid)
    os.makedirs(os.path.join(pdir, "previews"), exist_ok=True)
    fname = f"previews/preview_rev{rev}.mp4"
    out = os.path.join(pdir, fname)
    try:
        if not os.path.exists(out):
            import glob
            for old in glob.glob(os.path.join(pdir, "previews", "preview_rev*.mp4")):
                os.remove(old)
            _patch(pid, preview={"status": "running", "progress": 0.0, "rev": rev, "file": None})
            r = Renderer(p, pdir, store.resolve_asset, scale=1 / 3)

            def prog(v):
                _patch(pid, preview={"status": "running", "progress": round(v, 3),
                                     "rev": rev, "file": None})

            r.render(out, progress=prog, fps=min(30, int(p.get("fps") or 30)),
                     log_path=os.path.join(pdir, "preview_encode.log"),
                     preset="ultrafast", crf="26")
        _patch(pid, preview={"status": "done", "progress": 1.0, "rev": rev, "file": fname})
    except Exception as e:
        traceback.print_exc()
        _patch(pid, preview={"status": "error", "error": str(e), "rev": rev, "file": None})
    finally:
        _release_gate()


@app.post("/api/projects/{pid}/preview")
def start_preview(pid: str):
    p = store.load_project(pid)
    rev = p.get("rev", 0)
    pv = p.get("preview") or {}
    if pv.get("status") == "running" and pv.get("rev") == rev:
        return p
    cached = os.path.join(store.project_dir(pid), "previews", f"preview_rev{rev}.mp4")
    if os.path.exists(cached):
        return _patch(pid, preview={"status": "done", "progress": 1.0, "rev": rev,
                                    "file": f"previews/preview_rev{rev}.mp4"})
    t = threading.Thread(target=_preview_job, args=(pid,), daemon=True)
    _jobs[pid + ":preview"] = t
    t.start()
    return _patch(pid, preview={"status": "running", "progress": 0.0, "rev": rev, "file": None})


# ---------------- render ----------------
def _render_job(pid):
    from .renderer import Renderer
    p = store.load_project(pid)
    _hold_gate()
    try:
        pdir = store.project_dir(pid)
        n = len(p.get("renders", [])) + 1
        fname = f"renders/render_{n:03d}.mp4"
        out = os.path.join(pdir, fname)

        def prog(v):
            _patch(pid, progress=round(v, 3))

        _patch(pid, status="rendering", progress=0.0)
        r = Renderer(p, pdir, store.resolve_asset)
        r.render(out, progress=prog, log_path=os.path.join(pdir, "encode.log"))
        done = store.load_project(pid)
        done.setdefault("renders", []).append({"file": fname, "time": time.time(),
                                               "size": os.path.getsize(out)})
        done.update(status="done", progress=1.0)
        store.save_project(done)
    except Exception as e:
        traceback.print_exc()
        _patch(pid, status="error", error=str(e))
    finally:
        _release_gate()


def _upgrade(pid):
    """Rebuild an older project on the current pipeline: re-normalize at the real source
    frame rate and rebuild the RVM matte, keeping words, scenes, breaks and cuts."""
    p = store.load_project(pid)
    try:
        pdir = store.project_dir(pid)
        p.update(status="processing", progress=0.05)
        store.save_project(p)

        src = os.path.join(pdir, p["source"])
        raw = probe(src)
        norm = os.path.join(pdir, "normalized.mp4")
        cinfo = normalize_source(src, norm, target_fps=target_fps_for(raw["fps"]))
        ninfo = probe(norm)
        p.update(normalized="normalized.mp4", hdrSource=cinfo["hdr"], sourceFps=raw["fps"],
                 fps=cinfo["fps"], width=ninfo["width"], height=ninfo["height"],
                 duration=ninfo["duration"], progress=0.25)
        # captions default moved lower; nudge legacy projects that still sit at the old spot
        if abs(float(p.get("captions", {}).get("y", 0)) - 0.68) < 1e-6:
            p["captions"]["y"] = 0.80
        _rebuild_segments(p, pdir)
        store.save_project(p)

        try:
            from .matte import build_matte

            def mprog(v):
                p["progress"] = round(0.25 + 0.7 * v, 3)
                store.save_project(p)

            fps = int(cinfo["fps"])
            build_matte(norm, os.path.join(pdir, "matte.mp4"),
                        ninfo["width"], ninfo["height"], fps, int(p["duration"] * fps),
                        progress=mprog, log_path=os.path.join(pdir, "matte.log"),
                        throttle=_user_gate.wait)
            p.update(matte="matte.mp4", matteEngine="rvm")
            # clear only OUR warning from a previous run. Blanking the field wiped
            # the "check how this got sorted" note that _auto_sort had just set.
            if "cutout" in (p.get("warning") or ""):
                p["warning"] = ""
        except Exception as me:
            traceback.print_exc()
            p.update(matteEngine="mediapipe", warning=str(me))
        import glob
        for f in glob.glob(os.path.join(pdir, "thumbs", "*.png")) + \
                 glob.glob(os.path.join(pdir, "thumbs", "w*.jpg")) + \
                 glob.glob(os.path.join(pdir, "thumbs", "scene*_rev*.jpg")):
            os.remove(f)
        _ensure_thumbs(p)
        p.update(status="done" if p.get("renders") else "ready", progress=1.0,
                 rev=p.get("rev", 0) + 1)
        store.save_project(p)
    except Exception as e:
        traceback.print_exc()
        p.update(status="error", error=str(e))
        store.save_project(p)


def _append(pid):
    """Stitch one more recorded clip onto the end of a finished project: the clip gets
    the same normalize/transcribe/matte treatment, the project's files grow by concat,
    and the new words join the timeline as their own scene. Restart safe: appendBase
    remembers the pre-append durations, so every grow step checks before growing again."""
    p = store.load_project(pid)
    if not p.get("appendSrc"):
        return  # already completed (stale queue entry)
    try:
        pdir = store.project_dir(pid)
        clip = os.path.join(pdir, p["appendSrc"])
        p.update(status="processing", progress=0.03)
        store.save_project(p)

        norm = os.path.join(pdir, "normalized.mp4")
        if p.get("appendBase") is None:
            p.update(appendBase=probe(norm)["duration"], appendWordBase=len(p["words"]))
            store.save_project(p)
        base_dur = p["appendBase"]
        base_words = p["appendWordBase"]
        fps = int(p.get("fps") or target_fps_for(probe(norm)["fps"]))

        # the new clip through the same one-time transcode, locked to the project rate
        normb = os.path.join(pdir, "append_norm.mp4")
        normalize_source(clip, normb, target_fps=fps)
        binfo = probe(normb)
        p.update(progress=0.12)
        store.save_project(p)

        wavb = os.path.join(pdir, "append_audio.wav")
        extract_audio(clip, wavb)
        campaign_name = ((p.get("campaign") or {}).get("name") or "")
        words_b, _dur = pipeline.transcribe(wavb, app=p.get("app") or campaign_name)
        if not words_b:
            raise RuntimeError("could not hear any words in that clip, is it the right file?")
        for w in words_b:
            w["s"] = round(w["s"] + base_dur, 3)
            w["e"] = round(w["e"] + base_dur, 3)
        p.update(progress=0.3)
        store.save_project(p)

        # grow the matte pack (skipped when a restart already grew it)
        matte = os.path.join(pdir, "matte.mp4")
        if p.get("matte") and os.path.exists(matte) and \
                probe(matte)["duration"] < base_dur + binfo["duration"] - 0.5:
            from .matte import build_matte

            def mprog(v):
                p["progress"] = round(0.3 + 0.55 * v, 3)
                store.save_project(p)

            matteb = os.path.join(pdir, "append_matte.mp4")
            build_matte(normb, matteb, binfo["width"], binfo["height"], fps,
                        int(binfo["duration"] * fps), progress=mprog,
                        log_path=os.path.join(pdir, "matte.log"),
                        throttle=_user_gate.wait)
            concat_videos([matte, matteb], matte)
            os.remove(matteb)
        p.update(progress=0.88)
        store.save_project(p)

        # grow the normalized video and the voice wav (join padded to the video join)
        if probe(norm)["duration"] < base_dur + binfo["duration"] - 0.5:
            concat_videos([norm, normb], norm)
        wav = os.path.join(pdir, "audio.wav")
        if wav_duration(wav) < base_dur + binfo["duration"] - 0.5:
            append_wav(wav, wavb, wav, base_dur)
        RmsEnvelope.from_wav(wav).save(os.path.join(pdir, "rms.json"))

        # retakes/fillers detected inside the new clip only: run across the boundary,
        # the detector would read the video's old ending as a first take and cut it
        cut_b, _info = pipeline.detect_auto_cuts(words_b)

        p = store.load_project(pid)
        old_words = p["words"][:base_words]
        n = len(words_b)
        at = p.get("appendAfter")
        p["duration"] = probe(norm)["duration"]
        if at is None or not (0 <= at < base_words - 1):
            # the ordinary case: the retake goes on the end
            p["words"] = old_words + words_b
            p["cutWords"] = sorted(set(p.get("cutWords") or []) | {base_words + i for i in cut_b})
            p["breaks"] = sorted(set(int(b) for b in (p.get("breaks") or [])) | {base_words})
        else:
            # A line dropped into the MIDDLE. The media is still concatenated on the
            # end (that is where the new footage physically lives) and only the word
            # ORDER moves, because the word order is what the cut follows. Its source
            # timestamps stay pointing at the far end of the file, so build_segments
            # sees a huge jump and gives it its own segment, which is exactly right.
            # Everything indexed by word has to shift up around the hole.
            pos = at + 1
            shift = lambda i: i if i < pos else i + n
            p["words"] = old_words[:pos] + words_b + old_words[pos:]
            p["cutWords"] = sorted({shift(i) for i in (p.get("cutWords") or [])} |
                                   {pos + i for i in cut_b})
            # a break each side, so the new line is its own scene and the line it
            # interrupted picks up again on its own rather than swallowing it
            p["breaks"] = sorted({shift(int(b)) for b in (p.get("breaks") or [])} |
                                 {pos, pos + n})
            if p.get("keepGaps"):
                p["keepGaps"] = sorted(shift(int(i)) for i in p["keepGaps"])
            if p.get("funnelAnchors"):
                p["funnelAnchors"] = [shift(int(i)) for i in p["funnelAnchors"]]
            for sc in p.get("scenes") or ():
                sc["start"], sc["end"] = shift(sc["start"]), shift(sc["end"])
        _rebuild_segments(p, pdir)
        p["scenes"] = pipeline.scenes_from_breaks(p["words"], p["breaks"], existing=p.get("scenes"))
        _fill_gaps(p)
        for sc in p["scenes"]:
            if sc.get("start") == (at + 1 if at is not None else base_words):
                shot = _app_shot(p, _scene_text(p, sc).lower())
                if shot:
                    sc["asset"] = shot
        p.update(appendSrc=None, appendBase=None, appendWordBase=None, appendAfter=None,
                 status="ready", downloaded=False, progress=1.0, rev=p.get("rev", 0) + 1)
        store.save_project(p)
        _ensure_thumbs(p)
        for f in (normb, wavb):
            try:
                os.remove(f)
            except OSError:
                pass
    except Exception as e:
        traceback.print_exc()
        # a failed append must not destroy a finished video. status="error" is for
        # ingest, where there is nothing to lose; here the timeline and any render
        # are still perfectly good, so put it back and report the failure alongside
        try:
            p = store.load_project(pid)
        except Exception:
            pass
        p.pop("appendSrc", None)
        p.pop("appendBase", None)
        p.pop("appendWordBase", None)
        p.pop("appendAfter", None)
        p.update(status="done" if p.get("renders") else "ready",
                 appendError=str(e), progress=1.0)
        store.save_project(p)


@app.post("/api/projects/{pid}/append")
async def append_clip(pid: str, file: UploadFile = File(...), after: int = Form(-1)):
    """Add one more recorded clip as a new scene.

    On the end by default. Pass `after`, a word index, to drop it in mid video
    instead, straight after that word."""
    if store.asset_type(file.filename) != "video":
        raise HTTPException(400, "need a video file")
    p = store.load_project(pid)
    if p.get("status") not in ("ready", "done"):
        raise HTTPException(400, "wait for the current job to finish first")
    if not p.get("words"):
        raise HTTPException(400, "this project has no timeline yet")
    ext = os.path.splitext(file.filename)[1].lower()
    dest_name = f"append_src{ext}"
    dest = os.path.join(store.project_dir(pid), dest_name)
    with open(dest, "wb") as f:
        while True:
            chunk = await file.read(1 << 22)
            if not chunk:
                break
            f.write(chunk)
    p.update(appendSrc=dest_name, appendBase=None, appendWordBase=None,
             appendAfter=(int(after) if int(after) >= 0 else None),
             status="queued", progress=0.0)
    store.save_project(p)
    _work_q.put(("append", pid))
    return p


# ---------------- background cards without a video ----------------
# He edits some of these by hand rather than in here, but the backgrounds are still
# generated: the Hinge swipe screen and the four funnel graphics are drawn from the numbers he
# says. Making them meant creating a throwaway project and ingesting footage just to
# throw the video away. This takes the script text on its own and gives back the same
# images, so an outside edit gets the same backgrounds as one built here.

CARD_EXPORTS = os.path.join(store.DATA, "cardexport")
# An export is a scratch copy: he takes the images and cuts the video somewhere else,
# so keeping them forever just grows a folder per click. A day is long enough that a
# download link still works if he wanders off mid job.
CARD_EXPORT_TTL = 24 * 3600


def _sweep_card_exports():
    """Bin exports older than the TTL. Runs on the way in to a new one rather than on
    a timer, because that is the only moment anything is created."""
    now = time.time()
    for name in os.listdir(CARD_EXPORTS) if os.path.isdir(CARD_EXPORTS) else []:
        d = os.path.join(CARD_EXPORTS, name)
        try:
            if os.path.isdir(d) and now - os.path.getmtime(d) > CARD_EXPORT_TTL:
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass            # a half written export is not worth failing the request


def _inbox_photos(aid, pid_seed):
    """The profile picture the Hinge swipe card is drawn with, same rules as a real video:
    no dating cards (they carry his own face), faces first, shuffled so the list is
    not just library order."""
    a = formats.audience(aid) or {}
    lib = store.load_library()["items"]
    pool = [x for x in lib
            if x.get("collection") == a.get("collection") and x["type"] == "image"
            and x["folder"] not in ("hinge", "extra", "app", "inserts")
            and not x.get("statsCard") and not x.get("collage")]
    import random as _r
    _r.Random(pid_seed).shuffle(pool)
    pool.sort(key=lambda x: 0 if x.get("face") else 1)
    stats.load_faces(lib, store.LIBRARY)
    return ([os.path.join(store.LIBRARY, x["folder"], x["file"]) for x in pool[:14]],
            stats.HANDLES.get(a.get("collection")), a)


@app.post("/api/cards/preview")
async def cards_preview(request: Request):
    """Read the funnel out of a pasted script and draw every background for it.

    Returns the numbers as well as the images on purpose. Reading them back wrong is
    the failure that keeps happening, and it is a lot cheaper to catch here, against
    the script on screen, than after the thing is cut together.
    """
    body = await request.json()
    text = str(body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "paste the script first")
    fun = stats.from_transcript(text)
    if not fun:
        raise HTTPException(
            422, "Could not read the funnel numbers out of that. It needs the total "
                 "right swipes, how many matched, how many replied, how many said yes and how "
                 "many you got.")

    _sweep_card_exports()
    token = uuid.uuid4().hex[:12]
    out = os.path.join(CARD_EXPORTS, token)
    os.makedirs(out, exist_ok=True)

    aid = str(body.get("audience") or "")
    photos, handles, aud = _inbox_photos(aid, token)
    opener = _hinge_opener(text)
    cards = [("hinge swipes", stats.hinge_swipes(
        photos, handles, fun["sent"], opener=opener))] + stats.render_all(fun)

    made = []
    for name, img in cards:
        fn = name.replace(" ", "_") + ".png"
        img.save(os.path.join(out, fn), format="PNG")
        # A separate small copy for the picker. The full cards are 1080x1920 PNGs and
        # the inbox one is over 400KB, which is a lot to pull five of just to choose
        # between them. The zip only takes the .png files, so these never ship.
        thumb = name.replace(" ", "_") + "_thumb.jpg"
        small = img.copy()
        small.thumbnail((270, 480))
        small.convert("RGB").save(os.path.join(out, thumb), format="JPEG", quality=80)
        made.append({"name": name, "file": fn,
                     "url": "files/cardexport/%s/%s" % (token, fn),
                     "thumb": "files/cardexport/%s/%s" % (token, thumb)})
    note = ("" if photos else
            "No photos in the %s library yet, so the Hinge swipe card has no profile "
            "picture." % (aud.get("label") or "chosen"))
    return {"token": token, "funnel": fun, "cards": made, "note": note}


@app.get("/api/cards/{token}/all.zip")
def cards_zip(token: str):
    """Every card for one export in a single download, because he wants the set, not
    five separate clicks."""
    if not re.fullmatch(r"[0-9a-f]{12}", token or ""):
        raise HTTPException(404, "no such export")
    src = os.path.join(CARD_EXPORTS, token)
    if not os.path.isdir(src):
        raise HTTPException(404, "no such export")
    import zipfile
    bundle = os.path.join(src, "all.zip")
    with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as z:
        for fn in sorted(os.listdir(src)):
            if fn.endswith(".png"):
                z.write(os.path.join(src, fn), fn)
    return FileResponse(bundle, media_type="application/zip", filename="backgrounds.zip")


@app.post("/api/projects/{pid}/cards")
def rebuild_cards(pid: str):
    """Redraw the Hinge swipe screen and funnel cards from the library as it is NOW.

    They are drawn once, during the first ingest, from whatever photos existed at
    that moment. Add pictures to an audience afterwards and the video keeps the
    empty swipe card it was born with. Nothing re-ran this, and /reprocess is not it:
    that rebuilds the matte, which is slow and leaves the cards untouched.

    Cheap enough to be synchronous, because it only reads the transcript that is
    already there and redraws images; no video is touched.
    """
    p = store.load_project(pid)
    if p.get("status") in ("processing", "queued"):
        raise HTTPException(409, "busy")
    # The correction dictionary grows as real uploads expose new Whisper mistakes.
    # Apply it here too, so rebuilding an older edit fixes its captions without a
    # full transcription or matte pass. Corrections never change word indices.
    campaign_name = ((p.get("campaign") or {}).get("name") or "")
    formats.fix_heard(p.get("words") or [], app=p.get("app") or campaign_name)
    # clear it first, so a rebuild that works does not leave the old complaint behind
    p.pop("warning", None)
    _read_funnel(p)
    # _funnel_scenes has to run: it is what keeps one funnel step on one scene, so a
    # figure and the clause that finishes it do not end up on two shots with two
    # different charts. It does re-derive the splits from the funnel, which is the
    # point of it, so a rebuild is the moment the grouping gets put back.
    _funnel_scenes(p)
    # Funnel regrouping can remove a pause break from the method section. Put the
    # model, swap and app beats back before assigning their matching images.
    _cta_scenes(p)
    _apply_stats_cards(p)
    _bump(p)
    store.save_project(p)
    return p


@app.post("/api/projects/{pid}/reprocess")
def reprocess(pid: str):
    p = store.load_project(pid)
    if p.get("status") in ("processing", "queued"):
        return {"started": False}
    p.update(status="queued", progress=0.0)
    store.save_project(p)
    _work_q.put(("upgrade", pid))
    return {"started": True}


@app.get("/api/projects/{pid}/person_sprite/{sidx}")
def person_sprite(pid: str, sidx: int):
    """Transparent PNG of Logan's cutout at a scene's start, for the draggable preview."""
    p = store.load_project(pid)
    if p.get("status") not in ("ready", "rendering", "done") or sidx >= len(p["scenes"]):
        raise HTTPException(409, "not ready")
    pdir = store.project_dir(pid)
    start = p["scenes"][sidx]["start"]
    cache = os.path.join(pdir, "thumbs", f"person_w{start}.png")
    if not os.path.exists(cache):
        from PIL import Image
        from .matte import split_pack
        widx = min(start, len(p["words"]) - 1)
        t = p["words"][widx]["s"] + 0.15
        if p.get("matte"):
            frame = grab_frame(os.path.join(pdir, p["matte"]), t)
            rgba = split_pack(frame)
        else:
            from . import cutout
            frame = grab_frame(os.path.join(pdir, p.get("normalized") or p["source"]), t)
            rgba = cutout.person_rgba(frame)
        img = Image.fromarray(rgba)
        img.thumbnail((540, 960))
        img.save(cache)
    return FileResponse(cache, media_type="image/png")


@app.post("/api/projects/{pid}/render")
def start_render(pid: str):
    p = store.load_project(pid)
    if p.get("status") == "rendering":
        t = _jobs.get(pid + ":render")
        if t and t.is_alive():
            return p
        # status says rendering but nothing is running: fall through and restart it
    # the source media of an archived project has been cleared to reclaim disk, so
    # there is nothing left to render from. Saying so beats failing halfway through
    # with an ffmpeg error about a missing file.
    if p.get("archived"):
        raise HTTPException(400, "This one was archived to free up space, so its "
                                 "footage is gone. The finished video is still here "
                                 "to download.")
    # an id that no longer resolves is as missing as no id at all, and renders as
    # the grey placeholder; checking truthiness alone let that through silently
    missing = [i for i, s in enumerate(p["scenes"])
               if not s.get("hideHead") and not store.get_asset(s.get("asset") or "")]
    t = threading.Thread(target=_render_job, args=(pid,), daemon=True)
    _jobs[pid + ":render"] = t
    t.start()
    return {"started": True, "scenesWithoutBackground": missing}


@app.get("/api/projects/{pid}/download")
def download(pid: str, i: int = -1):
    p = store.load_project(pid)
    renders = p.get("renders", [])
    if not renders:
        raise HTTPException(404, "no renders yet")
    r = renders[i if 0 <= i < len(renders) else -1]
    path = os.path.join(store.project_dir(pid), r["file"])
    nice = store.safe_name(p["name"]) + f"_{(i if i >= 0 else len(renders)) }.mp4"
    _patch(pid, downloaded=True)
    return FileResponse(path, media_type="video/mp4", filename=nice)


# ---------------- library ----------------
@app.post("/api/library")
async def upload_asset(file: UploadFile = File(...), folder: str = Form("misc"),
                       name: str = Form(""), collection: str = Form(""),
                       campaign: str = Form(""), kind: str = Form("")):
    content = await file.read()
    # collection ties an image to an audience, campaign ties an asset (app
    # screenshots and the like) to one deal
    meta = {}
    if collection.strip():
        meta["collection"] = collection.strip()
    if campaign.strip():
        meta["campaign"] = campaign.strip()
    # the shot type within a collection ("travel", "night out"), because the
    # scripts call for specific photos rather than any photo
    if kind.strip():
        meta["kind"] = kind.strip()
    meta = meta or None
    try:
        item = store.add_library_file(folder, file.filename, content=content,
                                      name=name or None, meta=meta)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return item


@app.post("/api/library/{aid}/kind")
def set_asset_kind(aid: str, body: dict):
    """Tag an image with its shot type, or clear it with an empty string."""
    lib = store.load_library()
    item = next((a for a in lib["items"] if a["id"] == aid), None)
    if not item:
        raise HTTPException(404, "no such asset")
    item["kind"] = str(body.get("kind") or "")[:60]
    store.save_library(lib)
    return item


@app.post("/api/library/{aid}/campaign")
def set_asset_campaign(aid: str, body: dict):
    """Tag an asset to a campaign, or clear it with an empty string."""
    lib = store.load_library()
    item = next((a for a in lib["items"] if a["id"] == aid), None)
    if not item:
        raise HTTPException(404, "no such asset")
    item["campaign"] = str(body.get("campaign") or "")[:60]
    store.save_library(lib)
    return item


@app.post("/api/library/{aid}/collection")
def set_asset_collection(aid: str, body: dict):
    lib = store.load_library()
    for item in lib["items"]:
        if item["id"] == aid:
            c = str(body.get("collection") or "").strip()
            if c:
                item["collection"] = c
            else:
                item.pop("collection", None)
            store.save_library(lib)
            return item
    raise HTTPException(404, "no such asset")


@app.delete("/api/library/{aid}")
def remove_asset(aid: str):
    store.delete_asset(aid)
    return {"ok": True}


# ---------------- dating card generator ----------------
async def _incoming_photo(photo, photoAsset, folder, label):
    """Uploaded file (saved into the library for reuse) or an existing asset id.
    Returns (path, asset_id) so cards can record their recipe."""
    if photo is not None and photo.filename:
        tmp = os.path.join(store.LIBRARY, folder, f"tmp_{store.safe_name(photo.filename)}")
        with open(tmp, "wb") as f:
            f.write(await photo.read())
        item = store.add_library_file(folder, photo.filename, src_path=tmp, name=label)
        os.remove(tmp)
        return os.path.join(store.LIBRARY, folder, item["file"]), item["id"]
    if photoAsset:
        a = store.resolve_asset(photoAsset)
        if not a or a["type"] != "image":
            raise HTTPException(400, "asset must be an image in the library")
        return a["path"], photoAsset
    return None, None


def _render_card(recipe):
    """Render any card kind from a recipe dict (photo fields are asset ids)."""
    pa = store.resolve_asset(recipe.get("photoAsset") or "")
    if not pa or pa["type"] != "image":
        raise HTTPException(400, "the card's photo is no longer in the library")
    photo_path = pa["path"]
    kind = recipe.get("kind", "profile")
    age = recipe.get("age")
    age_val = int(age) if str(age or "").strip().isdigit() else None
    if kind == "like":
        top_path = None
        ta = store.resolve_asset(recipe.get("topPhotoAsset") or "")
        if ta and ta["type"] == "image":
            top_path = ta["path"]
        return cards.like_card(photo_path, recipe["name"], message=recipe.get("message", ""),
                               top_photo_path=top_path, pronouns=recipe.get("pronouns", ""),
                               prompt_q=recipe.get("promptLabel", ""),
                               prompt_a=recipe.get("promptAnswer", ""),
                               cover_face=bool(recipe.get("coverFace")))
    if kind == "match":
        return cards.match_card(photo_path, recipe["name"])
    return cards.profile_card(photo_path, recipe["name"], age_val,
                              recipe.get("promptLabel", ""), recipe.get("promptAnswer", ""))


@app.post("/api/card")
async def make_card(kind: str = Form("profile"), name: str = Form(...), age: str = Form(""),
                     promptLabel: str = Form("The way to win me over is"),
                     promptAnswer: str = Form("good banter and better food"),
                     message: str = Form("majestic ahhh"),
                     pronouns: str = Form("she/her/hers"),
                     coverFace: str = Form("0"), collection: str = Form(""),
                     photoAsset: str = Form(""), photo: UploadFile = File(None),
                     topPhotoAsset: str = Form(""), topPhoto: UploadFile = File(None)):
    photo_path, photo_aid = await _incoming_photo(photo, photoAsset, "people", name)
    if not photo_path:
        raise HTTPException(400, "need a photo upload or a photoAsset id")
    top_aid = None
    if kind == "like":
        _top_path, top_aid = await _incoming_photo(topPhoto, topPhotoAsset, "app", "my liked photo")

    # the recipe makes the card remakeable in place after any style update
    recipe = {"kind": kind, "name": name, "age": age,
              "promptLabel": promptLabel, "promptAnswer": promptAnswer,
              "message": message, "pronouns": pronouns,
              "coverFace": coverFace not in ("0", "false", ""),
              "photoAsset": photo_aid, "topPhotoAsset": top_aid}
    img = _render_card(recipe)
    age_val = int(age) if str(age).strip().isdigit() else None
    label = {"like": f"like {name}", "match": f"match {name}"}.get(kind) or \
        f"{name}{', ' + str(age_val) if age_val else ''}"
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    meta = {"recipe": recipe}
    if collection.strip():
        meta["collection"] = collection.strip()
    item = store.add_library_file("hinge", f"{store.safe_name(name)}_{kind}.png",
                                  content=buf.getvalue(), name=label, meta=meta)
    return item


@app.post("/api/library/{aid}/remake")
def remake_card(aid: str):
    """Re-render a hinge card in place with the current style. Same id and file, so
    every scene using it updates automatically."""
    item = store.get_asset(aid)
    if not item or item["folder"] != "hinge" or not item.get("recipe"):
        raise HTTPException(400, "this card has no saved recipe (made before recipes existed), remake it via the dating card form")
    img = _render_card(item["recipe"])
    path = os.path.join(store.LIBRARY, item["folder"], item["file"])
    img.save(path, format="PNG")
    if item.get("thumb"):
        store.make_thumb(path, os.path.join(store.LIBRARY, item["folder"], item["thumb"]), "image")
    return item


# ---------------- templates ----------------
@app.post("/api/formats")
def save_format(body: dict):
    return formats.upsert(body)


@app.delete("/api/formats/{fid}")
def remove_format(fid: str):
    formats.delete(fid)
    return {"ok": True}


@app.post("/api/templates")
def create_template(body: dict):
    name = body.get("name") or "untitled"
    pid = body.get("fromProject")
    slots = body.get("slots")
    if pid and not slots:
        p = store.load_project(pid)
        slots = []
        for i, s in enumerate(p["scenes"]):
            asset = store.get_asset(s.get("asset")) if s.get("asset") else None
            # hinge cards are fresh every video, so they never stick to the template
            sticky = bool(asset) and asset["folder"] != "hinge"
            # head placement is deliberately NOT saved: it alternates automatically
            # per scene (pipeline.PLACEMENTS), and baking it into a template would
            # pin every video to one arrangement
            slots.append({"label": s.get("label") or f"Scene {i + 1}",
                          "asset": s.get("asset") if sticky else None,
                          "hideHead": s.get("hideHead", False),
                          "sticky": sticky,
                          # the overlay (app store shot) recurs every video, trigger word
                          # travels as text and re-resolves in the new video's transcript
                          "overlayAsset": s.get("overlayAsset"),
                          "overlayWord": s.get("overlayWord", ""),
                          "overlayDuration": s.get("overlayDuration", 1.5),
                          "overlayScale": s.get("overlayScale", 0.62),
                          "overlayX": s.get("overlayX", 0.0),
                          "overlayY": s.get("overlayY", 0.42)})
    return store.add_template(name, slots or [])


@app.delete("/api/templates/{tid}")
def remove_template(tid: str):
    store.delete_template(tid)
    return {"ok": True}


@app.post("/api/projects/{pid}/apply_template")
def apply_template(pid: str, body: dict):
    p = store.load_project(pid)
    tpl = next((t for t in store.load_templates()["templates"] if t["id"] == body.get("template")), None)
    if not tpl:
        raise HTTPException(404, "no such template")
    for i, sc in enumerate(p["scenes"]):
        if i >= len(tpl["slots"]):
            break
        slot = tpl["slots"][i]
        sc["label"] = slot.get("label", "")
        # headScale/headX/headY are intentionally left alone so the automatic
        # per-scene alternation survives applying a template
        for k in ("hideHead", "overlayWord", "overlayDuration",
                  "overlayScale", "overlayX", "overlayY"):
            sc[k] = slot.get(k, sc.get(k))
        # only carry an image over if it is still in the library. A template can
        # outlive the photos it captured, and writing a dead id here silently
        # replaced a good background with the grey "no background yet" placeholder
        if slot.get("sticky") and store.get_asset(slot.get("asset") or ""):
            sc["asset"] = slot["asset"]
        if store.get_asset(slot.get("overlayAsset") or ""):
            sc["overlayAsset"] = slot["overlayAsset"]
    _bump(p)
    store.save_project(p)
    return p

"""Transcription + dead-space cutting + timeline math.

Words are [{"w","s","e"}] in source time and never change after ingest. Cutting works in
two layers on top of them:
- cutWords: word indices removed from the video entirely (auto-detected retakes and
  filler sounds, plus anything Logan cuts by hand). Their audio time is removed too.
- speech groups: runs of kept words with gaps under gap_cut; silence between groups is
  removed, and each group's boundaries get snapped to actual audio energy because
  whisper word timings are generous.

The cut list ("segments") is [[S, E, first_word, last_word], ...] in source time, with
first/last referencing kept words. Groups longer than max_seg get punch-cut (no time
removed, just a zoom alternation point).
"""
import json

import numpy as np

from .media import read_wav

_model = None

FILLERS = {"um", "uh", "uhm", "umm", "uhh", "erm", "hmm", "mmm", "mm", "ehm"}


# nudges whisper into verbatim mode: without this it silently cleans up ums, stutters
# and repeats, which makes them impossible to click and cut in the transcript
VERBATIM_PROMPT = ("Umm, so like, uh, I was like, you know, um, basically, uh, yeah, "
                   "like literally, so so, I I, it's like, erm, hmm.")


def transcribe(wav_path, app=""):
    """Word-level timestamps via faster-whisper medium int8, verbatim-biased.

    The prompt also carries his own vocabulary. Without it whisper reaches for the
    nearest ordinary word, and "furries" kept coming back as "fairies", which then
    went into the captions on screen."""
    from . import formats
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        _model = WhisperModel("medium", device="cpu", compute_type="int8")
    vocab = ", ".join(formats.vocabulary())
    prompt = f"{VERBATIM_PROMPT} Words used: {vocab}." if vocab else VERBATIM_PROMPT
    segments, info = _model.transcribe(wav_path, word_timestamps=True, language="en",
                                       initial_prompt=prompt,
                                       condition_on_previous_text=False)
    words = []
    for seg in segments:
        for w in seg.words or []:
            token = w.word.strip()
            if token:
                words.append({"w": token, "s": round(w.start, 3), "e": round(w.end, 3)})
    # belt and braces: the prompt biases it, this catches what still slips through
    formats.fix_heard(words, app=app)
    return words, float(info.duration)


def _norm(token):
    return token.lower().strip(".,?!;:'\"")


def detect_auto_cuts(words):
    """Find retakes (a phrase said twice, cut the first attempt, keep the later take)
    and filler sounds. Returns (cut_index_set, info)."""
    n = len(words)
    toks = [_norm(w["w"]) for w in words]
    cut = set()
    retakes = []
    i = 0
    while i < n:
        found = None
        for L in range(min(8, n - i), 1, -1):
            a = toks[i:i + L]
            for g in range(0, 5 if L >= 3 else 1):
                k = i + L + g
                if k + L > n:
                    continue
                b = toks[k:k + L]
                need = L if L <= 3 else max(3, int(L * 0.8))
                # a restart repeats its opening word, so anchor on the first token
                if a[0] == b[0] and sum(x == y for x, y in zip(a, b)) >= need:
                    found = (i, k)
                    break
            if found:
                break
        if found:
            s, k = found
            cut.update(range(s, k))
            retakes.append([s, k - 1])
            i = k
        else:
            i += 1
    fillers = [j for j, t in enumerate(toks) if t in FILLERS]
    cut.update(fillers)
    return cut, {"retakes": retakes, "fillers": fillers}


class RmsEnvelope:
    """100 Hz smoothed RMS of the voice track, used to snap cut points to real speech."""

    RATE = 100

    def __init__(self, values):
        self.v = np.asarray(values, dtype=np.float32)
        floor = float(np.percentile(self.v, 15))
        speech = float(np.percentile(self.v, 85))
        self.thresh = floor + 0.10 * (speech - floor)

    @classmethod
    def from_wav(cls, wav_path):
        rate, data = read_wav(wav_path)
        x = data.astype(np.float32) / 32768.0
        hop = max(1, rate // cls.RATE)
        n = len(x) // hop
        if n == 0:
            return cls(np.zeros(1))
        rms = np.sqrt((x[:n * hop].reshape(n, hop) ** 2).mean(axis=1))
        return cls(np.convolve(rms, np.ones(3) / 3, mode="same"))

    def save(self, path):
        json.dump([round(float(v), 5) for v in self.v], open(path, "w"))

    @classmethod
    def load(cls, path):
        return cls(json.load(open(path)))

    def _idx(self, t):
        return int(max(0, min(len(self.v) - 1, round(t * self.RATE))))

    def first_active(self, t0, t1):
        i, j = self._idx(t0), self._idx(t1)
        while i < j and self.v[i] < self.thresh:
            i += 1
        return i / self.RATE if i < j else None

    def last_active(self, t0, t1):
        i, j = self._idx(t0), self._idx(t1)
        while j > i and self.v[j] < self.thresh:
            j -= 1
        return j / self.RATE if j > i else None

    def snap(self, S, E, is_last=False):
        """Tighten [S,E] to where the audio actually has speech, with small pads."""
        s_act = self.first_active(S, E)
        e_act = self.last_active(S, E)
        if s_act is not None:
            S = min(max(S, s_act - 0.12), E - 0.1)
        if e_act is not None:
            E = max(min(E, e_act + (0.25 if is_last else 0.14)), S + 0.1)
        return S, E


def build_segments(words, duration, gap_cut=0.2, cut=None, rms=None,
                   pad_in=0.08, pad_out=0.12, lead=0.12, tail=0.35, max_seg=5.5,
                   keep_gaps=None):
    """Return (segments, groups) over kept (non-cut) words. A new group starts on a
    time gap over gap_cut OR wherever cut words were removed (their time goes too).

    `keep_gaps` is word indices that must never start a new group, for the odd line
    he wants to run straight on with no cut at all even though he paused."""
    cut = set(cut or [])
    keep_gaps = set(keep_gaps or [])
    kept = [i for i in range(len(words)) if i not in cut]
    if not kept:
        return [], []
    groups = [[kept[0]]]
    for prev, i in zip(kept, kept[1:]):
        gap = words[i]["s"] - words[prev]["e"]
        # A jump BACKWARDS ends a group just as surely as a long pause does. It means
        # the next word lives somewhere else in the file, which is what a clip
        # inserted mid video looks like: the words either side of it point back to
        # where the original take resumes. Without this the resumed line was folded
        # into the insert's own group and collapsed to a 0.15s stub, quietly dropping
        # the rest of the sentence. The tolerance is for whisper's own slight overlaps.
        if i not in keep_gaps and (i != prev + 1 or gap > gap_cut or gap < -0.05):
            groups.append([])
        groups[-1].append(i)

    segs = []
    for gi, g in enumerate(groups):
        first, last = g[0], g[-1]
        S = words[first]["s"] - (lead + pad_in if gi == 0 else pad_in)
        E = words[last]["e"] + (tail if gi == len(groups) - 1 else pad_out)
        S = max(0.0, S)
        # Clamp against the adjacent SOURCE word, not the adjacent KEPT one. When a
        # word has been deleted, the next kept word is on the far side of it, so the
        # padding used to reach straight through the deleted word and keep a piece of
        # it: you heard a syllable of the word he cut, at full volume, glued to the
        # front of the next line. Where nothing was deleted these pick the same value
        # as before, so ordinary pause cuts are unchanged.
        # ...and only when that neighbour really is the adjacent audio. A clip dropped
        # into the middle of the video sits next to its neighbours by index while
        # living seconds away in the file, and clamping against it there just ate the
        # lead-in of the line that follows the insert.
        near = lambda a, b: abs(a - b) < 1.0
        if gi > 0 and near(words[first]["s"], words[first - 1]["e"]):
            S = max(S, min(words[first]["s"], words[first - 1]["e"] + 0.05))
        if last + 1 < len(words) and near(words[last + 1]["s"], words[last]["e"]):
            E = min(E, max(words[last]["e"], words[last + 1]["s"] - 0.05))
        E = min(E, duration)
        if E - S < 0.15:
            E = min(duration, S + 0.15)
        if rms is not None:
            S, E = rms.snap(S, E, is_last=(gi == len(groups) - 1))
        segs.append([round(S, 3), round(E, 3), first, last, g])

    def split_long(S, E, g):
        if E - S <= max_seg or len(g) < 2:
            return [[S, E, g[0], g[-1]]]
        mid = S + (E - S) / 2
        best_pos, bd = None, 1e9
        for pos in range(1, len(g)):
            d = abs(words[g[pos]]["s"] - mid)
            if d < bd:
                best_pos, bd = pos, d
        cut_t = words[g[best_pos]]["s"] - 0.03
        if cut_t <= S or cut_t >= E:
            return [[S, E, g[0], g[-1]]]
        return split_long(S, cut_t, g[:best_pos]) + split_long(cut_t, E, g[best_pos:])

    final = []
    for S, E, first, last, g in segs:
        final.extend(split_long(S, E, g))
    return final, groups


class Timeline:
    """Maps output time <-> source time over a cut list."""

    def __init__(self, segments):
        self.segments = segments
        self.offsets = []
        self.word_segments = {}
        acc = 0.0
        for seg_idx, (S, E, fw, lw) in enumerate(segments):
            self.offsets.append(acc)
            for word_idx in range(fw, lw + 1):
                self.word_segments[word_idx] = seg_idx
            acc += E - S
        self.out_dur = acc

    def to_out(self, src_t, seg_idx=None):
        if seg_idx is not None:
            S, E, _fw, _lw = self.segments[seg_idx]
            return self.offsets[seg_idx] + min(E - S, max(0.0, src_t - S))
        for (S, E, fw, lw), off in zip(self.segments, self.offsets):
            if src_t <= E + 1e-6:
                return off + max(0.0, src_t - S)
        return self.out_dur

    def word_to_out(self, word_idx, src_t):
        """Map a word timestamp through the segment that owns that word.

        Inserted clips live at the end of the source file but can appear in the
        middle of the output. Source time alone is ambiguous once those segments
        overlap their resumed neighbours, so the word index supplies the missing
        segment context.
        """
        seg_idx = self.word_segments.get(word_idx)
        return self.to_out(src_t, seg_idx) if seg_idx is not None else self.to_out(src_t)

    def seg_at_out(self, t_out):
        j = 0
        while j < len(self.segments) - 1 and \
                t_out > self.offsets[j] + (self.segments[j][1] - self.segments[j][0]) + 1e-9:
            j += 1
        return j

    def to_src(self, t_out):
        j = self.seg_at_out(t_out)
        S, E, fw, lw = self.segments[j]
        return min(E, S + (t_out - self.offsets[j])), j


def default_breaks(words, groups):
    """Propose a scene break at the start of every speech group."""
    return sorted({g[0] for g in groups} | ({0} if words else set()))


# Default cutout placement, cycled per scene. Small and cornered: there is a photo
# behind him in every scene and it is the thing the line is about, so he sits to one
# side of it rather than over the middle of it. Alternates left and right so
# consecutive scenes are not identical, with a little size variation.
#   scale is a fraction of frame width, dx is the offset of his centre from the
#   middle, so +-0.24 at 0.52 wide puts his edge almost exactly on the frame edge.
PLACEMENTS = [(0.52, -0.24), (0.52, 0.24), (0.50, -0.25), (0.54, 0.23),
              (0.50, -0.23), (0.52, 0.25)]
# what the placements used to be, so an untouched scene can be brought up to date
# without overwriting anything Logan placed by hand
LEGACY_PLACEMENTS = [(0.80, 0.06), (0.76, -0.08), (0.84, 0.02),
                     (0.78, -0.06), (0.82, 0.09), (0.75, -0.03)]

# The hook scene of a photo grid format is laid out differently: he sits dead centre
# over the middle of the grid with the title above his head, not off to one side.
# Taken from the three he placed by hand, which all landed within a few percent.
GRID_HOOK_PLACEMENT = (0.50, 0.0, -0.32)   # scale, x, y
GRID_HOOK_TEXT = {"y": 0.21, "size": 80}

# Matches-first hooks: a larger, bottom-right cutout and a prominent title.
# Shift the enlarged face right, leaving the inbox avatar column visible.
MATCH_HOOK_PLACEMENT = (0.78, 0.20, 0.0)
MATCH_HOOK_TEXT = {"y": 0.22, "size": 92, "autoFit": True}


def scenes_from_breaks(words, breaks, existing=None):
    """Build scene objects from break word-indices, carrying over settings of scenes
    whose start word survived the edit."""
    existing = {s["start"]: s for s in (existing or [])}
    breaks = sorted(set(int(b) for b in breaks if 0 <= int(b) < len(words)) | ({0} if words else set()))
    scenes = []
    for i, b in enumerate(breaks):
        end = (breaks[i + 1] - 1) if i + 1 < len(breaks) else len(words) - 1
        prev = existing.get(b)
        scale, dx = PLACEMENTS[i % len(PLACEMENTS)]
        scene = {
            "start": b,
            "end": end,
            "asset": None,
            "hideHead": False,
            "headScale": scale,
            "headX": dx,
            "headY": 0.0,
            "label": "",
            "overlayAsset": None,
            "overlayWord": "",
            "overlayDuration": 1.5,
            "overlayScale": 0.62,
            "overlayX": 0.0,
            "overlayY": 0.42,
        }
        if prev:
            for k in ("asset", "hideHead", "headScale", "headX", "headY", "label",
                      "overlayAsset", "overlayWord", "overlayDuration",
                      "overlayScale", "overlayX", "overlayY"):
                scene[k] = prev.get(k, scene[k])
        scenes.append(scene)
    return scenes


def load_words(path):
    return json.load(open(path))


def save_words(path, words):
    json.dump(words, open(path, "w"))
